import hmac
import logging
import os
import secrets
import time
from math import ceil
from typing import Any, Dict, Optional

from fastapi import Header, HTTPException, status

logger = logging.getLogger("backend.auth")


def _same_secret(given: str, expected: str) -> bool:
    """두 비밀 문자열을 타이밍 공격에 안전하게 비교한다."""
    return hmac.compare_digest(
        given.encode("utf-8"),
        expected.encode("utf-8"),
    )


def verify_device_api_key(
    x_device_api_key: Optional[str] = Header(None, alias="X-Device-Api-Key")
) -> str:
    """
    디바이스향(라즈베리파이, 비전 클라이언트) 엔드포인트 전용 인증 미들웨어.
    """
    server_key = os.getenv("DEVICE_API_KEY", "")

    if not server_key:
        logger.error("DEVICE_API_KEY is not configured in environment variables.")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "SERVER_MISCONFIGURED",
                "message": "서버 인증 키가 설정되지 않았습니다.",
            },
        )

    if not x_device_api_key or not _same_secret(x_device_api_key, server_key):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "INVALID_DEVICE_KEY",
                "message": "유효하지 않은 X-Device-Api-Key 입니다.",
            },
        )

    return x_device_api_key


def verify_user_auth(
    authorization: Optional[str] = Header(None, alias="Authorization")
) -> Dict[str, Any]:
    """
    사용자향(대시보드 프론트엔드) 엔드포인트 전용 인증 미들웨어.
    """
    require_auth = (
        os.getenv("REQUIRE_USER_AUTH", "false").strip().lower() == "true"
    )

    if require_auth:
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={
                    "code": "MISSING_TOKEN",
                    "message": "Authorization Bearer 토큰이 필요합니다.",
                },
            )

        # 추후 Supabase JWT 서명 검증 로직
        token = authorization.split(" ")[1]
        return {
            "sub": "authenticated_user",
            "token": token,
            "role": "authenticated",
        }

    return {"sub": "anonymous", "role": "anonymous"}


# ==============================================================================
# 관리자 인증
# ==============================================================================

DEFAULT_ADMIN_PIN = "9179"

# 관리자 세션 유지 시간(초)
_DEFAULT_ADMIN_TOKEN_TTL_SEC = 3600


def _get_admin_token_ttl() -> int:
    """관리자 토큰 TTL을 읽고 유효하지 않으면 기본값을 사용한다."""
    raw_ttl = os.getenv(
        "ADMIN_TOKEN_TTL_SEC",
        str(_DEFAULT_ADMIN_TOKEN_TTL_SEC),
    ).strip()

    try:
        ttl = int(raw_ttl)
        if ttl <= 0:
            raise ValueError("TTL must be greater than zero")
        return ttl
    except (TypeError, ValueError):
        logger.warning(
            "ADMIN_TOKEN_TTL_SEC 설정이 올바르지 않습니다. "
            "기본값 3600초(1시간)를 사용합니다."
        )
        return _DEFAULT_ADMIN_TOKEN_TTL_SEC


ADMIN_TOKEN_TTL_SEC = _get_admin_token_ttl()

# {토큰: 만료시각(epoch)}
_admin_tokens: Dict[str, float] = {}


def get_admin_pin() -> str:
    """.env의 ADMIN_PIN을 반환한다."""
    pin = os.getenv("ADMIN_PIN", "").strip()

    if not pin:
        logger.warning(
            "ADMIN_PIN이 .env에 없어 기본값을 사용합니다. "
            "이 값은 저장소에 공개되어 있으니 전시 전에 반드시 변경하세요."
        )
        return DEFAULT_ADMIN_PIN

    return pin


def is_admin_pin(pin: str) -> bool:
    """입력 PIN이 관리자 PIN인지 안전하게 비교한다."""
    return _same_secret(pin, get_admin_pin())


def issue_admin_token() -> Dict[str, Any]:
    """관리자 PIN 인증에 성공했을 때 단기 토큰을 발급한다."""
    _purge_expired_tokens()

    token = secrets.token_urlsafe(32)
    _admin_tokens[token] = time.time() + ADMIN_TOKEN_TTL_SEC

    return {
        "token": token,
        "expires_in": ADMIN_TOKEN_TTL_SEC,
    }


def revoke_admin_token(token: str) -> None:
    """로그아웃 — 토큰을 즉시 폐기한다."""
    _admin_tokens.pop(token, None)


def _purge_expired_tokens() -> None:
    """만료된 토큰을 저장소에서 제거한다."""
    now = time.time()

    expired_tokens = [
        token
        for token, expires_at in _admin_tokens.items()
        if expires_at <= now
    ]

    for token in expired_tokens:
        _admin_tokens.pop(token, None)


def get_admin_token_remaining_seconds(token: Optional[str]) -> int:
    """유효한 관리자 토큰의 남은 시간을 초 단위로 반환한다."""
    if not token:
        return 0

    _purge_expired_tokens()

    expires_at = _admin_tokens.get(token)
    if expires_at is None:
        return 0

    return max(0, ceil(expires_at - time.time()))


def extend_admin_token(token: str) -> Dict[str, int]:
    """
    유효한 관리자 토큰의 만료 시간을 현재 시점부터 다시 1시간(설정 TTL)으로 갱신한다.

    만료되었거나 존재하지 않는 토큰은 연장하지 않는다.
    """
    _purge_expired_tokens()

    if token not in _admin_tokens:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "ADMIN_AUTH_REQUIRED",
                "message": "관리자 인증이 만료되었습니다. 다시 인증해 주세요.",
            },
        )

    _admin_tokens[token] = time.time() + ADMIN_TOKEN_TTL_SEC

    return {
        "expires_in": ADMIN_TOKEN_TTL_SEC,
        "remaining_seconds": ADMIN_TOKEN_TTL_SEC,
    }


def is_valid_admin_token(token: Optional[str]) -> bool:
    """토큰이 살아 있는 관리자 토큰인지 확인한다."""
    if not token:
        return False

    _purge_expired_tokens()
    return token in _admin_tokens


def verify_admin_token(
    x_admin_token: Optional[str] = Header(None, alias="X-Admin-Token")
) -> str:
    """관리자 전용 엔드포인트 인증 미들웨어."""
    _purge_expired_tokens()

    if not x_admin_token or x_admin_token not in _admin_tokens:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "ADMIN_AUTH_REQUIRED",
                "message": "관리자 인증이 필요합니다. 관리자 PIN으로 먼저 인증해 주세요.",
            },
        )

    return x_admin_token