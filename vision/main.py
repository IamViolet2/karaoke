
import logging
import os
import sys
import time
import json
import threading
import queue

import cv2
import numpy as np
import requests
import websocket

from dotenv import load_dotenv
from PIL import Image, ImageDraw, ImageFont


# =========================================================
# 기본 설정
# =========================================================

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S"
)

logger = logging.getLogger("vision.main")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(BASE_DIR, ".env"))

BACKEND_URL = os.getenv(
    "BACKEND_URL",
    "http://localhost:8000"
).rstrip("/")

DEVICE_API_KEY = os.getenv("DEVICE_API_KEY", "")
CAMERA_INDEX = int(os.getenv("CAMERA_INDEX", "0"))

ONNX_MODEL_PATH = os.path.join(
    BASE_DIR,
    "yolov8n.onnx"
)

VISION_EVENT_URL = f"{BACKEND_URL}/api/v1/vision/events"

VISION_STREAM_URL = (
    BACKEND_URL
    .replace("https://", "wss://", 1)
    .replace("http://", "ws://", 1)
    + "/api/v1/vision/stream"
)

JPEG_QUALITY = 70
PUBLISH_FPS = 15
EVENT_INTERVAL = 10.0
METRICS_INTERVAL = 5.0

# 감지 상태가 바뀌기 위해 필요한 연속 프레임 수
DETECTION_CONFIRM_FRAMES = 3

# 이벤트 전송 큐는 최신 이벤트 하나만 유지
EVENT_QUEUE_SIZE = 1

if not DEVICE_API_KEY:
    logger.error(
        "DEVICE_API_KEY가 설정되지 않았습니다. vision/.env를 확인하세요."
    )
    sys.exit(1)


# =========================================================
# 한글 폰트 캐시 및 렌더링
# =========================================================

_FONT_CACHE = {}


def get_korean_font(font_size: int):

    if font_size not in _FONT_CACHE:

        try:
            font_path = os.path.join(
                os.environ.get("WINDIR", "C:/Windows"),
                "Fonts",
                "malgun.ttf"
            )

            _FONT_CACHE[font_size] = ImageFont.truetype(
                font_path,
                font_size
            )

        except Exception:
            try:
                _FONT_CACHE[font_size] = ImageFont.truetype(
                    "malgun.ttf",
                    font_size
                )
            except Exception:
                _FONT_CACHE[font_size] = ImageFont.load_default()

    return _FONT_CACHE[font_size]


def draw_korean_texts(
    img: np.ndarray,
    items: list
) -> np.ndarray:
    """
    한 프레임에 여러 한글 텍스트를 그릴 때
    BGR -> PIL -> BGR 변환을 한 번만 수행한다.

    items:
        [
            (text, (x, y), font_size, color),
            ...
        ]
    """

    if not items:
        return img

    try:

        img_pil = Image.fromarray(
            cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        )

        draw = ImageDraw.Draw(img_pil)

        for text, pos, font_size, color in items:

            draw.text(
                pos,
                text,
                font=get_korean_font(font_size),
                fill=color
            )

        return cv2.cvtColor(
            np.asarray(img_pil),
            cv2.COLOR_RGB2BGR
        )

    except Exception:

        # PIL 렌더링 실패 시 OpenCV 기본 텍스트로 대체
        for text, pos, font_size, color in items:

            cv2.putText(
                img,
                text,
                pos,
                cv2.FONT_HERSHEY_SIMPLEX,
                max(0.4, font_size / 28.0),
                color,
                1,
                cv2.LINE_AA
            )

        return img


def put_korean_text(
    img: np.ndarray,
    text: str,
    pos: tuple,
    font_size: int = 20,
    color: tuple = (255, 255, 255)
) -> np.ndarray:

    return draw_korean_texts(
        img,
        [(text, pos, font_size, color)]
    )


# =========================================================
# YOLOv8 ONNX + OpenVINO 탐지기
# GPU 우선 / 실패 시 CPU 자동 전환
# =========================================================

