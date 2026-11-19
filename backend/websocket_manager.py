
import asyncio
import json
import logging
from typing import Any, Dict, List

from fastapi import WebSocket

logger = logging.getLogger("websocket_manager")

# WebSocket 메시지 전송 최대 대기 시간
SEND_TIMEOUT_SECONDS = 2.0


class WebSocketManager:
    """
    대시보드 프론트엔드와 실시간 상태를 동기화하기 위한 WebSocket 매니저.
    """

    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

        logger.info(
            "WebSocket client connected. Total clients: %s",
            len(self.active_connections),
        )

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

            logger.info(
                "WebSocket client disconnected. Total clients: %s",
                len(self.active_connections),
            )

    async def _send_to_client(
        self,
        connection: WebSocket,
        payload: str,
    ) -> bool:
        """
        개별 클라이언트에 제한 시간 내 메시지를 전송한다.

        전송 성공 시 True, 실패 또는 시간 초과 시 False를 반환한다.
        """

        try:
            await asyncio.wait_for(
                connection.send_text(payload),
                timeout=SEND_TIMEOUT_SECONDS,
            )
            return True

        except asyncio.TimeoutError:
            logger.warning(
                "WebSocket client send timed out after %.1f seconds.",
                SEND_TIMEOUT_SECONDS,
            )
            return False

        except Exception as exc:
            logger.warning(
                "Failed to send to client: %s",
                exc,
            )
            return False

    async def broadcast(self, message: Dict[str, Any]):
        """
        연결된 모든 대시보드 클라이언트에게 최신 상태 메시지를 전송한다.

        클라이언트별 전송을 동시에 실행하여 특정 연결의 지연이
        다른 연결의 전송을 막지 않도록 한다.
        """

        if not self.active_connections:
            return

        payload = json.dumps(message)

        # 전송 도중 연결 목록이 변경되는 상황을 방지하기 위해 사본 사용
        connections = list(self.active_connections)

        # 모든 클라이언트에 동시에 전송
        results = await asyncio.gather(
            *[
                self._send_to_client(connection, payload)
                for connection in connections
            ],
            return_exceptions=True,
        )

        # 실패하거나 시간 초과된 연결 제거
        for connection, result in zip(connections, results):
            if result is not True:
                self.disconnect(connection)

    async def send_personal_message(
        self,
        message: Dict[str, Any],
        websocket: WebSocket,
    ):
        """
        특정 클라이언트에 메시지를 전송한다.
        """

        try:
            await asyncio.wait_for(
                websocket.send_text(json.dumps(message)),
                timeout=SEND_TIMEOUT_SECONDS,
            )

        except asyncio.TimeoutError:
            logger.warning(
                "Personal WebSocket message timed out after %.1f seconds.",
                SEND_TIMEOUT_SECONDS,
            )
            self.disconnect(websocket)

        except Exception as exc:
            logger.warning(
                "Failed to send personal message: %s",
                exc,
            )
            self.disconnect(websocket)


# 싱글톤 매니저 인스턴스
ws_manager = WebSocketManager()
