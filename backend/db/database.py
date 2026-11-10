import json
import logging
import os
from contextlib import contextmanager
from datetime import datetime
from typing import Any, Dict, Generator, List, Optional

from dotenv import load_dotenv
import pymysql

from booth_time import today_utc_range, today_str
from pymysql.cursors import DictCursor

from . import reservation_store as memory_reservations

logger = logging.getLogger("backend.db")

# .env 로드
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(BASE_DIR, ".env"))

# ==============================================================================
# 접속 대상 결정 — 로컬 MariaDB vs Supabase(PostgreSQL)
# ==============================================================================

DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
IS_POSTGRES = bool(DATABASE_URL)

DB_HOST = os.getenv("DB_HOST", "127.0.0.1")
DB_PORT = int(os.getenv("DB_PORT", "3306"))
DB_USER = os.getenv("DB_USER", "root")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")
DB_NAME = os.getenv("DB_NAME", "smart_control")

RESERVATION_STORAGE = os.getenv("RESERVATION_STORAGE", "database").strip().lower()
USE_MEMORY_RESERVATIONS = RESERVATION_STORAGE == "memory"


def _upsert_clause(conflict_columns: str, assignments: Dict[str, str]) -> str:
    """INSERT 뒤에 붙일 UPSERT 절을 현재 DB 방언에 맞춰 만든다."""
    if IS_POSTGRES:
        sets = ", ".join(f"{col} = {expr}" for col, expr in assignments.items())
        return f"ON CONFLICT ({conflict_columns}) DO UPDATE SET {sets}"

    mysql_sets = []
    for col, expr in assignments.items():
        converted = expr
        if expr.startswith("EXCLUDED."):
            converted = f"VALUES({expr.split('.', 1)[1]})"
        mysql_sets.append(f"{col} = {converted}")

    return "ON DUPLICATE KEY UPDATE " + ", ".join(mysql_sets)


def get_db_connection(include_database: bool = True):
    """데이터베이스 커넥션을 생성하여 반환한다."""
    if IS_POSTGRES:
        import psycopg
        from psycopg.rows import dict_row

        dsn = DATABASE_URL
        if "sslmode=" not in dsn:
            dsn += ("&" if "?" in dsn else "?") + "sslmode=require"

        return psycopg.connect(
            dsn,
            row_factory=dict_row,
            autocommit=True,
        )

    return pymysql.connect(
        host=DB_HOST,
        port=DB_PORT,
        user=DB_USER,
        password=DB_PASSWORD,
        database=DB_NAME if include_database else None,
        charset="utf8mb4",
        cursorclass=DictCursor,
        autocommit=True,
        init_command="SET time_zone = '+00:00'",
    )


@contextmanager
def get_db_cursor(include_database: bool = True) -> Generator[Any, None, None]:
    """자동 리소스 관리를 위한 커서 컨텍스트 매니저."""
    conn = get_db_connection(include_database=include_database)

    try:
        with conn.cursor() as cursor:
            yield cursor
    finally:
        conn.close()


def _serialize_json(value: Any) -> Optional[str]:
    if value is None:
        return None

    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)

    return str(value)


