
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

    CONNECTION_TIMEOUT_SECONDS = 5.0

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

        # WebSocket 연결 세대 관리
        self._connection_generation = 0
        self._active_connection_id: Optional[int] = None

    async def begin_connection(self) -> int:
        """
        새로운 Vision WebSocket 연결을 등록한다.

        새 연결이 시작되면 이전 연결의 ID는 더 이상 유효하지 않다.
        """

        async with self._condition:
            self._connection_generation += 1
            self._active_connection_id = self._connection_generation
            self._vision_connected = True

            connection_id = self._active_connection_id

            self._condition.notify_all()

        logger.info(
            "Vision 영상 스트림 연결 시작 (connection_id=%s)",
            connection_id,
        )

        return connection_id

    async def publish(
        self,
        frame_id: int,
        captured_at: float,
        inference_ms: float,
        raw_jpeg: bytes,
        processed_jpeg: bytes,
        received_at: Optional[float] = None,
        connection_id: Optional[int] = None,
    ) -> None:
        """
        원본 영상과 처리 영상을 한 쌍으로 저장한다.

        이전 연결에서 늦게 도착한 프레임은 무시한다.
        """

        if not raw_jpeg or not processed_jpeg:
            raise ValueError("영상 데이터가 비어 있습니다.")

        now = received_at if received_at is not None else time.time()

        async with self._condition:
            # 새 연결이 이미 시작됐다면 이전 연결의 프레임은 무시
            if (
                connection_id is not None
                and connection_id != self._active_connection_id
            ):
                logger.debug(
                    "이전 Vision 연결의 프레임 무시 (connection_id=%s)",
                    connection_id,
                )
                return

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

        WebSocket이 종료되더라도 마지막 프레임이 5초 이내라면
        일시적인 재연결 구간으로 보고 연결 상태를 유지한다.
        """

        now = time.time()

        if self._last_received_at is None:
            frame_age_ms = None
            connected = False
        else:
            frame_age_ms = round(
                max(0.0, (now - self._last_received_at) * 1000),
                2,
            )

            connected = (
                frame_age_ms
                <= self.CONNECTION_TIMEOUT_SECONDS * 1000
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

    async def mark_disconnected(
        self,
        connection_id: Optional[int] = None,
    ) -> None:
        """
        현재 Vision WebSocket 연결 종료를 기록한다.

        이전 연결의 종료 처리가 새 연결 상태에 영향을 주지 않도록
        connection_id를 확인한다.

        실제 연결 상태는 마지막 프레임 수신 시각을 기준으로
        최대 5초의 유예시간을 적용한다.
        """

        async with self._condition:
            # 이전 연결이 늦게 종료된 경우 현재 상태를 변경하지 않는다.
            if (
                connection_id is not None
                and connection_id != self._active_connection_id
            ):
                logger.info(
                    "이전 Vision 연결 종료 처리 무시 (connection_id=%s)",
                    connection_id,
                )
                return

            if connection_id is None or (
                connection_id == self._active_connection_id
            ):
                self._active_connection_id = None
                self._vision_connected = False

            self._condition.notify_all()

        logger.warning(
            "Vision 영상 스트림 연결 종료 (connection_id=%s)",
            connection_id,
        )


# =========================================================
# 전역 프레임 저장소
# devices.py에서 import하여 사용한다.
# =========================================================

vision_frame_store = VisionFrameStore()
