from datetime import datetime, timezone
import logging
from typing import Any, Dict, Optional

import json
import time

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from fastapi.responses import StreamingResponse

from services.vision_stream import vision_frame_store

from auth import verify_admin_token, verify_device_api_key, verify_user_auth
from db import database as db
from iot.provider_factory import get_device_provider
from schemas.device import (
    DeviceControlRequest,
    DeviceStateReportRequest,
    VisionEventRequest,
)
from websocket_manager import ws_manager

logger = logging.getLogger("backend.routers.devices")

# 1. 사용자향 라우터 (대시보드 / 프론트엔드용)
user_router = APIRouter(prefix="/api/devices", tags=["devices"])

# 2. 디바이스향 라우터 (라즈베리파이 폴링 및 비전 클라이언트용)
device_router = APIRouter(prefix="/api/v1", tags=["hardware-and-vision"])


# ==============================================================================
# [사용자향 엔드포인트] /api/devices (대시보드)
# ==============================================================================

@user_router.get("")
async def list_devices(
    _user: Dict[str, Any] = Depends(verify_user_auth)
) -> Dict[str, Any]:
    """모든 IoT 디바이스 목록 및 최신 상태 조회"""
    provider = get_device_provider()
    devices = await provider.get_all_statuses()
    return {"data": devices}


@user_router.get("/{device_id}")
async def get_device_detail(
    device_id: str,
    _user: Dict[str, Any] = Depends(verify_user_auth)
) -> Dict[str, Any]:
    """특정 디바이스 상세 상태 조회"""
    provider = get_device_provider()
    device = await provider.get_device_status(device_id)
    if not device:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "DEVICE_NOT_FOUND", "message": f"디바이스 '{device_id}'를 찾을 수 없습니다."}
        )
    return {"data": device}


@user_router.post("/{device_id}/control")
async def control_device(
    device_id: str,
    request: DeviceControlRequest,
    _admin: str = Depends(verify_admin_token)
) -> Dict[str, Any]:
    """
    액추에이터 목표 상태 제어 (도어락 해제, 전원 릴레이 on/off, LED 점등 등)

    ⚠️ 관리자 전용이다. 관람객이 도어락을 열거나 남이 노래하는 중에 전원을
    끄지 못하도록 X-Admin-Token 헤더를 요구한다 (부록G §3-4).
    학생용 정상 경로는 /api/booth/verify-keypad(키패드 인증)이다.
    성공 시 WebSocket으로 낙관적 상태를 즉시 브로드캐스트합니다.
    """
    provider = get_device_provider()
    try:
        updated_device = await provider.set_actuator_state(
            device_id=device_id,
            desired_state=request.desired_state,
            value=request.value,
            operator="user"
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "DEVICE_NOT_FOUND", "message": str(exc)}
        )
    except Exception as exc:
        logger.error(f"Error controlling device {device_id}: {exc}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "CONTROL_FAILED", "message": f"디바이스 제어에 실패했습니다: {exc}"}
        )

    # 대시보드 실시간 반영 브로드캐스트
    await ws_manager.broadcast({
        "type": "device_state",
        "device_id": device_id,
        "kind": updated_device.get("kind"),
        "state": request.desired_state,
        "value": request.value,
        "actor": "user",
        "updated_at": updated_device.get("updated_at")
    })

    return {"data": updated_device}


@user_router.get("/{device_id}/history")
async def get_device_history(
    device_id: str,
    limit: int = Query(50, ge=1, le=200),
    _user: Dict[str, Any] = Depends(verify_user_auth)
) -> Dict[str, Any]:
    """디바이스의 센서 측정 이력 또는 제어 로그 히스토리 조회"""
    provider = get_device_provider()
    device = await provider.get_device_status(device_id)
    if not device:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "DEVICE_NOT_FOUND", "message": f"디바이스 '{device_id}'를 찾을 수 없습니다."}
        )

    kind = device.get("kind", "")
    history: list = []
    if kind in ("keypad", "pir"):
        history = db.get_sensor_history(device_id=device_id, limit=limit)
    else:
        history = db.get_control_history(device_id=device_id, limit=limit)

    return {"data": history}


# ==============================================================================
# [디바이스향 엔드포인트] /api/v1/... (라즈베리파이 5 & 비전 클라이언트)
# ==============================================================================

@device_router.get("/devices/{device_id}/desired-state")
async def get_desired_state(
    device_id: str,
    _key: str = Depends(verify_device_api_key)
) -> Dict[str, Any]:
    """
    라즈베리파이 5 폴링 계약: 액추에이터의 목표 상태 조회
    """
    provider = get_device_provider()
    device = await provider.get_device_status(device_id)
    if not device:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "DEVICE_NOT_FOUND", "message": "device_id를 찾을 수 없습니다"}
        )

    return {
        "data": {
            "device_id": device_id,
            "kind": device.get("kind"),
            "desired_state": device.get("desired_state"),
            "value": device.get("desired_value"),
            "updated_at": device.get("updated_at")
        }
    }