def _deserialize_json(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except Exception:
            return value

    return value


def _format_row(row: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not row:
        return None

    formatted = dict(row)

    for key, val in formatted.items():
        if isinstance(val, datetime):
            iso = val.isoformat()
            formatted[key] = (
                iso.replace("+00:00", "Z")
                if val.tzinfo
                else iso + "Z"
            )
        elif key in ("desired_value", "current_value", "value_json", "value"):
            formatted[key] = _deserialize_json(val)

    return formatted


# ==============================================================================
# 예약 날짜·시간대 고유 제약조건 관리
# ==============================================================================

def _remove_reservation_slot_uniqueness() -> None:
    """
    reservations 테이블의 날짜·시간대 영구 UNIQUE 제약조건을 제거한다.

    예약 중복은 애플리케이션에서 reserved / active 상태를 기준으로 검사한다.

    completed / cancelled 상태가 된 시간대는 다시 예약할 수 있어야 하므로
    날짜·시간대 자체에 영구적인 UNIQUE 제약조건을 두지 않는다.

    기존 예약 데이터는 삭제하지 않는다.
    """

    if IS_POSTGRES:
        with get_db_cursor() as cursor:
            cursor.execute(
                "SELECT to_regclass('public.reservations') AS table_name"
            )
            result = cursor.fetchone()

            if not result or not result.get("table_name"):
                logger.warning(
                    "reservations 테이블이 아직 없어 UNIQUE 제약조건 확인을 건너뜁니다."
                )
                return

            cursor.execute(
                "ALTER TABLE public.reservations "
                "DROP CONSTRAINT IF EXISTS uq_date_slot"
            )

            cursor.execute(
                "DROP INDEX IF EXISTS public.uq_date_slot"
            )

        logger.info(
            "PostgreSQL 예약 날짜·시간대 영구 UNIQUE 제약조건 확인 완료."
        )

    else:
        with get_db_cursor() as cursor:
            cursor.execute(
                "SHOW INDEX FROM reservations WHERE Key_name = %s",
                ("uq_date_slot",),
            )

            indexes = cursor.fetchall()

            if indexes:
                cursor.execute(
                    "ALTER TABLE reservations DROP INDEX uq_date_slot"
                )

                logger.info(
                    "MySQL/MariaDB 예약 날짜·시간대 영구 UNIQUE 제약조건 제거 완료."
                )
            else:
                logger.info(
                    "MySQL/MariaDB 예약 날짜·시간대 영구 UNIQUE 제약조건이 없습니다."
                )


# ==============================================================================
# 초기 데이터
# ==============================================================================

def _seed_initial_rows() -> None:
    """디바이스·기본 애창곡 시드 데이터를 보장한다."""

    seed_devices = [
        ("door_lock_1", "솔레노이드 도어락", "door_lock"),
        ("relay_1", "기기 전원 릴레이", "relay"),
        ("led_1", "부스 조명 LED", "led"),
        ("speaker_1", "스피커/오디오 모듈", "speaker"),
        ("keypad_1", "4x4 비밀번호 키패드", "keypad"),
        ("pir_1", "입장 감지 센서", "pir"),
    ]

    device_query = """
        INSERT INTO devices (id, name, kind)
        VALUES (%s, %s, %s)
    """ + _upsert_clause(
        "id",
        {
            "name": "EXCLUDED.name",
            "kind": "EXCLUDED.kind",
        },
    )

    seed_songs = [
        ("다시 만나", "더윈드", 5),
        ("첫 만남은 계획대로 되지 않아", "TWS", 4),
        ("Supernova", "aespa", 3),
        ("Love wins all", "아이유", 2),
        ("Hype Boy", "NewJeans", 1),
    ]

    song_query = """
        INSERT INTO song_history (title, singer, sing_count)
        VALUES (%s, %s, %s)
    """ + _upsert_clause(
        "title, singer",
        {"sing_count": "EXCLUDED.sing_count"},
    )

    with get_db_cursor() as cursor:
        for dev in seed_devices:
            cursor.execute(device_query, dev)

        for song in seed_songs:
            cursor.execute(song_query, song)


def init_db() -> None:
    """서버 시작 시 DB 테이블과 시드 데이터를 확인한다."""

    try:
        # 메모리 예약 모드에서는 DB 초기화를 시도하지 않는다.
        if USE_MEMORY_RESERVATIONS:
            logger.info(
                "예약 메모리 저장 모드 — DB 초기화를 건너뜁니다."
            )
            return

        if IS_POSTGRES:
            logger.info(
                "PostgreSQL(Supabase) 모드 — DDL은 건너뛰고 "
                "예약 제약조건과 시드를 확인합니다."
            )

            _remove_reservation_slot_uniqueness()
            _seed_initial_rows()

            logger.info("Supabase seed data verified.")
            return

        with get_db_cursor(include_database=False) as cursor:
            cursor.execute(
                f"CREATE DATABASE IF NOT EXISTS `{DB_NAME}` "
                "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
            )

        with get_db_cursor(include_database=True) as cursor:
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS devices (
                  id VARCHAR(50) PRIMARY KEY,
                  name VARCHAR(100) NOT NULL,
                  kind VARCHAR(30) NOT NULL,
                  desired_state VARCHAR(30) NULL,
                  current_state VARCHAR(30) NULL,
                  desired_value JSON NULL,
                  current_value JSON NULL,
                  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
            """)

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS sensor_readings (
                  id INT AUTO_INCREMENT PRIMARY KEY,
                  device_id VARCHAR(50) NOT NULL,
                  value DOUBLE NULL,
                  unit VARCHAR(30) NULL,
                  value_json JSON NULL,
                  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
                );
            """)

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS control_log (
                  id INT AUTO_INCREMENT PRIMARY KEY,
                  device_id VARCHAR(50) NOT NULL,
                  action VARCHAR(50) NOT NULL,
                  value JSON NULL,
                  actor VARCHAR(20) NOT NULL,
                  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
                );
            """)

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS vision_events (
                  id INT AUTO_INCREMENT PRIMARY KEY,
                  event_type VARCHAR(50) NOT NULL,
                  detected BOOLEAN NOT NULL DEFAULT FALSE,
                  count INT DEFAULT 0,
                  confidence FLOAT NULL,
                  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
            """)

            # 날짜·시간대 UNIQUE KEY는 생성하지 않는다.
            # 활성 예약 중복은 애플리케이션에서 검사한다.
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS reservations (
                  id INT AUTO_INCREMENT PRIMARY KEY,
                  grade INT NOT NULL,
                  department VARCHAR(50) NOT NULL,
                  student_name VARCHAR(50) NOT NULL,
                  user_count INT NOT NULL DEFAULT 1,
                  reservation_date DATE NOT NULL,
                  time_slot VARCHAR(20) NOT NULL,
                  pin_code VARCHAR(4) NOT NULL,
                  status VARCHAR(20) NOT NULL DEFAULT 'reserved',
                  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                  started_at DATETIME NULL
                );
            """)

            cursor.execute(
                "SHOW COLUMNS FROM reservations LIKE 'started_at'"
            )

            if not cursor.fetchone():
                cursor.execute(
                    "ALTER TABLE reservations ADD COLUMN started_at DATETIME NULL"
                )

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS song_history (
                  id INT AUTO_INCREMENT PRIMARY KEY,
                  title VARCHAR(100) NOT NULL,
                  singer VARCHAR(100) NOT NULL,
                  sing_count INT NOT NULL DEFAULT 1,
                  last_sung_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                  UNIQUE KEY uq_title_singer (title, singer)
                );
            """)

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS song_videos (
                  song_id VARCHAR(64) PRIMARY KEY,
                  video_id VARCHAR(32) NOT NULL,
                  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
            """)

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS score_records (
                  id INT AUTO_INCREMENT PRIMARY KEY,
                  nickname VARCHAR(20) NOT NULL DEFAULT '익명',
                  title VARCHAR(100) NOT NULL,
                  singer VARCHAR(100) NOT NULL,
                  score INT NOT NULL,
                  rank_label VARCHAR(20),
                  pitch INT,
                  timing INT,
                  volume INT,
                  expression INT,
                  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                  INDEX idx_score (score DESC),
                  INDEX idx_created (created_at DESC)
                );
            """)

        # 기존 DB에 남아 있는 날짜·시간대 영구 UNIQUE 제약조건 제거
        _remove_reservation_slot_uniqueness()

        _seed_initial_rows()

        logger.info(
            f"Database '{DB_NAME}' initialized successfully "
            "with devices, reservations, and songs."
        )

    except Exception as exc:
        logger.error(f"Failed to initialize database: {exc}")
        raise


