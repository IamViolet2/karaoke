import csv
from datetime import datetime, timezone
import io
import logging
import secrets
from typing import Any, Dict, Optional
from urllib.parse import quote

from fastapi import (
    APIRouter,
    Depends,
    Header,
    HTTPException,
    Query,
    Request,
    Response,
    status,
)

from auth import get_admin_pin, verify_admin_token, is_valid_admin_token
from booth_time import now_local as booth_now, today_str as booth_today
from db import database as db
from iot.provider_factory import get_device_provider
from login_guard import client_key, keypad_guard
from schemas.reservation import (
    KeypadVerifyRequest,
    ReservationCreateRequest,
    ScoreRecordRequest,
    SongRecordRequest,
    SongVideoRequest,
)
from services.booth_service import BoothService
from services import scheduler
from websocket_manager import ws_manager


logger = logging.getLogger("backend.routers.reservations")

reservations_router = APIRouter(
    prefix="/api/reservations",
    tags=["reservations"],
)
booth_router = APIRouter(
    prefix="/api/booth",
    tags=["booth-automation"],
)
songs_router = APIRouter(
    prefix="/api/songs",
    tags=["songs"],
)
videos_router = APIRouter(
    prefix="/api/song-videos",
    tags=["song-videos"],
)
scores_router = APIRouter(
    prefix="/api/scores",
    tags=["scores"],
)
scheduler_router = APIRouter(
    prefix="/api/scheduler",
    tags=["scheduler"],
)


# ==============================================================================
# 공통 함수
# ==============================================================================

async def _require_booth_in_use() -> None:
    """
    부스 전원(relay_1)이 켜져 있을 때만 통과시킨다.

    노래 기록과 점수는 부스에서 실제로 부른 것이어야 하므로
    부스 전원이 켜져 있는 경우에만 기록을 허용한다.
    """

    relay = await get_device_provider().get_device_status(
        "relay_1"
    )

    if not relay or relay.get("current_state") != "on":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "BOOTH_NOT_IN_USE",
                "message": (
                    "부스를 이용하는 중(전원이 켜져 있을 때)에만 "
                    "기록할 수 있습니다."
                ),
            },
        )


def _generate_reservation_pin() -> str:
    """
    중복되지 않는 4자리 예약 PIN을 생성한다.

    관리자 PIN, 개발용 PIN, 기존 예약 PIN과 겹치지 않게 한다.
    사용 중인 PIN 조회에 실패하면 안전을 위해 발급을 중단한다.
    """

    try:
        taken = {
            str(pin)
            for pin in db.pins_in_use(booth_today())
            if pin is not None
        }

    except Exception as exc:
        logger.error(
            "사용 중인 PIN 조회 실패: %s",
            exc,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "PIN_CHECK_FAILED",
                "message": (
                    "예약 비밀번호 중복 확인에 실패했습니다. "
                    "잠시 뒤 다시 시도해 주세요."
                ),
            },
        )

    admin_pin = get_admin_pin()

    taken.add("1234")

    if admin_pin is not None:
        taken.add(str(admin_pin))

    available = [
        f"{number:04d}"
        for number in range(1000, 10000)
        if f"{number:04d}" not in taken
    ]

    if not available:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "NO_AVAILABLE_PIN",
                "message": (
                    "발급 가능한 예약 비밀번호가 없습니다. "
                    "관리자에게 문의해 주세요."
                ),
            },
        )

    return secrets.choice(available)


# ==============================================================================
# 예약 엔드포인트 (F-01, F-02)
# ==============================================================================

@reservations_router.get("")
async def list_reservations(
    x_admin_token: Optional[str] = Header(
        None,
        alias="X-Admin-Token",
    ),
) -> Dict[str, Any]:
    """
    예약 목록 조회.

    PIN은 관리자에게만 보여 준다.
    일반 사용자는 예약 목록에서 다른 사람의 PIN을 확인할 수 없다.
    """

    try:
        items = db.get_reservations()

    except Exception as exc:
        logger.error(
            "Failed to fetch reservations: %s",
            exc,
        )
        return {"data": []}

    if not is_valid_admin_token(x_admin_token):
        items = [
            {
                key: value
                for key, value in reservation.items()
                if key != "pin_code"
            }
            for reservation in items
        ]

    return {"data": items}


