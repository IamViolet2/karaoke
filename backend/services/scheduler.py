"""
예약 자동 운영 엔진

운영 모드:
- production: 실제 운영 (점심 50분 / 저녁 60분)
- demo: 발표 시연 (점심 3분 / 저녁 3분)

주요 기능:
- 실제 PIN 인증 시각(started_at)을 기준으로 이용시간 계산
- 종료 전 LED 및 안내 음성
- 이용 종료 시 퇴실곡 재생 및 전원·도어락 차단
- 관리자 수동 이용 종료 처리
- 예약 날짜와 관계없이 현재 이용 중인 예약 관리

체험권 대기열 및 노쇼 자동 취소 기능은 사용하지 않는다.
"""

import asyncio
import logging
import os
from datetime import datetime, time as dtime, timedelta
from typing import Any, Dict, List, Optional

from db import database as db
from services.booth_service import BoothService
from websocket_manager import ws_manager
from booth_time import now_local, tz_name


logger = logging.getLogger("backend.services.scheduler")


# ── 환경변수 공통 함수 ────────────────────────────────────────────────────

def _int_env(name: str, default: int) -> int:
    try:
        return max(1, int(os.getenv(name, str(default))))
    except (TypeError, ValueError):
        return default


# ── 운영 모드 ─────────────────────────────────────────────────────────────

MODE = os.getenv(
    "SCHEDULER_MODE",
    "production",
).strip().lower()

if MODE not in ("production", "demo"):
    logger.warning(
        "잘못된 SCHEDULER_MODE=%s. production 모드로 실행합니다.",
        MODE,
    )
    MODE = "production"


# ── 타임슬롯별 이용시간 ────────────────────────────────────────────────────

PRODUCTION_DURATIONS = {
    "lunch": 50 * 60,
    "dinner": 60 * 60,
}

DEMO_DURATIONS = {
    "lunch": 3 * 60,
    "dinner": 3 * 60,
}

DURATIONS = (
    DEMO_DURATIONS
    if MODE == "demo"
    else PRODUCTION_DURATIONS
)


# ── 프론트엔드 예약 시간대 ─────────────────────────────────────────────────

SLOT_WINDOWS: Dict[str, tuple] = {
    "lunch": (dtime(12, 30), dtime(13, 20)),
    "dinner": (dtime(17, 30), dtime(18, 30)),
}


# ── 실행 간격 및 종료 전 알림 ──────────────────────────────────────────────

DEFAULT_INTERVAL = 1 if MODE == "demo" else 60

INTERVAL_SEC = _int_env(
    "SCHEDULER_INTERVAL_SEC",
    DEFAULT_INTERVAL,
)

if MODE == "demo":
    WARN_BEFORE_SEC = _int_env(
        "SCHEDULER_DEMO_WARN_BEFORE_SEC",
        30,
    )
else:
    WARN_BEFORE_SEC = (
        _int_env(
            "SCHEDULER_WARN_BEFORE_MIN",
            10,
        ) * 60
    )

ENABLED = (
    os.getenv(
        "SCHEDULER_ENABLED",
        "true",
    ).strip().lower()
    != "false"
)

WARN_WINDOW_SEC = max(
    2,
    INTERVAL_SEC * 2,
)


# ── 실행 상태 ─────────────────────────────────────────────────────────────

_state: Dict[str, Any] = {
    "last_tick": None,
    "last_error": None,
    "actions": [],
    "warned_ids": set(),
    "ending_ids": set(),
}


# ── 공통 함수 ─────────────────────────────────────────────────────────────

def _remember(
    action: str,
    reservation: Dict[str, Any],
    message: str,
) -> Dict[str, Any]:

    entry = {
        "action": action,
        "reservation_id": reservation.get("id"),
        "student_name": reservation.get("student_name"),
        "time_slot": reservation.get("time_slot"),
        "message": message,
        "at": now_local().isoformat(timespec="seconds"),
    }

    _state["actions"] = (
        [entry] + _state["actions"]
    )[:20]

    logger.info(
        "[scheduler] %s: %s",
        action,
        message,
    )

    return entry


def _duration_seconds(
    time_slot: str,
) -> Optional[int]:
    """운영 모드에 따른 이용시간을 초 단위로 반환한다."""

    return DURATIONS.get(time_slot)


def _parse_started_at(
    value: Any,
) -> Optional[datetime]:
    """
    DB에 저장된 실제 입장 시각을 한국 시간 기준으로 변환한다.

    started_at이 없는 예약은 임의의 예약 시간으로 대체하지 않는다.
    """

    if not value:
        return None

    try:
        if isinstance(value, datetime):
            parsed = value
        else:
            text = str(value).strip()

            if text.endswith("Z"):
                text = text[:-1] + "+00:00"

            parsed = datetime.fromisoformat(text)

        if parsed.tzinfo is None:
            parsed = parsed.replace(
                tzinfo=now_local().tzinfo
            )

        return parsed.astimezone(
            now_local().tzinfo
        )

    except (TypeError, ValueError):
        logger.warning(
            "잘못된 started_at 값: %s",
            value,
        )
        return None