class YOLOv8ONNXDetector:

    def __init__(self, model_path: str):

        self.model_path = model_path

        self.core = None
        self.compiled_model = None
        self.infer_request = None

        self.input_port = None
        self.output_port = None

        self.engine_name = "None"
        self.device_name = "CPU"

        if not os.path.exists(model_path):
            raise FileNotFoundError(
                f"모델 파일이 없습니다: {model_path}"
            )

        import openvino as ov

        logger.info(
            "OpenVINO 초기화: %s",
            ov.__version__
        )

        self.core = ov.Core()
        available_devices = self.core.available_devices

        logger.info(
            "OpenVINO 사용 가능 장치: %s",
            available_devices
        )

        model = self.core.read_model(model_path)

        target_devices = []

        if "GPU" in available_devices:
            target_devices.append("GPU")

        if "CPU" in available_devices:
            target_devices.append("CPU")

        if not target_devices:
            raise RuntimeError(
                "OpenVINO에서 사용할 수 있는 장치가 없습니다."
            )

        last_error = None

        for device in target_devices:

            try:

                logger.info(
                    "%s 장치로 YOLO 모델 컴파일 시작",
                    device
                )

                compiled_model = self.core.compile_model(
                    model,
                    device
                )

                infer_request = compiled_model.create_infer_request()

                input_port = compiled_model.input(0)
                output_port = compiled_model.output(0)

                self.compiled_model = compiled_model
                self.infer_request = infer_request

                self.input_port = input_port
                self.output_port = output_port

                self.device_name = device

                try:
                    full_name = self.core.get_property(
                        device,
                        "FULL_DEVICE_NAME"
                    )
                except Exception:
                    full_name = device

                self.engine_name = (
                    f"OpenVINO {ov.__version__} / {device}"
                )

                logger.info("YOLO 모델 로드 성공")
                logger.info("추론 장치: %s", full_name)
                logger.info("입력 텐서 형태: %s", input_port.shape)
                logger.info("출력 텐서 형태: %s", output_port.shape)

                break

            except Exception as exc:

                last_error = exc

                logger.exception(
                    "%s 장치 모델 초기화 실패",
                    device
                )

        if self.compiled_model is None:

            raise RuntimeError(
                f"OpenVINO 모델 초기화 실패: {last_error}"
            )

    def detect(
        self,
        img: np.ndarray,
        conf_threshold: float = 0.45,
        nms_threshold: float = 0.5
    ):

        img_h, img_w = img.shape[:2]

        blob = cv2.dnn.blobFromImage(
            img,
            1 / 255.0,
            (640, 640),
            swapRB=True,
            crop=False
        )

        infer_result = self.infer_request.infer(
            {self.input_port: blob}
        )

        raw_output = np.asarray(
            infer_result[self.output_port]
        )

        if raw_output.ndim == 3:
            raw_output = raw_output[0]

        if raw_output.ndim != 2:
            raise RuntimeError(
                f"예상하지 못한 YOLO 출력 형태: {raw_output.shape}"
            )

        if raw_output.shape[0] < raw_output.shape[1]:
            preds = raw_output.T
        else:
            preds = raw_output

        boxes = []
        confidences = []

        scale_x = img_w / 640.0
        scale_y = img_h / 640.0

        for i in range(preds.shape[0]):

            person_score = float(preds[i][4])

            if person_score < conf_threshold:
                continue

            cx, cy, w, h = preds[i][:4]

            x1 = int((cx - w / 2.0) * scale_x)
            y1 = int((cy - h / 2.0) * scale_y)

            bw = int(w * scale_x)
            bh = int(h * scale_y)

            boxes.append([
                max(0, x1),
                max(0, y1),
                bw,
                bh
            ])

            confidences.append(person_score)

        if not boxes:
            return [], []

        indices = cv2.dnn.NMSBoxes(
            boxes,
            confidences,
            conf_threshold,
            nms_threshold
        )

        detected_boxes = []
        detected_confs = []

        if len(indices) > 0:

            for idx in np.array(indices).flatten():

                detected_boxes.append(boxes[idx])
                detected_confs.append(confidences[idx])

        return detected_boxes, detected_confs


# =========================================================
# 백엔드 이벤트 전송
# =========================================================

def send_vision_event(
    event_type: str,
    detected: bool,
    count: int = 1,
    confidence: float = 0.9
) -> bool:

    headers = {
        "X-Device-Api-Key": DEVICE_API_KEY,
        "Content-Type": "application/json"
    }

    payload = {
        "event_type": event_type,
        "detected": detected,
        "count": count,
        "confidence": confidence
    }

    try:

        res = requests.post(
            VISION_EVENT_URL,
            json=payload,
            headers=headers,
            timeout=2.0
        )

        res.raise_for_status()

        logger.info(
            "비전 이벤트 전송 성공: %s / 감지=%s / 인원=%s",
            event_type,
            detected,
            count
        )

        return True

    except Exception as exc:

        logger.warning(
            "백엔드 이벤트 전송 실패: %s",
            exc
        )

        return False