# ==============================================================================
# 디바이스 조회 및 상태 관리 헬퍼 함수
# ==============================================================================

def get_all_devices() -> List[Dict[str, Any]]:
    with get_db_cursor() as cursor:
        cursor.execute("SELECT * FROM devices ORDER BY id ASC")
        return [_format_row(row) for row in cursor.fetchall()]  # type: ignore


def get_device(device_id: str) -> Optional[Dict[str, Any]]:
    with get_db_cursor() as cursor:
        cursor.execute(
            "SELECT * FROM devices WHERE id = %s",
            (device_id,),
        )
        return _format_row(cursor.fetchone())


def update_desired_state(
    device_id: str,
    desired_state: str,
    desired_value: Optional[Any] = None,
) -> bool:
    serialized_val = _serialize_json(desired_value)

    with get_db_cursor() as cursor:
        cursor.execute(
            """
            UPDATE devices
            SET desired_state = %s, desired_value = %s
            WHERE id = %s
            """,
            (desired_state, serialized_val, device_id),
        )
        return cursor.rowcount > 0


def update_current_state(
    device_id: str,
    current_state: str,
    current_value: Optional[Any] = None,
) -> bool:
    serialized_val = _serialize_json(current_value)

    with get_db_cursor() as cursor:
        cursor.execute(
            """
            UPDATE devices
            SET current_state = %s, current_value = %s
            WHERE id = %s
            """,
            (current_state, serialized_val, device_id),
        )
        return cursor.rowcount > 0


