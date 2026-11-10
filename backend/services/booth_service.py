import logging
import os
from datetime import datetime, timezone
from typing import Any, Dict, List

from auth import is_admin_pin
from db import database as db
from iot.provider_factory import get_device_provider
from websocket_manager import ws_manager

logger = logging.getLogger("backend.services.booth")

# 예약 없이 인증 흐름만 확인하고 싶을 때 사용하는 개발용 만능 PIN.
# 기본은 꺼 두고, 로컬 개발에서만 .env로 활성화한다.
TEST_PIN = "1234"


def _test_pin_allowed() -> bool:
    return os.getenv("ALLOW_TEST_PIN", "false").strip().lower() == "true"


# 부스 스피커 안내 문구
SPEECH_ADMIN = "관리자 모드로 인증되었습니다. 점검을 진행하세요."
SPEECH_INVALID = "비밀번호가 맞지 않습니다. 다시 확인해 주세요."
SPEECH_ENTRY = "부스에 입장하셨습니다. 즐거운 시간 되세요!"
SPEECH_WARNING = "이용 종료 10분 전입니다. 다음 이용자를 위해 정리를 준비해 주세요."
SPEECH_END = "이용 시간이 종료되었습니다. 퇴실해 주시기 바랍니다."


def _welcome_speech(user_name: str) -> str:
    return f"{user_name}님 환영합니다! 노래방 전원이 켜졌습니다."


