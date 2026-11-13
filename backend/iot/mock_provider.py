import logging
import random
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from .base import DeviceProvider

logger = logging.getLogger("backend.iot.mock")

# DB 모듈 임포트 시도
# DB 연결이 없어도 Mock은 정상 작동하도록 fallback 지원
try:
    from db import database as db
except ImportError:
    try:
        import db.database as db  # type: ignore
    except ImportError:
        db = None  # type: ignore


class MockDeviceProvider(DeviceProvider):
    """
    개발 전반부(Mock 모드)용 IoT 디바이스 제어 제공자.

    AGENTS.md 팀 정보 및 devices 테이블(init.sql)의 id와
    1:1 매핑됩니다.

    DB 장애 또는 일부 장치 미등록 상황에서도
    메모리 기반 기본 장치 목록으로 fallback합니다.
    """

    def __init__(self) -> None:
        # 메모리 기반 디바이스 기본 상태 사전
        # DB 장애 또는 DB 미등록 시에도 fallback 유지
        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

        self._devices: Dict[str, Dict[str, Any]] = {

            # ==========================================================
            # 액추에이터 목록
            # ==========================================================

            "door_lock_1": {
                "id": "door_lock_1",
                "name": "솔레노이드 도어락",
                "kind": "door_lock",
                "desired_state": "locked",
                "current_state": "locked",
                "desired_value": None,
                "current_value": None,
                "updated_at": now,
            },

            "relay_1": {
                "id": "relay_1",
                "name": "기기 전원 릴레이",
                "kind": "relay",
                "desired_state": "off",
                "current_state": "off",
                "desired_value": None,
                "current_value": None,
                "updated_at": now,
            },

            "led_1": {
                "id": "led_1",
                "name": "부스 조명 LED",
                "kind": "led",
                "desired_state": "off",
                "current_state": "off",
                "desired_value": {
                    "brightness_pct": 100,
                    "mode": "normal",
                },
                "current_value": {
                    "brightness_pct": 100,
                    "mode": "normal",
                },
                "updated_at": now,
            },

            # 선풍기
            # Raspberry Pi 5 GPIO 18
            # HIGH = ON / LOW = OFF
            "fan_1": {
                "id": "fan_1",
                "name": "부스 선풍기",
                "kind": "fan",
                "desired_state": "off",
                "current_state": "off",
                "desired_value": None,
                "current_value": None,
                "updated_at": now,
            },

            "speaker_1": {
                "id": "speaker_1",
                "name": "스피커/오디오 모듈",
                "kind": "speaker",
                "desired_state": "idle",
                "current_state": "idle",
                "desired_value": {
                    "track": None,
                    "volume": 70,
                },
                "current_value": {
                    "track": None,
                    "volume": 70,
                },
                "updated_at": now,
            },

            # ==========================================================
            # 센서 목록
            # ==========================================================

            "keypad_1": {
                "id": "keypad_1",
                "name": "4x4 비밀번호 키패드",
                "kind": "keypad",
                "desired_state": None,
                "current_state": "ready",
                "desired_value": None,
                "current_value": {
                    "last_key": None,
                    "buffer": "",
                },
                "updated_at": now,
            },

            "pir_1": {
                "id": "pir_1",
                "name": "입장 감지 센서",
                "kind": "pir",
                "desired_state": None,
                "current_state": "standby",
                "desired_value": None,
                "current_value": {
                    "detected": False,
                },
                "updated_at": now,
            },
        }

    # ==================================================================
    # 특정 디바이스 상태 조회
    # ==================================================================

    async def get_device_status(
        self,
        device_id: str,
    ) -> Optional[Dict[str, Any]]:
        """
        특정 디바이스의 최신 상태를 반환합니다.

        DB 조회가 가능하면 DB 레코드를 우선 반환하고,
        실패하거나 DB에 등록되지 않은 경우 메모리 상태를 반환합니다.
        """

        if db:
            try:
                db_device = db.get_device(device_id)

                if db_device:
                    # 메모리 상태도 DB 상태로 동기화
                    self._devices[device_id] = db_device

                    return db_device

            except Exception as exc:
                logger.warning(
                    f"DB read failed for device {device_id}, "
                    f"fallback to memory: {exc}"
                )

        return self._devices.get(device_id)

    # ==================================================================
    # 액추에이터 제어
    # ==================================================================

    async def set_actuator_state(
        self,
        device_id: str,
        desired_state: str,
        value: Optional[Any] = None,
        operator: str = "user",
    ) -> Dict[str, Any]:
        """
        액추에이터의 상태를 제어합니다.

        Mock 모드에서는 즉시 반영(desired_state -> current_state)을
        시뮬레이션하며 DB 업데이트 및 제어 로그를 함께 기록합니다.
        """

        if device_id not in self._devices:
            raise ValueError(
                f"Unknown device_id: {device_id}"
            )

        now_str = (
            datetime.now(timezone.utc)
            .isoformat()
            .replace("+00:00", "Z")
        )

        dev = self._devices[device_id]

        dev["desired_state"] = desired_state
        dev["current_state"] = desired_state

        dev["desired_value"] = value
        dev["current_value"] = value

        dev["updated_at"] = now_str

        # DB 동기화 및 제어 로그 기록
        if db:
            try:
                db.update_desired_state(
                    device_id,
                    desired_state,
                    value,
                )

                db.update_current_state(
                    device_id,
                    desired_state,
                    value,
                )

                db.log_control_action(
                    device_id,
                    desired_state,
                    value,
                    actor=operator,
                )

            except Exception as exc:
                logger.warning(
                    f"DB update failed during "
                    f"set_actuator_state for {device_id}: {exc}"
                )

        return dev

    # ==================================================================
    # 센서 값 조회
    # ==================================================================

    async def read_sensor_value(
        self,
        device_id: str,
    ) -> Dict[str, Any]:
        """
        센서의 최신 측정값을 시뮬레이션하여 반환합니다.

        Random Walk 및 주기적 감지 로직을 적용하고,
        DB에 측정값을 기록합니다.
        """

        if device_id not in self._devices:
            raise ValueError(
                f"Unknown device_id: {device_id}"
            )

        now_str = (
            datetime.now(timezone.utc)
            .isoformat()
            .replace("+00:00", "Z")
        )

        dev = self._devices[device_id]

        reading_result: Dict[str, Any] = {
            "device_id": device_id,
            "kind": dev["kind"],
            "reported_at": now_str,
        }

        if device_id == "pir_1":

            # 20% 확률로 재실/입장 감지 시뮬레이션
            is_detected = random.random() < 0.20

            dev["current_state"] = (
                "detected" if is_detected else "standby"
            )

            dev["current_value"] = {
                "detected": is_detected,
            }

            dev["updated_at"] = now_str

            reading_result["value"] = (
                1.0 if is_detected else 0.0
            )

            reading_result["unit"] = "detection"

            reading_result["value_json"] = {
                "detected": is_detected,
            }

            if db:
                try:
                    db.update_current_state(
                        device_id,
                        dev["current_state"],
                        dev["current_value"],
                    )

                    db.log_sensor_reading(
                        device_id=device_id,
                        value=reading_result["value"],
                        unit=reading_result["unit"],
                        value_json=reading_result["value_json"],
                    )

                except Exception as exc:
                    logger.warning(
                        f"DB logging failed for {device_id}: {exc}"
                    )

        elif device_id == "keypad_1":

            # 키패드 상태 시뮬레이션
            dev["updated_at"] = now_str

            current_buf = (
                dev.get("current_value") or {}
            ).get("buffer", "")

            reading_result["value"] = None
            reading_result["unit"] = "keypad"

            reading_result["value_json"] = {
                "buffer_len": len(current_buf),
                "is_ready": True,
            }

            if db:
                try:
                    db.log_sensor_reading(
                        device_id=device_id,
                        value=None,
                        unit="keypad",
                        value_json=reading_result["value_json"],
                    )

                except Exception as exc:
                    logger.warning(
                        f"DB logging failed for {device_id}: {exc}"
                    )

        else:

            # 기타 디바이스
            reading_result["value"] = None
            reading_result["unit"] = "unknown"

            reading_result["value_json"] = dev.get(
                "current_value"
            )

        return reading_result

    # ==================================================================
    # 실기기 상태 보고 반영
    # ==================================================================

    async def apply_reported_state(
        self,
        device_id: str,
        state: Optional[str],
        value: Optional[Any] = None,
    ) -> None:
        """
        라즈베리파이가 보고한 확정 상태를 메모리에도 적어 둡니다.

        DB 장애 시 메모리 상태를 최후의 fallback으로 사용합니다.
        """

        dev = self._devices.get(device_id)

        if not dev:
            return

        if state is not None:
            dev["current_state"] = state

        if value is not None:
            dev["current_value"] = value

        dev["updated_at"] = (
            datetime.now(timezone.utc)
            .isoformat()
            .replace("+00:00", "Z")
        )

    # ==================================================================
    # 전체 디바이스 상태 조회
    # ==================================================================

    async def get_all_statuses(
        self,
    ) -> List[Dict[str, Any]]:
        """
        모든 디바이스의 최신 상태 목록을 반환합니다.

        처리 순서:
        1. DB 조회가 가능하면 DB 장치 상태를 우선 사용합니다.
        2. DB에 없는 메모리 기본 장치는 결과에 추가합니다.
        3. DB 조회 실패 시 메모리 장치 전체를 반환합니다.

        이를 통해 DB 초기화가 생략된 환경에서도 fan_1이
        장치 목록에서 누락되지 않도록 합니다.
        """

        if db:
            try:
                db_devices = db.get_all_devices()

                if db_devices is not None:

                    # DB 장치 목록
                    result = list(db_devices)

                    # 이미 DB에서 반환된 장치 ID
                    existing_ids = set()

                    for device in db_devices:

                        device_id = device.get("id")

                        if not device_id:
                            continue

                        existing_ids.add(device_id)

                        # DB 상태를 메모리에도 동기화
                        self._devices[device_id] = device

                    # DB에 없는 메모리 기본 장치 추가
                    for device_id, device in self._devices.items():

                        if device_id not in existing_ids:
                            result.append(device)

                    return result

            except Exception as exc:

                logger.warning(
                    "DB get_all_devices failed, "
                    f"fallback to memory: {exc}"
                )

        # DB 연결이 없거나 조회에 실패한 경우
        return list(self._devices.values())