# =========================================================
# 이벤트 전송 전용 스레드
# =========================================================

class VisionEventSender:

    def __init__(self):

        self.event_queue = queue.Queue(
            maxsize=EVENT_QUEUE_SIZE
        )

        self.stop_event = threading.Event()

        self.thread = threading.Thread(
            target=self._run,
            daemon=True,
            name="VisionEventSender"
        )

    def start(self):
        self.thread.start()

    def enqueue(
        self,
        event_type: str,
        detected: bool,
        count: int,
        confidence: float
    ):

        event = {
            "event_type": event_type,
            "detected": detected,
            "count": count,
            "confidence": confidence
        }

        try:

            self.event_queue.put_nowait(event)

        except queue.Full:

            # 오래된 대기 이벤트를 버리고 최신 상태로 교체
            try:
                self.event_queue.get_nowait()
                self.event_queue.task_done()
            except queue.Empty:
                pass

            try:
                self.event_queue.put_nowait(event)
            except queue.Full:
                logger.warning(
                    "이벤트 큐가 가득 차 최신 이벤트 등록 실패"
                )

    def _run(self):

        logger.info("이벤트 전송 스레드 시작")

        while (
            not self.stop_event.is_set()
            or not self.event_queue.empty()
        ):

            try:

                event = self.event_queue.get(timeout=0.2)

            except queue.Empty:
                continue

            try:

                send_vision_event(
                    event_type=event["event_type"],
                    detected=event["detected"],
                    count=event["count"],
                    confidence=event["confidence"]
                )

            except Exception:

                logger.exception(
                    "이벤트 전송 스레드 오류"
                )

            finally:
                self.event_queue.task_done()

        logger.info("이벤트 전송 스레드 종료")

    def stop(self, timeout=3):

        self.stop_event.set()
        self.thread.join(timeout=timeout)


# =========================================================
# 가상 카메라 프레임
# =========================================================

def make_virtual_frame() -> np.ndarray:

    frame = np.zeros(
        (480, 640, 3),
        dtype=np.uint8
    )

    frame[:] = (35, 35, 35)

    return draw_korean_texts(
        frame,
        [
            (
                "스마트 학교 노래방 부스 비전 클라이언트",
                (30, 30),
                22,
                (255, 255, 255)
            ),
            (
                "가상 카메라 작동 중",
                (30, 90),
                20,
                (100, 255, 100)
            )
        ]
    )


# =========================================================
# JPEG 인코딩
# =========================================================

def encode_jpeg(frame: np.ndarray):

    success, encoded = cv2.imencode(
        ".jpg",
        frame,
        [
            cv2.IMWRITE_JPEG_QUALITY,
            JPEG_QUALITY
        ]
    )

    if not success:
        return None

    return encoded.tobytes()


# =========================================================
# 공유 프레임 저장소
# =========================================================