# ==============================================================================
# 로그 기록 및 히스토리 조회 헬퍼 함수
# ==============================================================================

def log_sensor_reading(
    device_id: str,
    value: Optional[float] = None,
    unit: Optional[str] = None,
    value_json: Optional[Dict[str, Any]] = None,
) -> None:
    serialized_json = _serialize_json(value_json)

    with get_db_cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO sensor_readings (device_id, value, unit, value_json)
            VALUES (%s, %s, %s, %s)
            """,
            (device_id, value, unit, serialized_json),
        )


def log_control_action(
    device_id: str,
    action: str,
    value: Optional[Any] = None,
    actor: str = "user",
) -> None:
    serialized_val = _serialize_json(value)

    with get_db_cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO control_log (device_id, action, value, actor)
            VALUES (%s, %s, %s, %s)
            """,
            (device_id, action, serialized_val, actor),
        )


def get_sensor_history(
    device_id: str,
    limit: int = 50,
) -> List[Dict[str, Any]]:
    with get_db_cursor() as cursor:
        cursor.execute(
            """
            SELECT * FROM sensor_readings
            WHERE device_id = %s
            ORDER BY created_at DESC
            LIMIT %s
            """,
            (device_id, limit),
        )
        return [_format_row(row) for row in cursor.fetchall()]  # type: ignore


def get_control_history(
    device_id: Optional[str] = None,
    limit: int = 50,
) -> List[Dict[str, Any]]:
    with get_db_cursor() as cursor:
        if device_id:
            cursor.execute(
                """
                SELECT * FROM control_log
                WHERE device_id = %s
                ORDER BY created_at DESC
                LIMIT %s
                """,
                (device_id, limit),
            )
        else:
            cursor.execute(
                """
                SELECT * FROM control_log
                ORDER BY created_at DESC
                LIMIT %s
                """,
                (limit,),
            )

        return [_format_row(row) for row in cursor.fetchall()]  # type: ignore


