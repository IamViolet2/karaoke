
import asyncio
import logging
import time
from typing import Any, Dict, Optional

logger = logging.getLogger("backend.services.vision_stream")


class VisionFrameStore:
    """
    Vision에서 전송한 원본 영상과 AI 처리 영상을 저장하는 클래스.

    프레임을 무한정 쌓지 않고 최신 프레임 한 쌍만 유지한다.
    """

    def __init__(self):
        self._condition = asyncio.Condition()

        self._frames: Dict[str, Dict[str, Any]] = {
            "raw": {},
            "processed": {},
        }

        self._last_received_at: Optional[float] = None
        self._vision_connected = False

        self._frame_id: Optional[int] = None
        self._captured_at: Optional[float] = None
        self._inference_ms: Optional[float] = None

    async def publish(
        self,
        frame_id: int,
        captured_at: float,
        inference_ms: float,
        raw_jpeg: bytes,
        processed_jpeg: bytes,
        received_at: Optional[float] = None,
    ) -> None:
        """
        원본 영상과 처리 영상을 한 쌍으로 저장한다.
        """

        if not raw_jpeg or not processed_jpeg:
            raise ValueError("영상 데이터가 비어 있습니다.")

        now = received_at if received_at is not None else time.time()

        async with self._condition:
            self._frames["raw"] = {
                "frame_id": frame_id,
                "captured_at": captured_at,
                "received_at": now,
                "inference_ms": inference_ms,
                "jpeg": raw_jpeg,
            }

            self._frames["processed"] = {
                "frame_id": frame_id,
                "captured_at": captured_at,
                "received_at": now,
                "inference_ms": inference_ms,
                "jpeg": processed_jpeg,
            }

            self._frame_id = frame_id
            self._captured_at = captured_at
            self._inference_ms = inference_ms

            self._last_received_at = now
            self._vision_connected = True

            self._condition.notify_all()

    async def wait_for_frame(
        self,
        stream_type: str,
        last_frame_id: Optional[int] = None,
        timeout: float = 10.0,
    ) -> Optional[Dict[str, Any]]:
        """
        지정한 영상 종류의 새 프레임을 기다린다.

        stream_type:
            raw       - 원본 영상
            processed - AI 처리 영상
        """

        if stream_type not in ("raw", "processed"):
            raise ValueError(
                f"지원하지 않는 영상 종류입니다: {stream_type}"
            )

        async def wait_for_new_frame():
            async with self._condition:
                await self._condition.wait_for(
                    lambda: (
                        self._frames[stream_type].get("jpeg") is not None
                        and (
                            last_frame_id is None
                            or self._frames[stream_type].get("frame_id")
                            != last_frame_id
                        )
                    )
                )

                return dict(self._frames[stream_type])

        try:
            return await asyncio.wait_for(
                wait_for_new_frame(),
                timeout=timeout,
            )

        except asyncio.TimeoutError:
            return None

    def get_status(self) -> Dict[str, Any]:
        """
        Vision 연결 상태와 최신 프레임 정보를 반환한다.
        """

        now = time.time()

        if self._last_received_at is None:
            frame_age_ms = None
            connected = False
        else:
            frame_age_ms = round(
                (now - self._last_received_at) * 1000,
                2,
            )

            connected = (
                self._vision_connected
                and frame_age_ms <= 5000
            )

        return {
            "connected": connected,
            "last_received_at": self._last_received_at,
            "frame_age_ms": frame_age_ms,
            "raw": {
                "frame_id": self._frames["raw"].get("frame_id"),
                "captured_at": self._frames["raw"].get("captured_at"),
            },
            "processed": {
                "frame_id": self._frames["processed"].get("frame_id"),
                "captured_at": self._frames["processed"].get("captured_at"),
                "inference_ms": self._frames["processed"].get("inference_ms"),
            },
        }

    async def mark_disconnected(self) -> None:
        """
        Vision WebSocket 연결 종료 시 호출한다.
        """

        async with self._condition:
            self._vision_connected = False
            self._condition.notify_all()

        logger.warning("Vision 영상 스트림 연결 종료")


# =========================================================
# 전역 프레임 저장소
# devices.py에서 import하여 사용한다.
# =========================================================

vision_frame_store = VisionFrameStore()