class VisionFrameBuffer:

    def __init__(self):

        self.lock = threading.Lock()
        self.condition = threading.Condition(self.lock)

        self.raw_frame = None
        self.processed_frame = None

        self.frame_id = 0
        self.processed_frame_id = 0

        self.captured_at = 0.0
        self.inference_ms = 0.0

        self.capture_fps = 0.0
        self.inference_fps = 0.0

        self.detected = False
        self.person_count = 0
        self.confidence = 0.0

        self.capture_ready = False
        self.processed_ready = False

    def update_raw(
        self,
        frame: np.ndarray,
        frame_id: int,
        captured_at: float,
        capture_fps: float
    ):

        with self.condition:

            self.raw_frame = frame
            self.frame_id = frame_id
            self.captured_at = captured_at
            self.capture_fps = capture_fps

            self.capture_ready = True
            self.condition.notify_all()

    def get_latest_raw(self):

        with self.lock:

            if self.raw_frame is None:
                return None

            return (
                self.raw_frame.copy(),
                self.frame_id,
                self.captured_at,
                self.capture_fps
            )

    def get_latest_raw_after(self, last_frame_id: int):

        with self.condition:

            self.condition.wait_for(
                lambda:
                    self.frame_id > last_frame_id
                    or not self.capture_ready,
                timeout=1.0
            )

            if (
                self.raw_frame is None
                or self.frame_id <= last_frame_id
            ):
                return None

            return (
                self.raw_frame.copy(),
                self.frame_id,
                self.captured_at
            )

    def update_processed(
        self,
        frame: np.ndarray,
        frame_id: int,
        inference_ms: float,
        inference_fps: float,
        detected: bool,
        person_count: int,
        confidence: float
    ):

        with self.lock:

            self.processed_frame = frame
            self.processed_frame_id = frame_id

            self.inference_ms = inference_ms
            self.inference_fps = inference_fps

            self.detected = detected
            self.person_count = person_count
            self.confidence = confidence

            self.processed_ready = True

    def get_latest_pair(self):

        with self.lock:

            if self.raw_frame is None:
                return None

            raw = self.raw_frame.copy()

            if self.processed_frame is not None:
                processed = self.processed_frame.copy()
            else:
                processed = raw.copy()

            return {
                "raw": raw,
                "processed": processed,
                "frame_id": self.frame_id,
                "captured_at": self.captured_at,
                "inference_ms": self.inference_ms,
                "capture_fps": self.capture_fps,
                "inference_fps": self.inference_fps,
                "processed_frame_id": self.processed_frame_id
            }


# =========================================================
# 카메라 캡처 스레드
# =========================================================

class CameraCaptureWorker:

    def __init__(
        self,
        cap,
        has_real_camera: bool,
        frame_buffer: VisionFrameBuffer,
        stop_event: threading.Event
    ):

        self.cap = cap
        self.has_real_camera = has_real_camera
        self.frame_buffer = frame_buffer
        self.stop_event = stop_event

        self.thread = threading.Thread(
            target=self._run,
            daemon=True,
            name="VisionCameraCapture"
        )

        self.frame_id = 0

    def start(self):
        self.thread.start()

    def join(self, timeout=None):
        self.thread.join(timeout=timeout)

    def _run(self):

        fps_count = 0
        fps_start = time.monotonic()
        capture_fps = 0.0

        logger.info("카메라 캡처 스레드 시작")

        while not self.stop_event.is_set():

            try:

                captured_at = time.time()

                if self.has_real_camera:

                    ret, camera_frame = self.cap.read()

                    if not ret:

                        logger.warning(
                            "카메라 프레임 획득 실패"
                        )

                        self.stop_event.wait(0.03)
                        continue

                    raw_frame = camera_frame.copy()

                else:

                    raw_frame = make_virtual_frame()

                self.frame_id += 1
                fps_count += 1

                elapsed = time.monotonic() - fps_start

                if elapsed >= 1.0:

                    capture_fps = fps_count / elapsed

                    fps_count = 0
                    fps_start = time.monotonic()

                self.frame_buffer.update_raw(
                    frame=raw_frame,
                    frame_id=self.frame_id,
                    captured_at=captured_at,
                    capture_fps=round(capture_fps, 2)
                )

            except Exception:

                logger.exception("카메라 캡처 스레드 오류")
                self.stop_event.wait(0.1)

        logger.info("카메라 캡처 스레드 종료")


# =========================================================
# AI 추론 스레드
# =========================================================

