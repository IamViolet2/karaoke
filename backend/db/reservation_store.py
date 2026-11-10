
"""
예약 메모리 저장소

개인 노트북처럼 MySQL/MariaDB 서버가 없는 환경에서
예약 기능을 테스트하기 위한 임시 저장소입니다.

RESERVATION_STORAGE=memory 일 때 사용합니다.

학교 환경에서는 RESERVATION_STORAGE=mysql 로 설정하면
기존 database.py의 MySQL/MariaDB 저장 기능을 사용합니다.

주의:
- 메모리 저장 데이터는 백엔드 서버를 재시작하면 사라집니다.
- 이 파일은 예약 데이터만 관리합니다.
- 기기 상태, 노래 기록, 점수 기록 등은 기존 DB 기능을 유지합니다.
"""

import threading
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from booth_time import today_str


# ==============================================================================
# 메모리 저장소
# ==============================================================================

_reservations: List[Dict[str, Any]] = []
_next_reservation_id = 1

_lock = threading.RLock()


def _now_iso() -> str:
    """현재 UTC 시각을 ISO-8601 문자열로 반환합니다."""
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _copy_reservation(reservation: Dict[str, Any]) -> Dict[str, Any]:
    """내부 데이터가 외부에서 직접 수정되지 않도록 복사본을 반환합니다."""
    return dict(reservation)


# ==============================================================================
# 예약 생성 및 조회
# ==============================================================================

def create_reservation(
    grade: int,
    department: str,
    student_name: str,
    user_count: int,
    reservation_date: str,
    time_slot: str,
    pin_code: str,
) -> Dict[str, Any]:
    """
    신규 예약을 메모리에 등록합니다.

    같은 날짜와 시간대에 reserved 또는 active 상태의 예약이
    이미 존재하면 신규 예약을 거부합니다.

    completed 또는 cancelled 상태의 예약은
    새 예약을 막지 않습니다.
    """

    global _next_reservation_id

    with _lock:
        duplicate = any(
            reservation["reservation_date"] == reservation_date
            and reservation["time_slot"] == time_slot
            and reservation["status"] in ("reserved", "active")
            for reservation in _reservations
        )

        if duplicate:
            raise ValueError("이미 해당 날짜와 시간대에 예약이 존재합니다.")

        now = _now_iso()

        reservation = {
            "id": _next_reservation_id,
            "grade": grade,
            "department": department,
            "student_name": student_name,
            "user_count": user_count,
            "reservation_date": reservation_date,
            "time_slot": time_slot,
            "pin_code": pin_code,
            "status": "reserved",
            "created_at": now,
            "started_at": None,
        }

        _reservations.append(reservation)
        _next_reservation_id += 1

        return _copy_reservation(reservation)


def get_reservations(limit: int = 50) -> List[Dict[str, Any]]:
    """전체 예약 목록을 최신 예약 날짜 순으로 반환합니다."""

    with _lock:
        rows = sorted(
            _reservations,
            key=lambda item: (
                item["reservation_date"],
                item["time_slot"],
                item["id"],
            ),
            reverse=True,
        )

        return [_copy_reservation(row) for row in rows[:limit]]


def get_reservations_by_pin(pin_code: str) -> List[Dict[str, Any]]:
    """
    PIN 코드로 아직 사용하지 않은 예약을 조회합니다.

    status가 reserved인 예약만 반환하므로
    인증에 성공해 active로 변경된 PIN은 다시 사용할 수 없습니다.
    """

    with _lock:
        rows = [
            reservation
            for reservation in _reservations
            if reservation["pin_code"] == pin_code
            and reservation["status"] == "reserved"
        ]

        rows.sort(
            key=lambda item: (
                item["reservation_date"],
                item["id"],
            )
        )

        return [_copy_reservation(row) for row in rows]


def get_reservations_on(reservation_date: str) -> List[Dict[str, Any]]:
    """특정 날짜의 예약 목록을 반환합니다."""

    with _lock:
        rows = [
            reservation
            for reservation in _reservations
            if reservation["reservation_date"] == reservation_date
        ]

        rows.sort(
            key=lambda item: (
                item["time_slot"],
                item["id"],
            )
        )

        return [_copy_reservation(row) for row in rows]