def log_vision_event(
    event_type: str,
    detected: bool = False,
    count: int = 0,
    confidence: Optional[float] = None,
) -> None:
    with get_db_cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO vision_events (event_type, detected, count, confidence)
            VALUES (%s, %s, %s, %s)
            """,
            (event_type, detected, count, confidence),
        )


def get_recent_vision_events(limit: int = 20) -> List[Dict[str, Any]]:
    with get_db_cursor() as cursor:
        cursor.execute(
            """
            SELECT * FROM vision_events
            ORDER BY created_at DESC
            LIMIT %s
            """,
            (limit,),
        )
        return [_format_row(row) for row in cursor.fetchall()]  # type: ignore


# ==============================================================================
# 예약(F-01, F-02) 헬퍼 함수
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
    신규 예약을 등록한다.

    메모리 모드에서는 reservation_store에 위임한다.
    DB 모드에서는 reserved / active 상태의 중복 예약을 검사한다.
    """

    if USE_MEMORY_RESERVATIONS:
        return memory_reservations.create_reservation(
            grade=grade,
            department=department,
            student_name=student_name,
            user_count=user_count,
            reservation_date=reservation_date,
            time_slot=time_slot,
            pin_code=pin_code,
        )

    with get_db_cursor() as cursor:
        cursor.execute(
            """
            SELECT id
            FROM reservations
            WHERE reservation_date = %s
              AND time_slot = %s
              AND status IN ('reserved', 'active')
            ORDER BY created_at ASC, id ASC
            LIMIT 1
            """,
            (reservation_date, time_slot),
        )

        if cursor.fetchone():
            raise ValueError("이미 해당 날짜와 시간대에 예약이 존재합니다.")

        cursor.execute(
            """
            INSERT INTO reservations (
              grade, department, student_name, user_count,
              reservation_date, time_slot, pin_code, status
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, 'reserved')
            """ + (" RETURNING id" if IS_POSTGRES else ""),
            (
                grade,
                department,
                student_name,
                user_count,
                reservation_date,
                time_slot,
                pin_code,
            ),
        )

        new_id = (
            cursor.fetchone()["id"]
            if IS_POSTGRES
            else cursor.lastrowid
        )

        cursor.execute(
            "SELECT * FROM reservations WHERE id = %s",
            (new_id,),
        )

        return _format_row(cursor.fetchone()) or {}


def get_reservations(limit: int = 50) -> List[Dict[str, Any]]:
    """전체 예약 목록을 조회한다."""

    if USE_MEMORY_RESERVATIONS:
        return memory_reservations.get_reservations(limit=limit)

    with get_db_cursor() as cursor:
        cursor.execute(
            """
            SELECT * FROM reservations
            ORDER BY reservation_date DESC, time_slot ASC, id ASC
            LIMIT %s
            """,
            (limit,),
        )

        return [_format_row(row) for row in cursor.fetchall()]  # type: ignore


def get_reservations_by_pin(pin_code: str) -> List[Dict[str, Any]]:
    """4자리 PIN으로 아직 사용하지 않은 예약을 조회한다."""

    if USE_MEMORY_RESERVATIONS:
        return memory_reservations.get_reservations_by_pin(pin_code)

    with get_db_cursor() as cursor:
        cursor.execute(
            """
            SELECT * FROM reservations
            WHERE pin_code = %s AND status = 'reserved'
            ORDER BY reservation_date ASC, id ASC
            """,
            (pin_code,),
        )

        return [
            _format_row(r)
            for r in (cursor.fetchall() or [])
        ]  # type: ignore


def get_reservations_on(reservation_date: str) -> List[Dict[str, Any]]:
    """특정 날짜의 예약을 조회한다."""

    if USE_MEMORY_RESERVATIONS:
        return memory_reservations.get_reservations_on(reservation_date)

    with get_db_cursor() as cursor:
        cursor.execute(
            """
            SELECT * FROM reservations
            WHERE reservation_date = %s
            ORDER BY time_slot ASC, created_at ASC, id ASC
            """,
            (reservation_date,),
        )

        return [
            _format_row(r)
            for r in (cursor.fetchall() or [])
        ]  # type: ignore


def get_today_reservation_queue() -> List[Dict[str, Any]]:
    """
    오늘 날짜의 예약만 접수 순서대로 반환한다.

    - 예약 날짜가 오늘인 예약만 조회한다.
    - 미래 및 과거 예약은 반환하지 않는다.
    - 예약 데이터를 삭제하거나 변경하지 않는다.
    - created_at이 빠른 예약부터 대기열에 배치한다.
    - 접수 시각이 같으면 id가 작은 예약을 먼저 배치한다.
    - 모든 상태의 예약을 반환한다.
    """

    if USE_MEMORY_RESERVATIONS:
        return memory_reservations.get_today_reservation_queue()

    current_date = today_str()

    with get_db_cursor() as cursor:
        cursor.execute(
            """
            SELECT *
            FROM reservations
            WHERE reservation_date = %s
            ORDER BY created_at ASC, id ASC
            """,
            (current_date,),
        )

        return [
            _format_row(r)
            for r in (cursor.fetchall() or [])
        ]  # type: ignore


