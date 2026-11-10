"""
관리자 인증 라우터 (부록G §3-4)

관리자 PIN을 넣으면 단기 토큰을 돌려주고, 이후 기기 제어·시나리오 강제 실행
엔드포인트는 그 토큰을 요구한다. 학생·관람객이 쓰는 예약 신청, 키패드 인증,
노래 기록에는 걸지 않는다.
"""

import logging
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from auth import (
    extend_admin_token,
    get_admin_token_remaining_seconds,
    is_admin_pin,
    issue_admin_token,
    revoke_admin_token,
    verify_admin_token,
)
from login_guard import admin_login_guard, client_key

logger = logging.getLogger("backend.routers.admin")

admin_router = APIRouter(prefix="/api/admin", tags=["admin"])


class AdminLoginRequest(BaseModel):
    """관리자 PIN 인증 요청"""
    pin: str = Field(
        ...,
        min_length=4,
        max_length=32,
        description="관리자 PIN (.env의 ADMIN_PIN)",
    )


@admin_router.post("/login")
async def admin_login(
    req: AdminLoginRequest,
    request: Request,
) -> Dict[str, Any]:
    """관리자 PIN을 검증하고 단기 토큰을 발급합니다."""
    key = client_key(request)
    admin_login_guard.check(key)

    if not is_admin_pin(req.pin):
        admin_login_guard.fail(key)
        logger.warning("Admin login attempt failed.")

        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "INVALID_ADMIN_PIN",
                "message": "관리자 PIN이 올바르지 않습니다.",
            },
        )

    admin_login_guard.succeed(key)
    logger.info("Admin authenticated.")

    return {"data": issue_admin_token()}


@admin_router.post("/logout")
async def admin_logout(
    token: str = Depends(verify_admin_token),
) -> Dict[str, Any]:
    """관리자 토큰을 즉시 폐기합니다."""
    revoke_admin_token(token)

    return {
        "data": {
            "success": True,
            "message": "관리자 세션이 종료되었습니다.",
        }
    }


@admin_router.get("/session")
async def admin_session(
    token: str = Depends(verify_admin_token),
) -> Dict[str, Any]:
    """관리자 세션 유효 여부와 남은 시간을 반환합니다."""
    remaining_seconds = get_admin_token_remaining_seconds(token)

    if remaining_seconds <= 0:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "ADMIN_AUTH_REQUIRED",
                "message": "관리자 인증이 만료되었습니다. 다시 인증해 주세요.",
            },
        )

    return {
        "data": {
            "valid": True,
            "remaining_seconds": remaining_seconds,
        }
    }


@admin_router.post("/session/extend")
async def admin_session_extend(
    token: str = Depends(verify_admin_token),
) -> Dict[str, Any]:
    """현재 관리자 토큰의 만료 시간을 다시 1시간으로 갱신합니다."""
    result = extend_admin_token(token)

    logger.info("Admin session extended.")

    return {"data": result}