class VisionAIWorker:

    def __init__(
        self,
        detector,
        subtractor,
        has_real_camera: bool,
        frame_buffer: VisionFrameBuffer,
        stop_event: threading.Event,
        event_sender: VisionEventSender
    ):

        self.detector = detector
        self.subtractor = subtractor
        self.has_real_camera = has_real_camera

        self.frame_buffer = frame_buffer
        self.stop_event = stop_event
        self.event_sender = event_sender

        self.thread = threading.Thread(
            target=self._run,
            daemon=True,
            name="VisionAIInference"
        )

        self.last_processed_frame_id = 0

        # 실제 확정된 감지 상태
        self.prev_detected = False

        # 감지 상태 안정화용 후보 상태
        self.candidate_detected = None
        self.candidate_count = 0

        self.last_report_time = 0.0

        self.fps_count = 0
        self.fps_start = time.monotonic()
        self.inference_fps = 0.0

    def start(self):
        self.thread.start()

    def join(self, timeout=None):
        self.thread.join(timeout=timeout)

    def _update_detection_state(
        self,
        detected: bool
    ) -> bool:
        """
        3프레임 연속으로 동일한 상태가 확인되어야
        감지 상태를 변경한다.
        """

        if detected == self.prev_detected:

            self.candidate_detected = None
            self.candidate_count = 0

            return False

        if detected != self.candidate_detected:

            self.candidate_detected = detected
            self.candidate_count = 1

        else:

            self.candidate_count += 1

        if self.candidate_count >= DETECTION_CONFIRM_FRAMES:

            self.prev_detected = detected

            self.candidate_detected = None
            self.candidate_count = 0

            return True

        return False

    def _run(self):

        logger.info("AI 추론 스레드 시작")

        while not self.stop_event.is_set():

            item = self.frame_buffer.get_latest_raw_after(
                self.last_processed_frame_id
            )

            if item is None:
                continue

            raw_frame, frame_id, captured_at = item

            self.last_processed_frame_id = frame_id

            try:

                processed_frame = raw_frame.copy()

                processing_start = time.perf_counter()

                overlay_items = []

                if self.has_real_camera and self.detector:

                    # YOLO 추론
                    boxes, confs = self.detector.detect(
                        raw_frame,
                        conf_threshold=0.45
                    )

                    count = len(boxes)
                    detected = count > 0

                    conf = max(confs) if confs else 0.0

                    for (x, y, w, h), c in zip(boxes, confs):

                        cv2.rectangle(
                            processed_frame,
                            (x, y),
                            (x + w, y + h),
                            (0, 255, 0),
                            2
                        )

                        overlay_items.append(
                            (
                                f"사람 감지 {c:.2f}",
                                (x, max(0, y - 25)),
                                16,
                                (0, 255, 0)
                            )
                        )

                elif self.has_real_camera:

                    fg_mask = self.subtractor.apply(raw_frame)

                    contours, _ = cv2.findContours(
                        fg_mask,
                        cv2.RETR_EXTERNAL,
                        cv2.CHAIN_APPROX_SIMPLE
                    )

                    large_contours = [
                        c for c in contours
                        if cv2.contourArea(c) > 6000
                    ]

                    count = len(large_contours)
                    detected = count > 0

                    conf = 0.85 if detected else 0.0

                    for contour in large_contours:

                        x, y, w, h = cv2.boundingRect(contour)

                        cv2.rectangle(
                            processed_frame,
                            (x, y),
                            (x + w, y + h),
                            (0, 255, 0),
                            2
                        )

                        overlay_items.append(
                            (
                                "움직임 감지",
                                (x, max(0, y - 25)),
                                15,
                                (0, 255, 0)
                            )
                        )

                else:

                    count = 0
                    detected = False
                    conf = 0.0

                # -------------------------------------------------
                # 감지 상태 안정화 및 이벤트 큐 등록
                # -------------------------------------------------

                current_time = time.time()

                state_changed = self._update_detection_state(
                    detected
                )

                should_report = (
                    state_changed
                    or (
                        self.prev_detected
                        and current_time - self.last_report_time
                        > EVENT_INTERVAL
                    )
                )

                if should_report:

                    self.event_sender.enqueue(
                        event_type="person_detected",
                        detected=self.prev_detected,
                        count=count if self.prev_detected else 0,
                        confidence=round(conf, 2)
                        if self.prev_detected else 0.0
                    )

                    self.last_report_time = current_time

                # -------------------------------------------------
                # 한글 텍스트를 한 번에 렌더링
                # -------------------------------------------------

                overlay_items.append(
                    (
                        f"AI 처리 시간: "
                        f"{(time.perf_counter() - processing_start) * 1000:.1f}ms",
                        (15, 15),
                        18,
                        (255, 255, 0)
                    )
                )

                processed_frame = draw_korean_texts(
                    processed_frame,
                    overlay_items
                )

                # 전체 처리 시간
                inference_ms = (
                    time.perf_counter() - processing_start
                ) * 1000

                # 처리 FPS 측정
                self.fps_count += 1

                fps_elapsed = (
                    time.monotonic() - self.fps_start
                )

                if fps_elapsed >= 1.0:

                    self.inference_fps = (
                        self.fps_count / fps_elapsed
                    )

                    self.fps_count = 0
                    self.fps_start = time.monotonic()

                # 최신 AI 처리 프레임 갱신
                self.frame_buffer.update_processed(
                    frame=processed_frame,
                    frame_id=frame_id,
                    inference_ms=round(inference_ms, 2),
                    inference_fps=round(
                        self.inference_fps,
                        2
                    ),
                    detected=self.prev_detected,
                    person_count=count,
                    confidence=conf
                )

            except Exception:

                logger.exception("AI 추론 스레드 오류")

        logger.info("AI 추론 스레드 종료")