def _get_active_reservations() -> List[Dict[str, Any]]:
    """
    날짜와 관계없이 현재 이용 중인 예약을 조회한다.

    database.py에 get_active_reservations()가 있으면
    해당 함수를 우선 사용한다.
    """

    if hasattr(db, "get_active_reservations"):
        return db.get_active_reservations()

    reservations = db.get_reservations(
        limit=1000
    )

    return [
        reservation
        for reservation in reservations
        if str(
            reservation.get("status") or ""
        ) == "active"
    ]


def _reservation_end(
    reservation: Dict[str, Any],
) -> Optional[datetime]:
    """실제 입장 시각 + 운영 모드별 이용시간을 계산한다."""

    started_at = _parse_started_at(
        reservation.get("started_at")
    )

    if not started_at:
        return None

    duration = _duration_seconds(
        str(
            reservation.get("time_slot") or ""
        )
    )

    if duration is None:
        return None

    return started_at + timedelta(
        seconds=duration
    )


def slot_bounds(
    day: datetime,
    time_slot: str,
) -> Optional[tuple]:
    """예약 날짜의 예정된 시간대 시작·종료 시각을 반환한다."""

    window = SLOT_WINDOWS.get(time_slot)

    if not window:
        return None

    start = datetime.combine(
        day.date(),
        window[0],
        tzinfo=day.tzinfo,
    )

    end = datetime.combine(
        day.date(),
        window[1],
        tzinfo=day.tzinfo,
    )

    return start, end


def entry_window(
    reservation: Dict[str, Any],
    tzinfo=None,
) -> Optional[tuple]:
    """
    기존 코드와의 호환을 위해 유지하는 함수.

    현재 PIN 인증에서는 예약 시간 제한을 적용하지 않는다.
    """

    day_text = str(
        reservation.get("reservation_date") or ""
    )[:10]

    try:
        day = datetime.strptime(
            day_text,
            "%Y-%m-%d",
        ).replace(
            tzinfo=tzinfo or now_local().tzinfo
        )

    except (TypeError, ValueError):
        return None

    return slot_bounds(
        day,
        str(
            reservation.get("time_slot") or ""
        ),
    )


# ── 예약 이용 상태 ────────────────────────────────────────────────────────

def reservation_in_progress(
    now: Optional[datetime] = None,
) -> Optional[Dict[str, Any]]:
    """
    현재 실제로 이용 중인 예약을 반환한다.

    예약 예정 시간과 관계없이 실제 입장한 예약만 확인한다.
    """

    current_time = now or now_local()

    try:
        reservations = _get_active_reservations()

        for reservation in reservations:
            end = _reservation_end(reservation)

            if end and end > current_time:
                return reservation

    except Exception as exc:
        logger.warning(
            "이용 중인 예약 조회 실패: %s",
            exc,
        )

    return None


def finish_active_reservations() -> int:
    """
    관리자 수동 이용 종료 후 활성 예약을 완료 처리한다.

    실제 장치 종료 동작은 호출한 관리자 API에서 처리한다.

    기존 API와의 호환성을 위해 완료 처리된 예약 개수를 반환한다.
    """

    finished = 0

    try:
        reservations = _get_active_reservations()

        for reservation in reservations:
            rid = reservation.get("id")

            if rid is None:
                logger.warning(
                    "예약 ID가 없어 완료 처리할 수 없습니다: %s",
                    reservation,
                )
                continue

            try:
                updated = db.update_reservation_status(
                    rid,
                    "completed",
                )

                if not updated:
                    logger.warning(
                        "예약 %s의 완료 상태 변경에 실패했습니다.",
                        rid,
                    )
                    continue

                _state["warned_ids"].discard(rid)
                _state["ending_ids"].discard(rid)

                _remember(
                    "session_end",
                    reservation,
                    "관리자가 이용을 종료해 예약을 완료 처리했습니다.",
                )

                finished += 1

            except Exception as exc:
                logger.error(
                    "예약 %s 완료 처리 실패: %s",
                    rid,
                    exc,
                )

    except Exception as exc:
        logger.warning(
            "이용 중인 예약 조회 실패: %s",
            exc,
        )

    return finished


# ── 현재 이용 세션 ────────────────────────────────────────────────────────