@reservations_router.post("")
async def create_new_reservation(
    req: ReservationCreateRequest,
) -> Dict[str, Any]:
    """
    새 노래방 부스 예약 신청.

    - 과거 날짜 예약 차단
    - 당일 예약 허용
    - 미래 날짜 예약 허용
    - 동일 날짜/시간대 중복 예약 차단
    - 4자리 일회성 비밀번호 자동 생성
    """

    today_str = booth_today()

    if req.reservation_date < today_str:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "PAST_DATE_NOT_ALLOWED",
                "message": "과거 날짜는 예약할 수 없습니다.",
            },
        )

    if req.time_slot not in ("lunch", "dinner"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "INVALID_TIME_SLOT",
                "message": (
                    "타임슬롯은 'lunch'(점심) 또는 "
                    "'dinner'(저녁)여야 합니다."
                ),
            },
        )

    try:
        existing = db.find_live_reservation(
            req.reservation_date,
            req.time_slot,
        )

    except Exception as exc:
        logger.error(
            "Error checking duplicate reservation: %s",
            exc,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "RESERVATION_CHECK_FAILED",
                "message": (
                    "예약 가능 여부를 확인하지 못했습니다. "
                    "잠시 뒤 다시 시도해 주세요."
                ),
            },
        )

    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "SLOT_ALREADY_RESERVED",
                "message": (
                    f"선택하신 날짜({req.reservation_date})의 "
                    "해당 시간대는 이미 예약이 완료되었습니다."
                ),
            },
        )

    pin = _generate_reservation_pin()

    try:
        reservation = db.create_reservation(
            grade=req.grade,
            department=req.department,
            student_name=req.student_name,
            user_count=req.user_count,
            reservation_date=req.reservation_date,
            time_slot=req.time_slot,
            pin_code=pin,
        )

    except ValueError as exc:
        # 사전 중복 검사 이후 다른 요청이 먼저 예약했을 수 있다.
        # 저장소에서 발생한 중복 예약 오류를 HTTP 409로 변환한다.
        logger.info(
            "Reservation slot conflict: %s",
            exc,
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "SLOT_ALREADY_RESERVED",
                "message": (
                    f"선택하신 날짜({req.reservation_date})의 "
                    "해당 시간대는 이미 예약이 완료되었습니다."
                ),
            },
        )

    except Exception as exc:
        logger.error(
            "Failed to create reservation: %s",
            exc,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "RESERVATION_CREATION_FAILED",
                "message": (
                    "예약을 저장하지 못했습니다. "
                    "잠시 뒤 다시 시도해 주세요."
                ),
            },
        )

    await ws_manager.broadcast({
        "type": "reservation_created",
        "reservation_id": reservation.get("id"),
        "student_name": req.student_name,
        "reservation_date": req.reservation_date,
        "time_slot": req.time_slot,
        "timestamp": (
            datetime.now(timezone.utc)
            .isoformat()
            .replace("+00:00", "Z")
        ),
    })

    return {
        "data": reservation,
    }


# ==============================================================================
# 부스 자동화 및 시뮬레이터 제어 엔드포인트 (F-02 ~ F-04)
# ==============================================================================

@booth_router.get("/session")
async def booth_session() -> Dict[str, Any]:
    """현재 부스 이용자와 남은 시간을 반환한다."""

    return {
        "data": scheduler.current_session(),
    }


@booth_router.post("/verify-keypad")
async def verify_keypad(
    req: KeypadVerifyRequest,
    request: Request,
) -> Dict[str, Any]:
    """
    키패드 입력 비밀번호 검증.

    - 예약 PIN
    - 관리자 PIN

    연속으로 틀리면 login_guard.py에서 일정 시간 차단한다.
    예약 날짜나 시간대에 따른 PIN 인증 제한은 적용하지 않는다.
    """

    key = client_key(request)

    keypad_guard.check(key)

    result = await BoothService.verify_and_trigger(
        req.pin
    )

    if not result.get("success"):
        keypad_guard.fail(key)

        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "INVALID_PIN",
                "message": result.get("message"),
            },
        )

    keypad_guard.succeed(key)

    return {
        "data": result,
    }