# =========================================================
# WebSocket 영상 전송
# =========================================================

class VisionStreamSender:

    def __init__(self):

        self.stop_event = threading.Event()
        self.condition = threading.Condition()

        self.latest_packet = None
        self.last_sent_frame_id = -1

        self.sent_fps = 0.0
        self.sent_count = 0
        self.sent_fps_start = time.monotonic()

        # 현재 연결된 WebSocket 관리
        self.active_ws = None
        self.ws_lock = threading.Lock()

        self.thread = threading.Thread(
            target=self._run,
            daemon=True,
            name="VisionStreamSender"
        )

    def start(self):
        self.thread.start()

    def stop(self):

        self.stop_event.set()

        with self.condition:
            self.condition.notify_all()

        # 수신 대기 중인 WebSocket을 닫아
        # 수신 스레드가 종료될 수 있도록 한다.
        with self.ws_lock:
            ws = self.active_ws

        if ws is not None:
            try:
                ws.close()
            except Exception:
                pass

        self.thread.join(timeout=3)

    def publish(
        self,
        frame_id: int,
        captured_at: float,
        inference_ms: float,
        raw_jpeg: bytes,
        processed_jpeg: bytes
    ):

        packet = {
            "frame_id": frame_id,
            "captured_at": captured_at,
            "inference_ms": inference_ms,
            "raw_jpeg": raw_jpeg,
            "processed_jpeg": processed_jpeg
        }

        with self.condition:

            self.latest_packet = packet
            self.condition.notify()

    def get_sent_fps(self):

        with self.condition:
            return round(self.sent_fps, 2)

    def _receive_loop(
        self,
        ws,
        connection_lost: threading.Event,
        connection_closing: threading.Event
    ):
        """
        백엔드에서 보내는 WebSocket Ping을 수신한다.

        websocket-client의 recv()는 Ping 프레임을
        자동으로 처리하고 Pong을 응답한다.

        백엔드에서 별도의 일반 메시지를 보내는 경우에도
        수신 처리를 계속 유지한다.
        """

        logger.info("WebSocket Ping/Pong 수신 처리 시작")

        try:

            while (
                not self.stop_event.is_set()
                and not connection_closing.is_set()
            ):

                message = ws.recv()

                # 서버가 연결을 종료한 경우
                if message is None:
                    if not connection_closing.is_set():
                        connection_lost.set()
                    break

                # 현재 백엔드는 별도 일반 메시지를 보내지 않는다.
                # Ping/Pong 처리는 recv() 내부에서 수행된다.

        except Exception as exc:

            if (
                not self.stop_event.is_set()
                and not connection_closing.is_set()
            ):

                logger.warning(
                    "WebSocket 수신 연결 오류: %s",
                    exc
                )

                connection_lost.set()

        finally:

            logger.info("WebSocket Ping/Pong 수신 처리 종료")

    def _run(self):

        while not self.stop_event.is_set():

            ws = None
            receiver_thread = None

            connection_lost = threading.Event()
            connection_closing = threading.Event()

            try:

                logger.info(
                    "Vision WebSocket 연결 시도: %s",
                    VISION_STREAM_URL
                )

                ws = websocket.create_connection(
                    VISION_STREAM_URL,
                    header=[
                        f"X-Device-Api-Key: {DEVICE_API_KEY}"
                    ],
                    timeout=5,
                    enable_multithread=True
                )

                # 연결 이후 수신 스레드가 계속 대기할 수 있도록
                # 소켓 읽기 타임아웃을 해제한다.
                ws.settimeout(None)

                with self.ws_lock:
                    self.active_ws = ws

                logger.info("Vision WebSocket 연결 성공")

                self.last_sent_frame_id = -1

                # -------------------------------------------------
                # Ping/Pong 전용 수신 스레드 시작
                # -------------------------------------------------

                receiver_thread = threading.Thread(
                    target=self._receive_loop,
                    args=(
                        ws,
                        connection_lost,
                        connection_closing
                    ),
                    daemon=True,
                    name="VisionWebSocketReceiver"
                )

                receiver_thread.start()

                # -------------------------------------------------
                # 기존 영상 전송 루프
                # -------------------------------------------------

                while not self.stop_event.is_set():

                    if connection_lost.is_set():
                        raise ConnectionError(
                            "WebSocket 수신 연결이 종료되었습니다."
                        )

                    with self.condition:

                        self.condition.wait_for(
                            lambda:
                                self.stop_event.is_set()
                                or connection_lost.is_set()
                                or (
                                    self.latest_packet is not None
                                    and self.latest_packet["frame_id"]
                                    != self.last_sent_frame_id
                                ),
                            timeout=1
                        )

                        if self.stop_event.is_set():
                            break

                        if connection_lost.is_set():
                            raise ConnectionError(
                                "WebSocket 연결이 끊겼습니다."
                            )

                        packet = self.latest_packet

                        if packet is None:
                            continue

                        packet = dict(packet)

                    metadata = {
                        "type": "frame",
                        "frame_id": packet["frame_id"],
                        "captured_at": packet["captured_at"],
                        "inference_ms": packet["inference_ms"]
                    }

                    # 기존 프로토콜 유지:
                    # 메타데이터 -> 원본 -> 처리 영상

                    ws.send(
                        json.dumps(metadata),
                        opcode=websocket.ABNF.OPCODE_TEXT
                    )

                    ws.send(
                        packet["raw_jpeg"],
                        opcode=websocket.ABNF.OPCODE_BINARY
                    )

                    ws.send(
                        packet["processed_jpeg"],
                        opcode=websocket.ABNF.OPCODE_BINARY
                    )

                    self.last_sent_frame_id = packet["frame_id"]

                    with self.condition:

                        self.sent_count += 1

                        elapsed = (
                            time.monotonic()
                            - self.sent_fps_start
                        )

                        if elapsed >= 1.0:

                            self.sent_fps = (
                                self.sent_count / elapsed
                            )

                            self.sent_count = 0
                            self.sent_fps_start = time.monotonic()

            except Exception as exc:

                if not self.stop_event.is_set():

                    logger.warning(
                        "영상 WebSocket 오류: %s",
                        exc
                    )

            finally:

                # 수신 스레드가 종료 중임을 먼저 알린다.
                connection_closing.set()

                if ws is not None:

                    try:
                        ws.close()
                    except Exception:
                        pass

                # 수신 스레드 종료 대기
                if receiver_thread is not None:
                    receiver_thread.join(timeout=2)

                with self.ws_lock:

                    if self.active_ws is ws:
                        self.active_ws = None

            if not self.stop_event.is_set():

                logger.info("2초 후 영상 서버 재연결")
                self.stop_event.wait(2)