def current_session(
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """
    현재 부스를 이용 중인 사람과 종료 시각을 반환한다.

    PIN이나 민감한 인증 정보는 화면에 전달하지 않는다.
    """

    current_time = now or now_local()

    try:
        reservations = _get_active_reservations()

        for reservation in reservations:
            end = _reservation_end(reservation)

            if not end or end <= current_time:
                continue

            name = str(
                reservation.get("student_name") or "학생"
            )

            return {
                "kind": "reservation",
                "user_name": name,
                "nickname": name,
                "ends_at": end.isoformat(
                    timespec="seconds"
                ),
                "remaining_sec": max(
                    0,
                    int(
                        (end - current_time).total_seconds()
                    ),
                ),
            }

    except Exception as exc:
        logger.warning(
            "현재 이용 세션 조회 실패: %s",
            exc,
        )

    return {
        "kind": None,
    }


# ── 종료 처리 ─────────────────────────────────────────────────────────────

async def _finish_reservation(
    reservation: Dict[str, Any],
) -> bool:
    """
    장치 종료와 예약 완료 처리를 수행한다.

    처리 순서:
    1. 장치 종료 명령 실행
    2. 장치 종료 성공 여부 확인
    3. 모든 장치 종료 성공 시 DB 예약 완료 처리

    실패 시 예약 상태를 active로 유지하여 다음 주기에 재시도한다.
    """

    rid = reservation.get("id")

    if rid is None:
        logger.error(
            "예약 ID가 없어 자동 종료할 수 없습니다: %s",
            reservation,
        )
        return False

    # 같은 실행 루프에서 중복 종료 명령 방지
    if rid in _state["ending_ids"]:
        return False

    _state["ending_ids"].add(rid)

    try:
        # 1. 장치 종료
        result = await BoothService.trigger_session_end()

        # 2. 장치 종료 결과 확인
        if not result or result.get("success") is not True:
            failed_devices = (
                result.get("failed_devices", [])
                if isinstance(result, dict)
                else []
            )

            logger.error(
                "예약 %s 장치 종료 실패. 실패 장치: %s",
                rid,
                failed_devices,
            )

            _state["last_error"] = (
                f"예약 {rid} 장치 종료 실패: {failed_devices}"
            )

            return False

        # 3. 모든 장치 종료 성공 후 예약 완료 처리
        updated = db.update_reservation_status(
            rid,
            "completed",
        )

        if not updated:
            logger.error(
                "예약 %s 장치 종료는 성공했지만 DB 완료 처리에 실패했습니다.",
                rid,
            )

            _state["last_error"] = (
                f"예약 {rid} DB 완료 처리 실패"
            )

            return False

        _state["warned_ids"].discard(rid)

        entry = _remember(
            "session_end",
            reservation,
            "이용 시간이 끝나 퇴실곡을 재생하고 전원·도어락을 차단했습니다.",
        )

        try:
            await ws_manager.broadcast({
                "type": "scheduler_action",
                **entry,
            })

        except Exception:
            logger.exception(
                "예약 %s 종료 WebSocket 알림 실패",
                rid,
            )

        return True

    except Exception as exc:
        logger.exception(
            "자동 이용 종료 실패 (예약 %s): %s",
            rid,
            exc,
        )

        _state["last_error"] = (
            f"예약 {rid} 자동 종료 실패: {exc}"
        )

        return False

    finally:
        _state["ending_ids"].discard(rid)


# ── 자동 운영 엔진 ────────────────────────────────────────────────────────

async def run_once() -> Dict[str, Any]:
    """
    예약을 확인하고 종료 전 알림 및 자동 종료를 처리한다.

    실제 입장 시각(started_at)을 기준으로 작동한다.
    """

    now = now_local()
    done: List[Dict[str, Any]] = []

    try:
        reservations = _get_active_reservations()

    except Exception as exc:
        _state["last_error"] = (
            f"이용 중인 예약을 읽지 못했습니다: {exc}"
        )

        _state["last_tick"] = now.isoformat(
            timespec="seconds"
        )

        return {
            "checked": 0,
            "actions": [],
        }

    _state["last_error"] = None

    for reservation in reservations:
        rid = reservation.get("id")

        if str(
            reservation.get("status") or ""
        ) != "active":
            continue

        end = _reservation_end(reservation)

        if not end:
            logger.warning(
                "예약 %s의 실제 입장 시각을 확인할 수 없습니다.",
                rid,
            )
            continue

        # ── 이용 종료 ──────────────────────────────────────────────

        if now >= end:
            finished = await _finish_reservation(
                reservation
            )

            if finished:
                done.append({
                    "action": "session_end",
                    "reservation_id": rid,
                    "student_name": reservation.get("student_name"),
                    "time_slot": reservation.get("time_slot"),
                    "message": "이용 시간이 끝나 퇴실곡을 재생하고 전원·도어락을 차단했습니다.",
                    "at": now_local().isoformat(timespec="seconds"),
                })

            # 종료 대상이면 경고는 더 이상 실행하지 않는다.
            continue

        # ── 종료 전 알림 ───────────────────────────────────────────

        warn_at = end - timedelta(
            seconds=WARN_BEFORE_SEC
        )

        if (
            warn_at <= now
            < warn_at + timedelta(seconds=WARN_WINDOW_SEC)
            and rid not in _state["warned_ids"]
        ):
            try:
                await BoothService.trigger_10min_warning()

                _state["warned_ids"].add(rid)

                if MODE == "demo":
                    warn_text = (
                        f"이용 종료 {WARN_BEFORE_SEC}초 전"
                    )
                else:
                    warn_text = (
                        f"이용 종료 {WARN_BEFORE_SEC // 60}분 전"
                    )

                entry = _remember(
                    "session_warning",
                    reservation,
                    f"{warn_text} — LED 알림과 안내 음성을 내보냈습니다.",
                )

                done.append(entry)

                try:
                    await ws_manager.broadcast({
                        "type": "scheduler_action",
                        **entry,
                    })

                except Exception:
                    logger.exception(
                        "예약 %s 종료 전 알림 WebSocket 전송 실패",
                        rid,
                    )

            except Exception as exc:
                logger.error(
                    "종료 전 알림 실패 (예약 %s): %s",
                    rid,
                    exc,
                )

    _state["last_tick"] = now.isoformat(
        timespec="seconds"
    )

    return {
        "checked": len(reservations),
        "actions": done,
    }


# ── 관리자 상태 조회 ─────────────────────────────────────────────────────

def get_status() -> Dict[str, Any]:
    """관리자 화면에서 자동 운영 엔진 상태를 확인한다."""

    now = now_local()
    upcoming: List[Dict[str, Any]] = []

    try:
        reservations = db.get_reservations_on(
            now.strftime("%Y-%m-%d")
        )

        for reservation in reservations:
            reservation_status = str(
                reservation.get("status") or ""
            )

            if reservation_status not in (
                "reserved",
                "active",
            ):
                continue

            time_slot = str(
                reservation.get("time_slot") or ""
            )

            bounds = slot_bounds(
                now,
                time_slot,
            )

            if not bounds:
                continue

            start, scheduled_end = bounds

            actual_end = (
                _reservation_end(reservation)
                if reservation_status == "active"
                else None
            )

            end = actual_end or scheduled_end

            upcoming.append({
                "reservation_id": reservation.get("id"),
                "student_name": reservation.get("student_name"),
                "time_slot": time_slot,
                "status": reservation_status,
                "starts_at": start.isoformat(
                    timespec="minutes"
                ),
                "warns_at": (
                    end - timedelta(seconds=WARN_BEFORE_SEC)
                ).isoformat(
                    timespec="seconds"
                ),
                "ends_at": end.isoformat(
                    timespec="seconds"
                ),
            })

    except Exception as exc:
        logger.warning(
            "스케줄러 상태 조회 중 오류: %s",
            exc,
        )

    return {
        "enabled": ENABLED,
        "mode": MODE,
        "interval_sec": INTERVAL_SEC,
        "warn_before_sec": WARN_BEFORE_SEC,
        "durations_sec": DURATIONS,
        "timezone": tz_name(),
        "now": now.isoformat(
            timespec="seconds"
        ),
        "last_tick": _state["last_tick"],
        "last_error": _state["last_error"],
        "actions": _state["actions"],
        "upcoming": sorted(
            upcoming,
            key=lambda item: item["starts_at"],
        ),
    }


# ── 백그라운드 루프 ───────────────────────────────────────────────────────

_task: Optional[asyncio.Task] = None


async def _loop() -> None:
    logger.info(
        "예약 자동 운영 엔진 시작 — "
        "모드: %s, 주기: %s초, 종료 전 알림: %s초",
        MODE,
        INTERVAL_SEC,
        WARN_BEFORE_SEC,
    )

    while True:
        try:
            await run_once()

        except asyncio.CancelledError:
            raise

        except Exception as exc:
            _state["last_error"] = str(exc)

            logger.error(
                "스케줄러 실행 오류: %s",
                exc,
            )

        await asyncio.sleep(
            INTERVAL_SEC
        )


def start() -> None:
    """FastAPI 시작 시 호출한다."""

    global _task

    if not ENABLED:
        logger.info(
            "SCHEDULER_ENABLED=false — "
            "자동 운영 엔진을 실행하지 않습니다."
        )
        return

    if _task and not _task.done():
        return

    _task = asyncio.create_task(
        _loop()
    )


async def stop() -> None:
    """FastAPI 종료 시 호출한다."""

    global _task

    if _task and not _task.done():
        _task.cancel()

        try:
            await _task

        except asyncio.CancelledError:
            pass

    _task = None