@booth_router.post("/simulate-entry")
async def simulate_entry(
    _admin: str = Depends(verify_admin_token),
) -> Dict[str, Any]:
    """입장 감지 센서(PIR) 또는 비전 사람 감지 트리거 시뮬레이션."""

    result = await BoothService.trigger_entry()

    return {
        "data": result,
    }


@booth_router.post("/simulate-10min-warning")
async def simulate_10min_warning(
    _admin: str = Depends(verify_admin_token),
) -> Dict[str, Any]:
    """
    이용 종료 전 LED 깜빡임 및 사전 알림 트리거 시뮬레이션.

    기존 프론트엔드 API 경로와의 호환성을 위해
    엔드포인트 이름은 유지한다.
    """

    result = await BoothService.trigger_10min_warning()

    return {
        "data": result,
    }


@booth_router.post("/simulate-end")
async def simulate_end(
    _admin: str = Depends(verify_admin_token),
) -> Dict[str, Any]:
    """
    이용 종료 및 퇴실곡 재생 + 전원/도어락 차단.

    처리 순서:
    1. 장치 종료 명령 실행
    2. 장치 종료 성공 여부 확인
    3. 활성 예약 완료 처리
    4. DB를 다시 조회하여 활성 예약이 남았는지 확인

    장치 종료에 실패하면 예약을 완료 처리하지 않는다.
    """

    # 1. 장치 종료 실행
    try:
        result = await BoothService.trigger_session_end()

    except Exception as exc:
        logger.exception(
            "Manual session end failed: %s",
            exc,
        )

        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "DEVICE_SHUTDOWN_FAILED",
                "message": (
                    "부스 장치 종료 과정에서 오류가 발생했습니다. "
                    "예약은 완료 처리하지 않았습니다."
                ),
            },
        )

    # 2. 장치 종료 결과 확인
    if not isinstance(result, dict) or result.get("success") is not True:
        logger.error(
            "Manual session end partially failed: %s",
            result,
        )

        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "DEVICE_SHUTDOWN_FAILED",
                "message": (
                    "일부 장치의 종료에 실패했습니다. "
                    "예약은 완료 처리하지 않았습니다."
                ),
                "device_result": result,
            },
        )

    # 3. 활성 예약 완료 처리
    try:
        finished_count = scheduler.finish_active_reservations()

        # 4. 실제 저장소 상태 재확인
        remaining = db.get_active_reservations()

    except Exception as exc:
        logger.exception(
            "Failed to complete active reservations after shutdown: %s",
            exc,
        )

        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "RESERVATION_COMPLETION_FAILED",
                "message": (
                    "장치는 종료했지만 예약 완료 상태를 "
                    "확인하지 못했습니다."
                ),
                "device_result": result,
            },
        )

    # 활성 예약이 남아 있으면 완료 처리 실패로 판단한다.
    if remaining:
        remaining_ids = [
            reservation.get("id")
            for reservation in remaining
        ]

        logger.error(
            "Active reservations remain after manual shutdown: %s",
            remaining_ids,
        )

        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "RESERVATION_COMPLETION_INCOMPLETE",
                "message": (
                    "장치는 종료했지만 일부 예약이 "
                    "완료 처리되지 않았습니다."
                ),
                "finished_count": finished_count,
                "remaining_reservation_ids": remaining_ids,
            },
        )

    logger.info(
        "Manual session end completed. Reservations finished: %s",
        finished_count,
    )

    return {
        "data": {
            **result,
            "reservations_finished": finished_count,
            "reservations_remaining": 0,
        },
    }


# ==============================================================================
# 노래 기록 및 나의 18번 엔드포인트 (F-05)
# ==============================================================================