class BoothService:
    """
    학교 노래방 부스 자동화 제어 비즈니스 로직 서비스 (PRD F-01 ~ F-04).
    """

    @staticmethod
    async def verify_and_trigger(pin_code: str) -> Dict[str, Any]:
        """
        4자리 키패드 비밀번호 검증 및 도어락/전원/LED/스피커 자동 제어

        - 관리자 PIN: 도어락 해제 + LED 점등 (노래방 전원은 차단 유지)
        - 예약 PIN: 예약 상태를 active로 변경하고 도어락/전원/LED 작동
        - 예약 PIN은 예약 날짜나 시간대와 관계없이 즉시 사용 가능
        - 예약 PIN은 인증 성공 후 재사용할 수 없음
        """

        provider = get_device_provider()
        now_str = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

        # 1. 관리자 고정 비밀번호 처리
        if is_admin_pin(pin_code):
            logger.info("Admin PIN authenticated. Unlocking door and LED only.")

            await provider.set_actuator_state(
                "door_lock_1",
                "unlocked",
                operator="admin",
            )
            await provider.set_actuator_state(
                "led_1",
                "on",
                {"mode": "admin", "brightness_pct": 100},
                operator="admin",
            )
            await provider.set_actuator_state(
                "relay_1",
                "off",
                operator="admin",
            )
            await provider.set_actuator_state(
                "speaker_1",
                "playing",
                {
                    "track": "admin_welcome",
                    "message": SPEECH_ADMIN,
                },
                operator="admin",
            )

            event_msg = {
                "type": "booth_auth",
                "mode": "admin",
                "success": True,
                "message": "관리자 인증 성공 — 도어락 해제 및 LED 점등 (기기 전원 제외)",
                "speech": SPEECH_ADMIN,
                "timestamp": now_str,
            }

            await ws_manager.broadcast(event_msg)

            return {
                "success": True,
                "mode": "admin",
                "message": "관리자 모드로 인증되었습니다. (노래방 전원 제외, 도어락 및 LED 작동)",
            }

        # 2. 학생 예약 일회성 PIN 검증
        #
        # 예약 날짜와 점심/저녁 시간대는 인증 조건으로 사용하지 않는다.
        # 예약 상태가 reserved인 PIN만 조회하므로 인증 후 재사용도 차단된다.
        reservation = None

        try:
            candidates = db.get_reservations_by_pin(pin_code)

            if candidates:
                reservation = candidates[0]

        except Exception as exc:
            logger.warning("Reservation lookup failed for PIN: %s", exc)
            candidates = []

        # 3. 예약 PIN이 없으면 개발용 테스트 PIN 확인
        #
        # 기본적으로 비활성화되어 있으며,
        # ALLOW_TEST_PIN=true일 때만 TEST_PIN을 허용한다.
        is_test_user = (
            reservation is None
            and _test_pin_allowed()
            and pin_code == TEST_PIN
        )

        if not reservation and not is_test_user:
            event_msg = {
                "type": "booth_auth",
                "success": False,
                "message": "비밀번호 불일치 — 인증에 실패하였습니다.",
                "reason": "invalid",
                "speech": SPEECH_INVALID,
                "timestamp": now_str,
            }

            await ws_manager.broadcast(event_msg)

            return {
                "success": False,
                "mode": "none",
                "reason": "invalid",
                "message": "등록되지 않았거나 이미 사용된 비밀번호입니다. 예약 PIN은 1회용입니다.",
            }

        # 4. 사용자 이름 결정
        if reservation:
            user_name = reservation.get("student_name", "학생")
        else:
            user_name = "테스트 학생"

        logger.info(
            "Reservation authenticated: %s. Activating booth.",
            user_name,
        )

        # 5. 예약 상태를 active로 변경
        #
        # database.py의 update_reservation_status()가
        # 최초 active 전환 시 started_at을 기록한다.
        if reservation and reservation.get("id"):
            try:
                updated = db.update_reservation_status(
                    reservation["id"],
                    "active",
                )

                if not updated:
                    logger.warning(
                        "Reservation status was not updated: id=%s",
                        reservation["id"],
                    )

                    return {
                        "success": False,
                        "mode": "none",
                        "reason": "reservation_update_failed",
                        "message": "예약 상태를 변경하지 못했습니다. 다시 시도해 주세요.",
                    }

            except Exception as exc:
                logger.exception(
                    "Failed to activate reservation: %s",
                    exc,
                )

                return {
                    "success": False,
                    "mode": "none",
                    "reason": "reservation_update_failed",
                    "message": "예약 인증 처리 중 오류가 발생했습니다.",
                }

        # 6. 일반 사용자 정상 인증
        #
        # 도어락 해제 + 전원 릴레이 공급 + LED 점등 + 환영 음성
        await provider.set_actuator_state(
            "door_lock_1",
            "unlocked",
            operator="user",
        )

        await provider.set_actuator_state(
            "relay_1",
            "on",
            operator="user",
        )

        await provider.set_actuator_state(
            "led_1",
            "on",
            {
                "mode": "normal",
                "brightness_pct": 100,
            },
            operator="user",
        )

        await provider.set_actuator_state(
            "speaker_1",
            "playing",
            {
                "track": "welcome",
                "message": _welcome_speech(user_name),
            },
            operator="user",
        )

        event_msg = {
            "type": "booth_auth",
            "mode": "user",
            "success": True,
            "user_name": user_name,
            "message": f"{user_name}님 인증 성공! 부스 전원 공급 및 도어락이 해제되었습니다.",
            "speech": _welcome_speech(user_name),
            "timestamp": now_str,
        }

        await ws_manager.broadcast(event_msg)

        return {
            "success": True,
            "mode": "user",
            "user_name": user_name,
            "reservation": reservation,
            "message": f"{user_name}님 인증 성공! 부스 전원과 도어락이 가동됩니다.",
        }

    @staticmethod
    async def trigger_entry() -> Dict[str, Any]:
        """
        사람 입장 감지(PIR 센서 또는 비전 감지) 시 트리거
        환영 안내 문구 및 오디오 출력
        """

        provider = get_device_provider()
        now_str = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

        # PIR 센서 상태 갱신
        try:
            db.update_current_state(
                "pir_1",
                "detected",
                {"detected": True},
            )

            db.log_sensor_reading(
                "pir_1",
                value=1.0,
                unit="detection",
                value_json={"detected": True},
            )

        except Exception as exc:
            logger.warning(
                "DB log failed for entry trigger: %s",
                exc,
            )

        # 스피커 환영 메시지 송출
        await provider.set_actuator_state(
            "speaker_1",
            "playing",
            {
                "track": "entry_greeting",
                "message": SPEECH_ENTRY,
            },
            operator="device",
        )

        event_msg = {
            "type": "booth_event",
            "event": "entry_detected",
            "message": "부스 사람 입장 감지 — 환영 안내 음성을 송출합니다.",
            "speech": SPEECH_ENTRY,
            "timestamp": now_str,
        }

        await ws_manager.broadcast(event_msg)

        return {
            "recorded": True,
            "message": "환영 안내가 출력되었습니다.",
        }

    @staticmethod
    async def trigger_10min_warning() -> Dict[str, Any]:
        """
        이용 종료 전 트리거:
        LED 깜빡임 알림 및 사전 안내

        실제 경고 시점은 scheduler.py 설정에 따라 결정된다.
        """

        provider = get_device_provider()
        now_str = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

        await provider.set_actuator_state(
            "led_1",
            "blink",
            {"mode": "warning_blink"},
            operator="system",
        )

        await provider.set_actuator_state(
            "speaker_1",
            "playing",
            {
                "track": "warning_10m",
                "message": SPEECH_WARNING,
            },
            operator="system",
        )

        event_msg = {
            "type": "booth_event",
            "event": "10min_warning",
            "message": "이용 종료 전 — LED 조명이 깜빡이며 종료 알림을 표시합니다.",
            "speech": SPEECH_WARNING,
            "timestamp": now_str,
        }

        await ws_manager.broadcast(event_msg)

        return {
            "recorded": True,
            "message": "이용 종료 사전 알림이 작동되었습니다.",
        }

    @staticmethod
    async def trigger_session_end() -> Dict[str, Any]:
        """
        이용 종료 트리거:
        1. 지정 종료 음악 재생
        2. 전원 릴레이 차단
        3. 도어락 잠금
        4. LED 소등

        각 장치 명령을 독립적으로 실행한다.
        특정 장치가 실패하더라도 나머지 종료 명령은 계속 실행한다.
        """

        provider = get_device_provider()
        now_str = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

        device_commands = [
            {
                "device_id": "speaker_1",
                "state": "playing",
                "value": {
                    "track": "더윈드 - 다시 만나 (0:58~)",
                    "message": SPEECH_END,
                },
            },
            {
                "device_id": "relay_1",
                "state": "off",
                "value": None,
            },
            {
                "device_id": "door_lock_1",
                "state": "locked",
                "value": None,
            },
            {
                "device_id": "led_1",
                "state": "off",
                "value": None,
            },
        ]

        results: Dict[str, Dict[str, Any]] = {}

        for command in device_commands:
            device_id = command["device_id"]

            try:
                if command["value"] is None:
                    await provider.set_actuator_state(
                        device_id,
                        command["state"],
                        operator="system",
                    )
                else:
                    await provider.set_actuator_state(
                        device_id,
                        command["state"],
                        command["value"],
                        operator="system",
                    )

                results[device_id] = {
                    "success": True,
                    "message": "명령 실행 성공",
                }

                logger.info(
                    "Session-end command succeeded: device=%s state=%s",
                    device_id,
                    command["state"],
                )

            except Exception as exc:
                results[device_id] = {
                    "success": False,
                    "message": str(exc),
                }

                logger.exception(
                    "Session-end command failed: device=%s",
                    device_id,
                )

        failed_devices: List[str] = [
            device_id
            for device_id, result in results.items()
            if not result["success"]
        ]

        all_success = len(failed_devices) == 0

        if all_success:
            message = (
                "이용이 종료되어 종료 음악 재생, 전원 차단, "
                "도어락 잠금 및 LED 소등이 완료되었습니다."
            )
        else:
            message = (
                "이용 종료 명령 중 일부가 실패했습니다. "
                f"실패 장치: {', '.join(failed_devices)}"
            )

        event_msg = {
            "type": "booth_event",
            "event": "session_ended" if all_success else "session_end_partial_failure",
            "success": all_success,
            "message": message,
            "speech": SPEECH_END,
            "device_results": results,
            "failed_devices": failed_devices,
            "timestamp": now_str,
        }

        # WebSocket 통신 실패가 장치 종료 결과를 덮어쓰지 않도록 별도 처리한다.
        try:
            await ws_manager.broadcast(event_msg)
        except Exception:
            logger.exception("Failed to broadcast session-end event.")

        return {
            "recorded": all_success,
            "success": all_success,
            "message": message,
            "device_results": results,
            "failed_devices": failed_devices,
        }