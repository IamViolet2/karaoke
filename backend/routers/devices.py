
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

    try:
        db.log_vision_event(
            event_type=request.event_type,
            detected=request.detected,
            count=request.count,
            confidence=request.confidence
        )
    except Exception as exc:
        logger.warning(f"Failed to log vision event in DB: {exc}")

    await ws_manager.broadcast({
        "type": "vision_event",
        "event_type": request.event_type,
        "detected": request.detected,
        "count": request.count,
        "confidence": request.confidence,
        "created_at": now_str
    })

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
    """

    await websocket.accept()

    connection_id = await vision_frame_store.begin_connection()

    logger.info(
        "Vision 영상 스트리밍 클라이언트 연결 (connection_id=%s)",
        connection_id,
    )

    last_metrics_broadcast = 0.0
    status_broadcasted = False

    # 진단용 정보
    connection_started_at = time.monotonic()
    last_frame_id = None
    frames_received = 0
    receive_stage = "연결 초기화"
    last_frame_received_at = None

    try:
        while True:
            # 1. 프레임 메타데이터 수신
            receive_stage = "메타데이터 수신"
            metadata_text = await websocket.receive_text()

            metadata = json.loads(metadata_text)

            if metadata.get("type") != "frame":
                logger.warning(
                    "알 수 없는 Vision 영상 메시지 "
                    "(connection_id=%s, type=%s)",
                    connection_id,
                    metadata.get("type"),
                )
                continue

            frame_id = int(metadata["frame_id"])
            captured_at = float(metadata["captured_at"])
            inference_ms = float(metadata.get("inference_ms", 0.0))

            if frame_id < 0 or captured_at <= 0 or inference_ms < 0:
                raise ValueError("잘못된 프레임 메타데이터")

            # 2. 원본 JPEG 수신
            receive_stage = "원본 JPEG 수신"
            raw_jpeg = await websocket.receive_bytes()

            # 3. AI 처리 JPEG 수신
            receive_stage = "AI 처리 JPEG 수신"
            processed_jpeg = await websocket.receive_bytes()

            max_frame_size = 8 * 1024 * 1024

            if not raw_jpeg or not processed_jpeg:
                raise ValueError("빈 영상 프레임")

            if len(raw_jpeg) > max_frame_size:
                raise ValueError("원본 영상 프레임이 너무 큽니다.")

            if len(processed_jpeg) > max_frame_size:
                raise ValueError("처리 영상 프레임이 너무 큽니다.")

            received_at = time.time()

            # 4. 최신 프레임 캐시에 저장
            receive_stage = "프레임 저장"

            await vision_frame_store.publish(
                frame_id=frame_id,
                captured_at=captured_at,
                inference_ms=inference_ms,
                raw_jpeg=raw_jpeg,
                processed_jpeg=processed_jpeg,
                received_at=received_at,
                connection_id=connection_id,
            )

            last_frame_id = frame_id
            last_frame_received_at = received_at
            frames_received += 1

            # 최초 연결 상태 브로드캐스트
            if not status_broadcasted:
                receive_stage = "최초 상태 브로드캐스트"

                broadcast_started = time.monotonic()

                await ws_manager.broadcast({
                    "type": "vision_stream_status",
                    "connected": True,
                })

                broadcast_ms = (
                    time.monotonic() - broadcast_started
                ) * 1000

                if broadcast_ms >= 100:
                    logger.warning(
                        "Vision 최초 상태 브로드캐스트 지연 "
                        "(connection_id=%s, %.1fms)",
                        connection_id,
                        broadcast_ms,
                    )

                status_broadcasted = True

            # 5. 프론트엔드 상태 WebSocket에 지표 전송
            monotonic_now = time.monotonic()

            if monotonic_now - last_metrics_broadcast >= 1.0:
                vision_to_backend_ms = max(
                    0.0,
                    (received_at - captured_at) * 1000.0,
                )

                receive_stage = "성능 지표 브로드캐스트"

                broadcast_started = time.monotonic()

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

                broadcast_ms = (
                    time.monotonic() - broadcast_started
                ) * 1000

                if broadcast_ms >= 100:
                    logger.warning(
                        "Vision 성능 지표 브로드캐스트 지연 "
                        "(connection_id=%s, frame_id=%s, %.1fms)",
                        connection_id,
                        frame_id,
                        broadcast_ms,
                    )

                last_metrics_broadcast = time.monotonic()

            receive_stage = "다음 프레임 대기"

    except WebSocketDisconnect as exc:
        elapsed = time.monotonic() - connection_started_at

        logger.warning(
            "Vision WebSocket 연결 종료 감지 "
            "(connection_id=%s, code=%s, reason=%r, "
            "last_frame_id=%s, frames_received=%s, "
            "last_stage=%s, elapsed=%.1fs, "
            "last_frame_received_at=%s)",
            connection_id,
            getattr(exc, "code", None),
            getattr(exc, "reason", None),
            last_frame_id,
            frames_received,
            receive_stage,
            elapsed,
            last_frame_received_at,
        )

    except (ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
        logger.warning(
            "Vision 영상 데이터 형식 오류 "
            "(connection_id=%s, last_frame_id=%s, "
            "frames_received=%s, stage=%s): %s",
            connection_id,
            last_frame_id,
            frames_received,
            receive_stage,
            exc,
        )

        try:
            await websocket.close(
                code=1003,
                reason="Invalid frame data",
            )
        except Exception:
            logger.debug(
                "Vision 오류 종료 메시지 전송 실패",
                exc_info=True,
            )

    except Exception:
        logger.exception(
            "Vision 영상 수신 중 예외 발생 "
            "(connection_id=%s, last_frame_id=%s, "
            "frames_received=%s, stage=%s)",
            connection_id,
            last_frame_id,
            frames_received,
            receive_stage,
        )

        try:
            await websocket.close(
                code=1011,
                reason="Vision stream error",
            )
        except Exception:
            logger.debug(
                "Vision 예외 종료 메시지 전송 실패",
                exc_info=True,
            )

    finally:
        # 이 연결이 현재 연결인 경우에만 종료 처리
        await vision_frame_store.mark_disconnected(connection_id)

        current_status = vision_frame_store.get_status()

        try:
            await ws_manager.broadcast({
                "type": "vision_stream_status",
                "connected": current_status["connected"],
            })
        except Exception:
            logger.exception(
                "Vision 연결 종료 상태 브로드캐스트 실패 "
                "(connection_id=%s)",
                connection_id,
            )

        logger.info(
            "Vision 영상 스트리밍 정리 완료 "
            "(connection_id=%s, last_frame_id=%s, "
            "frames_received=%s, connected=%s)",
            connection_id,
            last_frame_id,
            frames_received,
            current_status["connected"],
        )



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