def get_today_reservation_queue() -> List[Dict[str, Any]]:
    """
    오늘 날짜의 예약만 대기열 형태로 반환합니다.

    - 미래 날짜와 과거 날짜의 예약은 포함하지 않습니다.
    - 예약 데이터 자체는 삭제하지 않습니다.
    - 예약 접수 시각(created_at)을 기준으로 FIFO 순서를 유지합니다.
    - 예약 상태(reserved, active, completed, cancelled)는 그대로 반환합니다.
    """

    current_date = today_str()

    with _lock:
        rows = [
            reservation
            for reservation in _reservations
            if reservation["reservation_date"] == current_date
        ]

        rows.sort(
            key=lambda item: (
                item.get("created_at") or "",
                item["id"],
            )
        )

        return [_copy_reservation(row) for row in rows]


def get_active_reservations() -> List[Dict[str, Any]]:
    """현재 이용 중인 모든 예약을 날짜와 관계없이 반환합니다."""

    with _lock:
        rows = [
            reservation
            for reservation in _reservations
            if reservation["status"] == "active"
        ]

        rows.sort(
            key=lambda item: (
                item.get("started_at") or "",
                item["id"],
            )
        )

        return [_copy_reservation(row) for row in rows]


def find_live_reservation(
    reservation_date: str,
    time_slot: str,
) -> Optional[Dict[str, Any]]:
    """
    같은 날짜와 시간대에 reserved 또는 active 상태인 예약을 찾습니다.

    completed 또는 cancelled 상태의 예약은 반환하지 않습니다.
    """

    with _lock:
        rows = [
            reservation
            for reservation in _reservations
            if (
                reservation["reservation_date"] == reservation_date
                and reservation["time_slot"] == time_slot
                and reservation["status"] in ("reserved", "active")
            )
        ]

        if not rows:
            return None

        rows.sort(
            key=lambda item: (
                item.get("created_at") or "",
                item["id"],
            )
        )

        return _copy_reservation(rows[0])


# ==============================================================================
# 예약 상태 관리
# ==============================================================================

def update_reservation_status(
    reservation_id: int,
    status: str,
) -> bool:
    """
    예약 상태를 변경합니다.

    active로 변경되는 순간 실제 입장 시각(started_at)을 기록합니다.
    따라서 예약 날짜나 예약 시간대가 아니라 실제 입장 시각을 기준으로
    이용 시간을 계산할 수 있습니다.
    """

    allowed_statuses = {
        "reserved",
        "active",
        "completed",
        "cancelled",
    }

    if status not in allowed_statuses:
        raise ValueError(f"허용되지 않은 예약 상태입니다: {status}")

    with _lock:
        for reservation in _reservations:
            if reservation["id"] != reservation_id:
                continue

            reservation["status"] = status

            if status == "active" and not reservation.get("started_at"):
                reservation["started_at"] = _now_iso()

            return True

        return False


# ==============================================================================
# PIN 관리
# ==============================================================================

def pins_in_use(issued_on: str) -> List[str]:
    """
    현재 사용 중인 예약 PIN 목록을 반환합니다.

    issued_on 인자는 기존 database.py 함수와의 호환성을 위해 유지합니다.
    """

    with _lock:
        return [
            str(reservation["pin_code"])
            for reservation in _reservations
            if reservation["status"] in ("reserved", "active")
        ]


# ==============================================================================
# 테스트 및 상태 확인
# ==============================================================================

def clear_all_reservations() -> None:
    """
    개발 테스트용 전체 예약 초기화 함수입니다.

    일반적인 예약 흐름에서는 호출하지 않습니다.
    """

    global _next_reservation_id

    with _lock:
        _reservations.clear()
        _next_reservation_id = 1


def get_storage_info() -> Dict[str, Any]:
    """현재 메모리 저장소의 상태를 반환합니다."""

    with _lock:
        return {
            "storage": "memory",
            "reservation_count": len(_reservations),
            "active_count": sum(
                1
                for reservation in _reservations
                if reservation["status"] == "active"
            ),
            "today_count": sum(
                1
                for reservation in _reservations
                if reservation["reservation_date"] == today_str()
            ),
        }