# =========================================================
# 메인 실행
# =========================================================

def main():

    logger.info("=" * 60)

    logger.info(
        "스마트 학교 노래방 부스 Vision 클라이언트 시작"
    )

    logger.info("백엔드 주소: %s", BACKEND_URL)
    logger.info("목표 전송 FPS: %s", PUBLISH_FPS)

    # -----------------------------------------------------
    # AI 모델 초기화
    # -----------------------------------------------------

    detector = None

    if os.path.exists(ONNX_MODEL_PATH):

        try:

            detector = YOLOv8ONNXDetector(
                ONNX_MODEL_PATH
            )

            logger.info(
                "추론 엔진: %s",
                detector.engine_name
            )

        except Exception as exc:

            logger.warning(
                "ONNX 모델 로드 실패: %s",
                exc
            )

    else:

        logger.warning("ONNX 모델 파일이 없습니다.")

    subtractor = cv2.createBackgroundSubtractorMOG2(
        history=100,
        varThreshold=50,
        detectShadows=False
    )

    # -----------------------------------------------------
    # 카메라 초기화
    # -----------------------------------------------------

    cap = cv2.VideoCapture(
        CAMERA_INDEX,
        cv2.CAP_DSHOW
    )

    has_real_camera = cap.isOpened()

    if not has_real_camera:

        logger.warning(
            "카메라 연결 실패. 가상 카메라 모드로 실행합니다."
        )

        cap.release()
        cap = None

    else:

        cap.set(
            cv2.CAP_PROP_BUFFERSIZE,
            1
        )

        logger.info("실제 카메라 연결 성공")

    # -----------------------------------------------------
    # 공유 상태 및 스레드 초기화
    # -----------------------------------------------------

    stop_event = threading.Event()

    frame_buffer = VisionFrameBuffer()

    stream_sender = VisionStreamSender()
    event_sender = VisionEventSender()

    camera_worker = CameraCaptureWorker(
        cap=cap,
        has_real_camera=has_real_camera,
        frame_buffer=frame_buffer,
        stop_event=stop_event
    )

    ai_worker = VisionAIWorker(
        detector=detector,
        subtractor=subtractor,
        has_real_camera=has_real_camera,
        frame_buffer=frame_buffer,
        stop_event=stop_event,
        event_sender=event_sender
    )

    # -----------------------------------------------------
    # 스레드 시작
    # -----------------------------------------------------

    stream_sender.start()
    event_sender.start()

    camera_worker.start()
    ai_worker.start()

    logger.info(
        "카메라 / AI / 이벤트 / WebSocket 스레드 시작 완료"
    )

    # -----------------------------------------------------
    # 전송 및 성능 측정 변수
    # -----------------------------------------------------

    last_published_frame_id = -1

    publish_count = 0
    publish_fps = 0.0

    publish_fps_start = time.monotonic()
    metrics_log_time = time.monotonic()

    publish_interval = 1.0 / PUBLISH_FPS
    next_publish_time = time.monotonic()

    # -----------------------------------------------------
    # 메인 루프
    # -----------------------------------------------------

    try:

        while not stop_event.is_set():

            now = time.monotonic()

            if now < next_publish_time:

                time.sleep(
                    min(
                        next_publish_time - now,
                        0.005
                    )
                )

                continue

            next_publish_time += publish_interval

            if now - next_publish_time > publish_interval * 3:
                next_publish_time = now + publish_interval

            pair = frame_buffer.get_latest_pair()

            if pair is None:
                continue

            frame_id = pair["frame_id"]

            if frame_id == last_published_frame_id:
                continue

            raw_frame = pair["raw"]
            processed_frame = pair["processed"]

            raw_jpeg = encode_jpeg(raw_frame)
            processed_jpeg = encode_jpeg(processed_frame)

            if (
                raw_jpeg is not None
                and processed_jpeg is not None
            ):

                stream_sender.publish(
                    frame_id=frame_id,
                    captured_at=pair["captured_at"],
                    inference_ms=pair["inference_ms"],
                    raw_jpeg=raw_jpeg,
                    processed_jpeg=processed_jpeg
                )

                last_published_frame_id = frame_id
                publish_count += 1

            # -------------------------------------------------
            # 전송 준비 FPS 측정
            # -------------------------------------------------

            fps_elapsed = (
                time.monotonic() - publish_fps_start
            )

            if fps_elapsed >= 1.0:

                publish_fps = publish_count / fps_elapsed

                publish_count = 0
                publish_fps_start = time.monotonic()

            # -------------------------------------------------
            # 성능 로그
            # -------------------------------------------------

            current_time = time.monotonic()

            if (
                current_time - metrics_log_time
                >= METRICS_INTERVAL
            ):

                logger.info(
                    (
                        "[성능] "
                        "카메라 %.1f FPS | "
                        "AI %.1f FPS | "
                        "전송 준비 %.1f FPS | "
                        "WebSocket %.1f FPS | "
                        "추론 %.1f ms"
                    ),
                    pair["capture_fps"],
                    pair["inference_fps"],
                    publish_fps,
                    stream_sender.get_sent_fps(),
                    pair["inference_ms"]
                )

                metrics_log_time = current_time

    except KeyboardInterrupt:

        logger.info("Ctrl+C 입력. Vision 종료")

    except Exception:

        logger.exception("Vision 메인 루프 오류")

    finally:

        logger.info("Vision 종료 처리 중")

        stop_event.set()

        with frame_buffer.condition:
            frame_buffer.condition.notify_all()

        # WebSocket 전송 중지
        stream_sender.stop()

        # 카메라 및 AI 스레드 종료 대기
        camera_worker.join(timeout=3)
        ai_worker.join(timeout=3)

        # 이벤트 전송 스레드 종료
        event_sender.stop(timeout=3)

        # 카메라 해제
        if cap is not None:
            cap.release()

        logger.info("Vision 시스템 종료 완료")


if __name__ == "__main__":
    main()