@device_router.post("/devices/{device_id}/state")
async def report_device_state(
    device_id: str,
    request: DeviceStateReportRequest,
    _key: str = Depends(verify_device_api_key)
) -> Dict[str, Any]:
    """
    라즈베리파이 5 보고 계약: 실제 반영 결과(액추에이터) 또는 측정값(센서) 보고
    DB 갱신 후 대시보드에 확정 상태를 WebSocket으로 브로드캐스트합니다.
    """
    provider = get_device_provider()
    device = await provider.get_device_status(device_id)
    if not device:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "DEVICE_NOT_FOUND", "message": "device_id를 찾을 수 없습니다"}
        )

    now_str = request.reported_at or (datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"))
    kind = device.get("kind", "")

    # 1. 액추에이터 반영 결과 보고 처리
    if request.state is not None:
        # DB가 잠깐 끊겨도 파이의 보고를 500으로 되돌려주면 안 된다.
        # 파이는 재시도 로직이 단순해서 500을 받으면 그 보고를 잃어버리고,
        # 대시보드는 영영 확정 상태를 받지 못한다. 다른 조회 엔드포인트와
        # 마찬가지로 기록만 실패하고 흐름은 계속 이어간다.
        try:
            db.update_current_state(device_id, request.state, request.value)
            db.log_control_action(device_id, request.state, request.value, actor="device")
        except Exception as exc:
            logger.warning(f"DB write failed for state report {device_id}: {exc}")
        await provider.apply_reported_state(device_id, request.state, request.value)

        await ws_manager.broadcast({
            "type": "device_state",
            "device_id": device_id,
            "kind": kind,
            "state": request.state,
            "value": request.value,
            "actor": "device",
            "updated_at": now_str
        })

    # 2. 센서 측정값 보고 처리
    elif request.value is not None or request.unit is not None:
        val_float: Optional[float] = None
        val_json: Optional[Dict[str, Any]] = None

        if isinstance(request.value, (int, float)):
            val_float = float(request.value)
        elif isinstance(request.value, dict):
            val_json = request.value

        try:
            db.log_sensor_reading(
                device_id=device_id,
                value=val_float,
                unit=request.unit,
                value_json=val_json
            )
            db.update_current_state(device_id, "reported", request.value)
        except Exception as exc:
            logger.warning(f"DB write failed for sensor report {device_id}: {exc}")

        await ws_manager.broadcast({
            "type": "sensor_reading",
            "device_id": device_id,
            "kind": kind,
            "value": request.value,
            "unit": request.unit,
            "actor": "device",
            "updated_at": now_str
        })

    return {
        "data": {
            "device_id": device_id,
            "recorded": True
        }
    }


@device_router.post("/vision/events")
async def receive_vision_event(
    request: VisionEventRequest,
    _key: str = Depends(verify_device_api_key)
) -> Dict[str, Any]:
    """
    영상인식 클라이언트(웹캠/YOLOv8)의 감지 이벤트 수신
    """
    now_str = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    # DB에 비전 이벤트 기록
    try:
        db.log_vision_event(
            event_type=request.event_type,
            detected=request.detected,
            count=request.count,
            confidence=request.confidence
        )
    except Exception as exc:
        logger.warning(f"Failed to log vision event in DB: {exc}")

    # 대시보드에 실시간 브로드캐스트
    await ws_manager.broadcast({
        "type": "vision_event",
        "event_type": request.event_type,
        "detected": request.detected,
        "count": request.count,
        "confidence": request.confidence,
        "created_at": now_str
    })

    # [트리거 규칙 연동 - 3단계] 사람 감지 시 부스 환영 안내 및 스피커/조명 자동 연동
    if request.detected and "person" in request.event_type.lower():
        try:
            from services.booth_service import BoothService
            await BoothService.trigger_entry()
        except Exception as exc:
            logger.warning(f"Failed to auto-trigger booth entry on vision event: {exc}")

    return {
        "data": {
            "recorded": True
        }
    }


# ==============================================================================
# [비전 영상 스트리밍] Vision -> Backend
# ==============================================================================

@device_router.websocket("/vision/stream")
async def receive_vision_stream(
    websocket: WebSocket,
    _key: str = Depends(verify_device_api_key),
):
    """
    Vision 클라이언트에서 원본/AI 처리 JPEG 프레임을 수신한다.

    전송 프로토콜:
      1. JSON 메타데이터 (Text)
      2. 원본 JPEG (Bytes)
      3. AI 처리 JPEG (Bytes)

    각 프레임은 동일한 frame_id와 captured_at을 사용한다.
    """

    await websocket.accept()

    logger.info("Vision 영상 스트리밍 클라이언트 연결")

    last_metrics_broadcast = 0.0
    status_broadcasted = False

    try:
        while True:
            # 1. 프레임 메타데이터 수신
            metadata_text = await websocket.receive_text()
            metadata = json.loads(metadata_text)

            if metadata.get("type") != "frame":
                logger.warning("알 수 없는 Vision 영상 메시지")
                continue

            frame_id = int(metadata["frame_id"])
            captured_at = float(metadata["captured_at"])
            inference_ms = float(metadata.get("inference_ms", 0.0))

            if frame_id < 0 or captured_at <= 0 or inference_ms < 0:
                raise ValueError("잘못된 프레임 메타데이터")

            # 2. 원본 JPEG 수신
            raw_jpeg = await websocket.receive_bytes()

            # 3. AI 처리 JPEG 수신
            processed_jpeg = await websocket.receive_bytes()

            # 비정상적으로 큰 프레임은 거부
            max_frame_size = 8 * 1024 * 1024

            if not raw_jpeg or not processed_jpeg:
                raise ValueError("빈 영상 프레임")

            if len(raw_jpeg) > max_frame_size:
                raise ValueError("원본 영상 프레임이 너무 큽니다.")

            if len(processed_jpeg) > max_frame_size:
                raise ValueError("처리 영상 프레임이 너무 큽니다.")

            received_at = time.time()

            # 4. 최신 프레임 캐시에 저장
            await vision_frame_store.publish(
                frame_id=frame_id,
                captured_at=captured_at,
                inference_ms=inference_ms,
                raw_jpeg=raw_jpeg,
                processed_jpeg=processed_jpeg,
                received_at=received_at,
            )
            
            if not status_broadcasted:
                await ws_manager.broadcast({
                    "type": "vision_stream_status",
                    "connected": True,
                })
                status_broadcasted = True

            # 5. 프론트엔드 상태 WebSocket에 지표 전송
            # 매 프레임마다 브로드캐스트하지 않고 최대 1초에 한 번 전송
            monotonic_now = time.monotonic()

            if monotonic_now - last_metrics_broadcast >= 1.0:
                vision_to_backend_ms = max(
                    0.0,
                    (received_at - captured_at) * 1000.0,
                )

                await ws_manager.broadcast({
                    "type": "vision_metrics",
                    "frame_id": frame_id,
                    "raw_frame_id": frame_id,
                    "processed_frame_id": frame_id,
                    "raw_captured_at": captured_at,
                    "processed_captured_at": captured_at,
                    "backend_received_at": received_at,
                    "vision_to_backend_ms": round(
                        vision_to_backend_ms, 2
                    ),
                    "inference_ms": round(inference_ms, 2),
                    "raw_size": len(raw_jpeg),
                    "processed_size": len(processed_jpeg),
                })

                last_metrics_broadcast = monotonic_now

    except WebSocketDisconnect:
        logger.info("Vision 영상 스트리밍 클라이언트 연결 종료")

    except (ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
        logger.warning(f"Vision 영상 데이터 형식 오류: {exc}")

        try:
            await websocket.close(code=1003, reason="Invalid frame data")
        except Exception:
            pass

    except Exception as exc:
        logger.warning(f"Vision 영상 수신 오류: {exc}")

        try:
            await websocket.close(code=1011, reason="Vision stream error")
        except Exception:
            pass

    finally:
        await vision_frame_store.mark_disconnected()

        await ws_manager.broadcast({
            "type": "vision_stream_status",
            "connected": False,
        })


# ==============================================================================
# [프론트엔드 영상 출력] Backend -> Frontend
# ==============================================================================

async def generate_mjpeg(stream_type: str):
    """
    최신 JPEG 프레임을 multipart/x-mixed-replace 형식으로 전달한다.
    """

    last_frame_id = None

    while True:
        frame = await vision_frame_store.wait_for_frame(
            stream_type=stream_type,
            last_frame_id=last_frame_id,
            timeout=10.0,
        )

        if frame is None:
            continue

        last_frame_id = frame["frame_id"]
        jpeg = frame["jpeg"]

        # MJPEG 프레임 헤더
        headers = (
            b"--frame\r\n"
            b"Content-Type: image/jpeg\r\n"
            + f"Content-Length: {len(jpeg)}\r\n".encode("ascii")
            + f"X-Frame-ID: {frame['frame_id']}\r\n".encode("ascii")
            + f"X-Captured-At: {frame['captured_at']}\r\n".encode("ascii")
            + b"\r\n"
        )

        yield headers + jpeg + b"\r\n"


@device_router.get("/vision/stream/raw")
async def stream_raw_video(
    _user: Dict[str, Any] = Depends(verify_user_auth),
):
    """프론트엔드용 원본 영상 MJPEG 스트리밍"""

    return StreamingResponse(
        generate_mjpeg("raw"),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@device_router.get("/vision/stream/processed")
async def stream_processed_video(
    _user: Dict[str, Any] = Depends(verify_user_auth),
):
    """프론트엔드용 AI 처리 영상 MJPEG 스트리밍"""

    return StreamingResponse(
        generate_mjpeg("processed"),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@device_router.get("/vision/stream/status")
async def get_vision_stream_status(
    _user: Dict[str, Any] = Depends(verify_user_auth),
):
    """현재 Vision 연결 및 프레임 수신 상태 조회"""

    return {
        "data": vision_frame_store.get_status()
    }