def find_live_reservation(
    reservation_date: str,
    time_slot: str,
) -> Optional[Dict[str, Any]]:
    """
    같은 날짜·시간대에 reserved 또는 active 상태인 예약을 조회한다.

    completed / cancelled 상태의 예약은 중복으로 취급하지 않는다.
    """

    if USE_MEMORY_RESERVATIONS:
        return memory_reservations.find_live_reservation(
            reservation_date,
            time_slot,
        )

    with get_db_cursor() as cursor:
        cursor.execute(
            """
            SELECT * FROM reservations
            WHERE reservation_date = %s
              AND time_slot = %s
              AND status IN ('reserved', 'active')
            ORDER BY created_at ASC, id ASC
            LIMIT 1
            """,
            (reservation_date, time_slot),
        )

        return _format_row(cursor.fetchone())


def get_active_reservations() -> List[Dict[str, Any]]:
    """예약 날짜와 관계없이 현재 active 상태인 예약을 모두 조회한다."""

    if USE_MEMORY_RESERVATIONS:
        return memory_reservations.get_active_reservations()

    with get_db_cursor() as cursor:
        cursor.execute(
            """
            SELECT * FROM reservations
            WHERE status = 'active'
            ORDER BY started_at ASC, id ASC
            """
        )

        return [
            _format_row(r)
            for r in (cursor.fetchall() or [])
        ]  # type: ignore


def update_reservation_status(
    reservation_id: int,
    status: str,
) -> bool:
    """
    예약 상태를 갱신한다.

    active로 처음 바뀌는 순간 started_at을 기록한다.
    """

    allowed_statuses = {
        "reserved",
        "active",
        "completed",
        "cancelled",
    }

    if status not in allowed_statuses:
        raise ValueError(f"허용되지 않은 예약 상태입니다: {status}")

    if USE_MEMORY_RESERVATIONS:
        return memory_reservations.update_reservation_status(
            reservation_id,
            status,
        )

    with get_db_cursor() as cursor:
        if status == "active":
            cursor.execute(
                """
                UPDATE reservations
                SET status = %s,
                    started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
                WHERE id = %s
                """,
                (status, reservation_id),
            )
        else:
            cursor.execute(
                """
                UPDATE reservations
                SET status = %s
                WHERE id = %s
                """,
                (status, reservation_id),
            )

        return cursor.rowcount > 0


# ==============================================================================
# 노래 기록 및 나의 18번(F-05) 헬퍼 함수
# ==============================================================================

def get_all_songs() -> List[Dict[str, Any]]:
    with get_db_cursor() as cursor:
        cursor.execute(
            "SELECT * FROM song_history ORDER BY last_sung_at DESC"
        )
        return [_format_row(row) for row in cursor.fetchall()]  # type: ignore


def get_favorite_songs(min_count: int = 3) -> List[Dict[str, Any]]:
    with get_db_cursor() as cursor:
        cursor.execute(
            """
            SELECT * FROM song_history
            WHERE sing_count >= %s
            ORDER BY sing_count DESC, last_sung_at DESC
            """,
            (min_count,),
        )
        return [_format_row(row) for row in cursor.fetchall()]  # type: ignore