@songs_router.get("")
async def list_songs(
    min_count: int = Query(3, ge=1),
) -> Dict[str, Any]:
    """
    노래 목록 조회.

    DB가 연결되지 않아도 노래방 화면 자체는 동작하도록
    조회 실패 시 빈 목록을 반환한다.
    """

    try:
        all_songs = db.get_all_songs()
        favorites = db.get_favorite_songs(
            min_count=min_count
        )

    except Exception as exc:
        logger.error(
            "Failed to fetch songs: %s",
            exc,
        )
        all_songs, favorites = [], []

    return {
        "data": {
            "all": all_songs,
            "favorites": favorites,
        },
    }


@songs_router.post("")
async def add_song(
    req: SongRecordRequest,
) -> Dict[str, Any]:
    """
    부른 노래 기록 등록.

    기존 곡이면 카운트를 1 증가시킨다.
    부스 전원이 켜져 있을 때만 기록할 수 있다.
    """

    await _require_booth_in_use()

    try:
        recorded = db.record_song(
            title=req.title,
            singer=req.singer,
        )

    except Exception as exc:
        logger.error(
            "Failed to record song: %s",
            exc,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "SONG_SAVE_FAILED",
                "message": "노래 기록을 저장하지 못했습니다.",
            },
        )

    await ws_manager.broadcast({
        "type": "song_recorded",
        "title": req.title,
        "singer": req.singer,
        "sing_count": recorded.get("sing_count"),
        "timestamp": (
            datetime.now(timezone.utc)
            .isoformat()
            .replace("+00:00", "Z")
        ),
    })

    return {
        "data": recorded,
    }


# ==============================================================================
# 노래방 영상 등록 (F-06)
# ==============================================================================

@videos_router.get("")
async def list_song_videos() -> Dict[str, Any]:
    """등록된 곡별 영상 ID 목록."""

    try:
        return {
            "data": db.get_song_videos(),
        }

    except Exception as exc:
        logger.error(
            "Failed to fetch song videos: %s",
            exc,
        )
        return {
            "data": {},
        }


@videos_router.put("/{song_id}")
async def register_song_video(
    song_id: str,
    req: SongVideoRequest,
    _admin: str = Depends(verify_admin_token),
) -> Dict[str, Any]:
    """곡의 노래방 영상을 등록한다. 관리자 전용."""

    saved = db.set_song_video(
        song_id,
        req.video_id,
    )

    logger.info(
        "Song video registered: %s -> %s",
        song_id,
        req.video_id,
    )

    return {
        "data": saved,
    }


@videos_router.delete("/{song_id}")
async def unregister_song_video(
    song_id: str,
    _admin: str = Depends(verify_admin_token),
) -> Dict[str, Any]:
    """등록된 영상을 삭제하고 기본 후보 목록으로 되돌린다."""

    db.delete_song_video(song_id)

    return {
        "data": {
            "song_id": song_id,
            "removed": True,
        },
    }


# ==============================================================================
# 점수 기록과 랭킹 (부록G §2-④)
# ==============================================================================

@scores_router.post("")
async def record_score(
    req: ScoreRecordRequest,
) -> Dict[str, Any]:
    """채점 결과를 저장하고 대시보드에 실시간으로 알린다."""

    await _require_booth_in_use()

    try:
        saved = db.record_score(
            nickname=(
                (req.nickname or "익명").strip() or "익명"
            ),
            title=req.title,
            singer=req.singer,
            score=req.score,
            rank_label=req.rank_label,
            pitch=req.pitch,
            timing=req.timing,
            volume=req.volume,
            expression=req.expression,
        )

    except Exception as exc:
        logger.error(
            "Failed to record score: %s",
            exc,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "SCORE_SAVE_FAILED",
                "message": "점수를 저장하지 못했습니다.",
            },
        )

    await ws_manager.broadcast({
        "type": "score_recorded",
        "nickname": saved.get("nickname"),
        "title": saved.get("title"),
        "score": saved.get("score"),
        "timestamp": (
            datetime.now(timezone.utc)
            .isoformat()
            .replace("+00:00", "Z")
        ),
    })

    return {
        "data": saved,
    }


