from contextlib import asynccontextmanager
import logging
import os
import sys

# ==============================================================================
# sys.path 자동 경로 주입 (어느 디렉토리에서 실행하든 절대/상대 경로 임포트 오류 방지)
# ==============================================================================
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
PARENT_DIR = os.path.dirname(CURRENT_DIR)

if CURRENT_DIR not in sys.path:
    sys.path.insert(0, CURRENT_DIR)

if PARENT_DIR not in sys.path:
    sys.path.insert(0, PARENT_DIR)

from typing import Any, Dict, List

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from routers.admin import admin_router
from routers.devices import user_router, device_router
from routers.reservations import (
    reservations_router,
    booth_router,
    songs_router,
    videos_router,
    scores_router,
    scheduler_router,
)
from websocket_manager import ws_manager

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("backend.main")

# CORS 허용 출처 — 코드에 하드코딩하지 않고 .env로 관리한다.
DEFAULT_ALLOWED_ORIGINS = "http://localhost:3000,http://127.0.0.1:3000"


def get_allowed_origins() -> List[str]:
    """.env의 CORS_ALLOW_ORIGINS를 파싱해 허용 출처 목록을 반환합니다."""
    raw = os.getenv("CORS_ALLOW_ORIGINS", DEFAULT_ALLOWED_ORIGINS)
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


@asynccontextmanager
async def lifespan(app: FastAPI):
    """서버 시작 및 종료 라이프사이클 이벤트 관리"""

    # 1. 서버 시작 시 DB 및 디바이스 시드 데이터 검증/초기화 시도
    try:
        from db.database import init_db

        init_db()
        logger.info("Database and seed data successfully initialized at startup.")

    except Exception as exc:
        logger.warning(
            f"DB initialization at startup skipped/failed (MariaDB connection check): {exc}"
        )

    # 2. 예약 시간 자동 운영 엔진 시작
    from services import scheduler

    scheduler.start()

    yield

    await scheduler.stop()
    logger.info("Backend server shutting down.")


app = FastAPI(
    title="Smart IoT Karaoke Control System API",
    version="1.0.0",
    description="웹 예약 연동 자동화 학교 노래방 부스 관리 시스템 백엔드 API",
    lifespan=lifespan,
)

# ==============================================================================
# CORS 설정
# ==============================================================================

app.add_middleware(
    CORSMiddleware,
    allow_origins=get_allowed_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ==============================================================================
# 공통 에러 핸들러
# ==============================================================================

@app.exception_handler(HTTPException)
async def custom_http_exception_handler(
    request: Request,
    exc: HTTPException,
):
    detail = exc.detail

    # 예외에 실린 헤더(예: 429의 Retry-After)도 그대로 돌려준다.
    headers = getattr(exc, "headers", None)

    if isinstance(detail, dict) and "code" in detail and "message" in detail:
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": detail},
            headers=headers,
        )

    return JSONResponse(
        status_code=exc.status_code,
        content={
            "error": {
                "code": f"HTTP_{exc.status_code}",
                "message": str(detail),
            }
        },
        headers=headers,
    )


# 입력 검증 오류를 사람이 읽을 수 있는 말로 바꾼다.
_FIELD_LABELS = {
    "grade": "학년",
    "department": "학과",
    "student_name": "이름",
    "user_count": "이용 인원",
    "reservation_date": "예약 날짜",
    "time_slot": "시간대",
    "pin": "비밀번호",
    "nickname": "이름",
    "title": "곡 제목",
    "singer": "가수",
    "score": "점수",
    "video_id": "영상 ID",
    "desired_state": "목표 상태",
}


def _josa(word: str, with_batchim: str, without: str) -> str:
    """받침 유무에 맞는 조사를 붙인다."""
    last = word[-1] if word else ""

    if "가" <= last <= "힣":
        return word + (
            with_batchim if (ord(last) - 0xAC00) % 28 else without
        )

    return word + with_batchim


def _friendly_validation_message(err: Dict[str, Any]) -> str:
    loc = [
        str(x)
        for x in err.get("loc", ())
        if x not in ("body", "query", "path")
    ]

    field = _FIELD_LABELS.get(loc[-1], loc[-1]) if loc else "입력값"
    kind = str(err.get("type", ""))
    ctx = err.get("ctx") or {}

    if kind == "missing":
        return f"{_josa(field, '을', '를')} 입력해 주세요."

    if kind == "string_too_short":
        return f"{_josa(field, '은', '는')} {ctx.get('min_length')}자 이상이어야 합니다."

    if kind == "string_too_long":
        return f"{_josa(field, '은', '는')} {ctx.get('max_length')}자 이하여야 합니다."

    if kind == "greater_than_equal":
        return f"{_josa(field, '은', '는')} {ctx.get('ge')} 이상이어야 합니다."

    if kind == "less_than_equal":
        return f"{_josa(field, '은', '는')} {ctx.get('le')} 이하여야 합니다."

    if kind == "string_pattern_mismatch":
        return f"{field} 형식이 올바르지 않습니다."

    if kind.startswith("int_"):
        return f"{_josa(field, '은', '는')} 숫자여야 합니다."

    return f"{field} 값이 올바르지 않습니다."


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(
    request: Request,
    exc: RequestValidationError,
):
    errors = exc.errors()

    logger.info(
        f"Validation error on {request.url.path}: {errors}"
    )

    message = (
        _friendly_validation_message(errors[0])
        if errors
        else "입력값이 올바르지 않습니다."
    )

    return JSONResponse(
        status_code=422,
        content={
            "error": {
                "code": "VALIDATION_ERROR",
                "message": message,
            }
        },
    )


# ==============================================================================
# 라우터 등록
# ==============================================================================

app.include_router(admin_router)
app.include_router(user_router)
app.include_router(device_router)

app.include_router(reservations_router)
app.include_router(booth_router)
app.include_router(songs_router)
app.include_router(videos_router)
app.include_router(scores_router)
app.include_router(scheduler_router)


# ==============================================================================
# 기본 엔드포인트
# ==============================================================================

@app.get("/health")
async def health_check() -> Dict[str, Any]:
    """백엔드 서버 헬스체크 엔드포인트"""
    return {
        "status": "ok",
        "message": "Backend server is running healthy.",
    }


@app.get("/")
async def root() -> Dict[str, Any]:
    """루트 안내 엔드포인트"""
    return {
        "message": "Smart IoT Karaoke Booth Management Backend is active.",
        "docs_url": "/docs",
        "health_url": "/health",
    }


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    """실시간 디바이스 상태 스트리밍용 WebSocket 엔드포인트"""

    await ws_manager.connect(websocket)

    try:
        while True:
            # 대시보드는 주로 수신만 하지만, 연결 유지를 위해 수신 대기한다.
            await websocket.receive_text()

    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)

    except Exception as exc:
        logger.warning(
            f"WebSocket connection closed with error: {exc}"
        )
        ws_manager.disconnect(websocket)