def record_song(title: str, singer: str) -> Dict[str, Any]:
    with get_db_cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO song_history (title, singer, sing_count)
            VALUES (%s, %s, 1)
            """ + _upsert_clause(
                "title, singer",
                {"sing_count": "song_history.sing_count + 1"},
            ),
            (title, singer),
        )

        cursor.execute(
            """
            SELECT * FROM song_history
            WHERE title = %s AND singer = %s
            """,
            (title, singer),
        )

        return _format_row(cursor.fetchone()) or {}


# ==============================================================================
# 예약 PIN 관리
# ==============================================================================

def pins_in_use(issued_on: str) -> List[str]:
    """
    현재 사용 중인 예약 PIN 목록을 반환한다.

    체험권 대기열 PIN은 조회하지 않는다.
    """

    if USE_MEMORY_RESERVATIONS:
        return memory_reservations.pins_in_use(issued_on)

    with get_db_cursor() as cursor:
        cursor.execute(
            """
            SELECT pin_code
            FROM reservations
            WHERE status IN ('reserved', 'active')
            """
        )

        return [
            str(r["pin_code"])
            for r in (cursor.fetchall() or [])
        ]


# ==============================================================================
# 점수 기록과 랭킹 (부록G §2-④)
# ==============================================================================

def record_score(
    nickname: str,
    title: str,
    singer: str,
    score: int,
    rank_label: Optional[str] = None,
    pitch: Optional[int] = None,
    timing: Optional[int] = None,
    volume: Optional[int] = None,
    expression: Optional[int] = None,
) -> Dict[str, Any]:
    with get_db_cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO score_records
              (nickname, title, singer, score, rank_label, pitch, timing, volume, expression)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """ + (" RETURNING id" if IS_POSTGRES else ""),
            (
                nickname,
                title,
                singer,
                score,
                rank_label,
                pitch,
                timing,
                volume,
                expression,
            ),
        )

        new_id = (
            cursor.fetchone()["id"]
            if IS_POSTGRES
            else cursor.lastrowid
        )

        cursor.execute(
            "SELECT * FROM score_records WHERE id = %s",
            (new_id,),
        )

        return _format_row(cursor.fetchone()) or {}


def get_top_scores(
    period: str = "today",
    limit: Optional[int] = 5,
    title: Optional[str] = None,
    best_per_name: bool = False,
) -> List[Dict[str, Any]]:
    conds: List[str] = []
    params: List[Any] = []

    if period == "today":
        start, end = today_utc_range()

        if not IS_POSTGRES:
            start = start.replace(tzinfo=None)
            end = end.replace(tzinfo=None)

        conds.append("created_at >= %s AND created_at < %s")
        params += [start, end]

    if title:
        conds.append("title = %s")
        params.append(title)

    where = (
        "WHERE " + " AND ".join(conds)
        if conds
        else ""
    )

    query = (
        f"SELECT * FROM score_records {where} "
        "ORDER BY score DESC, created_at ASC, id ASC"
    )

    if limit is not None and not best_per_name:
        query += " LIMIT %s"
        params.append(limit)

    with get_db_cursor() as cursor:
        cursor.execute(query, tuple(params))
        rows = [
            _format_row(r)
            for r in (cursor.fetchall() or [])
        ]

    if best_per_name:
        seen = set()
        kept = []

        for row in rows:
            name = str(row.get("nickname") or "익명").strip()

            if name != "익명":
                if name in seen:
                    continue
                seen.add(name)

            kept.append(row)

        rows = kept if limit is None else kept[:limit]

    return rows


def get_recent_scores(limit: int = 10) -> List[Dict[str, Any]]:
    with get_db_cursor() as cursor:
        cursor.execute(
            """
            SELECT * FROM score_records
            ORDER BY created_at DESC
            LIMIT %s
            """,
            (limit,),
        )

        return [
            _format_row(r)
            for r in (cursor.fetchall() or [])
        ]  # type: ignore


# ==============================================================================
# 노래방 영상 등록 (F-06)
# ==============================================================================

def get_song_videos() -> Dict[str, str]:
    with get_db_cursor() as cursor:
        cursor.execute(
            "SELECT song_id, video_id FROM song_videos"
        )

        rows = cursor.fetchall() or []

        return {
            row["song_id"]: row["video_id"]
            for row in rows
        }


def set_song_video(
    song_id: str,
    video_id: str,
) -> Dict[str, Any]:
    query = """
        INSERT INTO song_videos (song_id, video_id)
        VALUES (%s, %s)
    """ + _upsert_clause(
        "song_id",
        {"video_id": "EXCLUDED.video_id"},
    )

    with get_db_cursor() as cursor:
        cursor.execute(query, (song_id, video_id))

    return {
        "song_id": song_id,
        "video_id": video_id,
    }


def delete_song_video(song_id: str) -> bool:
    with get_db_cursor() as cursor:
        cursor.execute(
            "DELETE FROM song_videos WHERE song_id = %s",
            (song_id,),
        )

    return True