@scores_router.get("/top")
async def list_top_scores(
    period: str = Query(
        "today",
        pattern="^(today|all)$",
    ),
    limit: int = Query(
        5,
        ge=1,
        le=50,
    ),
    title: Optional[str] = Query(
        None,
        max_length=100,
    ),
    best: bool = Query(
        False,
        description="같은 이름은 최고 기록 하나만",
    ),
) -> Dict[str, Any]:
    """오늘의 순위 또는 명예의 전당을 조회한다."""

    try:
        return {
            "data": db.get_top_scores(
                period=period,
                limit=limit,
                title=title,
                best_per_name=best,
            ),
        }

    except Exception as exc:
        logger.error(
            "Failed to fetch top scores: %s",
            exc,
        )
        return {
            "data": [],
        }


def _csv_text(value: Any) -> str:
    """
    엑셀 수식 실행을 방지한다.

    관람객이 입력한 값이 =, +, -, @ 등으로 시작하면
    앞에 작은따옴표를 붙인다.
    """

    text = "" if value is None else str(value)

    if text == "-":
        return text

    if text[:1] in (
        "=",
        "+",
        "-",
        "@",
        "\t",
        "\r",
    ):
        return "'" + text

    return text


@scores_router.get("/export")
async def export_scores(
    period: str = Query(
        "today",
        pattern="^(today|all)$",
    ),
    title: Optional[str] = Query(
        None,
        max_length=100,
    ),
    best: bool = Query(True),
    _admin: str = Depends(verify_admin_token),
) -> Response:
    """
    순위를 CSV로 내려받는다.

    관리자 전용이며 UTF-8 BOM을 붙여 한글이 깨지지 않도록 한다.
    """

    try:
        rows = db.get_top_scores(
            period=period,
            limit=None,
            title=title,
            best_per_name=best,
        )

    except Exception as exc:
        logger.error(
            "Failed to export scores: %s",
            exc,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "EXPORT_FAILED",
                "message": "기록을 읽지 못했습니다.",
            },
        )

    buf = io.StringIO()
    writer = csv.writer(buf)

    writer.writerow([
        "순위",
        "이름",
        "점수",
        "등급",
        "곡",
        "기록 시각",
    ])

    tz = booth_now().tzinfo

    for index, row in enumerate(rows, 1):
        when = str(
            row.get("created_at") or ""
        )

        try:
            when = (
                datetime.fromisoformat(
                    when.replace("Z", "+00:00")
                )
                .astimezone(tz)
                .strftime("%Y-%m-%d %H:%M:%S")
            )

        except (ValueError, TypeError):
            pass

        writer.writerow([
            index,
            _csv_text(row.get("nickname")),
            row.get("score"),
            _csv_text(row.get("rank_label")),
            _csv_text(row.get("title")),
            when,
        ])

    filename = (
        f"scores-{title or 'all'}-"
        f"{period}-{booth_today()}.csv"
    )

    return Response(
        content="\ufeff" + buf.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": (
                f"attachment; filename*=UTF-8''{quote(filename)}"
            ),
        },
    )


@scores_router.get("/recent")
async def list_recent_scores(
    limit: int = Query(
        10,
        ge=1,
        le=50,
    ),
) -> Dict[str, Any]:
    """최근 점수 기록을 조회한다."""

    try:
        return {
            "data": db.get_recent_scores(
                limit=limit
            ),
        }

    except Exception as exc:
        logger.error(
            "Failed to fetch recent scores: %s",
            exc,
        )
        return {
            "data": [],
        }


# ==============================================================================
# 예약 시간 자동 운영 엔진 (부록G §2-①)
# ==============================================================================

@scheduler_router.get("/status")
async def scheduler_status() -> Dict[str, Any]:
    """엔진 설정, 마지막 실행 시각, 최근 처리 내역 및 오늘 남은 일정을 조회한다."""

    try:
        return {
            "data": scheduler.get_status(),
        }

    except Exception as exc:
        logger.error(
            "Failed to read scheduler status: %s",
            exc,
        )

        return {
            "data": {
                "enabled": False,
                "last_error": str(exc),
                "actions": [],
                "upcoming": [],
            },
        }


@scheduler_router.post("/run")
async def scheduler_run_once(
    _admin: str = Depends(verify_admin_token),
) -> Dict[str, Any]:
    """스케줄러를 즉시 한 번 실행한다. 관리자 전용."""

    result = await scheduler.run_once()

    return {
        "data": result,
    }