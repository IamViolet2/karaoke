"""
main.py
--------------------------------------------------------------------------------
[라즈베리파이 5 — 학교 노래방 부스 제어 데몬 (실기기)]

실제 GPIO 제어, 실물 키패드 입력, PIR 입장 감지 및
백엔드 desired-state 통신을 담당합니다.

제어 장치:
  1. door_lock_1 : 도어락
  2. relay_1     : 노래방 반주기 전원
  3. led_1       : 부스 조명
  4. fan_1       : 선풍기 (GPIO 18, HIGH=ON)
  5. speaker_1   : 파이 스피커 (SPEAKER_MODE=pi일 때)

백엔드는 GPIO를 직접 제어하지 않습니다.
백엔드가 desired_state를 보관하고, 이 데몬이 실제 GPIO를 제어합니다.
--------------------------------------------------------------------------------
"""

import os
import subprocess
import sys
import time

import requests
from dotenv import load_dotenv

import booth_pins as pins


if sys.platform == "win32":
    import io

    sys.stdout = io.TextIOWrapper(
        sys.stdout.buffer,
        encoding="utf-8",
        errors="replace",
    )
    sys.stderr = io.TextIOWrapper(
        sys.stderr.buffer,
        encoding="utf-8",
        errors="replace",
    )


# ==============================================================================
# 1. 설정 읽기 (pi/.env)
# ==============================================================================

load_dotenv()

os.environ.setdefault("GPIOZERO_PIN_FACTORY", "lgpio")

BACKEND_URL = os.getenv(
    "BACKEND_URL",
    "http://127.0.0.1:8000",
).rstrip("/")

DEVICE_API_KEY = os.getenv("DEVICE_API_KEY", "")

try:
    POLL_INTERVAL_SEC = max(
        0.5,
        float(os.getenv("POLL_INTERVAL_SEC", "3.0")),
    )
except ValueError:
    POLL_INTERVAL_SEC = 3.0


# 스피커 모드
# browser: 웹 화면이 음성을 재생
# pi: 라즈베리파이가 espeak-ng로 음성을 재생
SPEAKER_MODE = os.getenv(
    "SPEAKER_MODE",
    "browser",
).strip().lower()


HEADERS = {
    "X-Device-Api-Key": DEVICE_API_KEY,
    "Content-Type": "application/json",
}

HTTP_TIMEOUT = 5

PIR_COOLDOWN_SEC = 20.0
KEYPAD_BUFFER_TIMEOUT_SEC = 8.0


# ==============================================================================
# 2. gpiozero 로드
# ==============================================================================

try:
    from gpiozero import OutputDevice, LED, DigitalInputDevice

except ImportError:
    print("\n❌ [패키지 오류] gpiozero를 찾을 수 없습니다.")
    print("라즈베리파이 5에서는 다음 패키지를 설치하세요.\n")

    print(
        "  sudo apt update && "
        "sudo apt install -y python3-gpiozero python3-lgpio"
    )
    print("  cd pi")
    print("  python3 -m venv --system-site-packages venv")
    print("  source venv/bin/activate")
    print("  pip install -r requirements.txt\n")

    print(
        "💡 Windows PC에서는 실제 GPIO를 제어할 수 없습니다."
    )
    print(
        "   통신 테스트에는 02_karaoke_daemon_mock.py를 사용하세요.\n"
    )

    sys.exit(1)


# ==============================================================================
# 3. 하드웨어 — GPIO 제어
# ==============================================================================

class BoothHardware:
    """도어락·전원·조명·선풍기·PIR·키패드를 관리합니다."""

    def __init__(self):

        # 도어락
        self.door = OutputDevice(
            pins.DOOR_LOCK_PIN,
            active_high=pins.RELAY_ACTIVE_HIGH,
            initial_value=False,
        )

        # 노래방 반주기 전원
        self.relay = OutputDevice(
            pins.RELAY_POWER_PIN,
            active_high=pins.RELAY_ACTIVE_HIGH,
            initial_value=False,
        )

        # 부스 조명
        self.led = LED(pins.LED_PIN)

        # 선풍기 릴레이
        # GPIO 18 HIGH = 선풍기 ON
        # GPIO 18 LOW  = 선풍기 OFF
        #
        # 다른 릴레이의 RELAY_ACTIVE_HIGH 설정과 무관하게
        # 선풍기는 active_high=True로 고정합니다.
        self.fan = OutputDevice(
            pins.FAN_PIN,
            active_high=True,
            initial_value=False,
        )

        # PIR 센서
        self.pir = DigitalInputDevice(pins.PIR_PIN)

        # 키패드
        self.rows = [
            OutputDevice(p, initial_value=True)
            for p in pins.KEYPAD_ROW_PINS
        ]

        self.cols = [
            DigitalInputDevice(p, pull_up=True)
            for p in pins.KEYPAD_COL_PINS
        ]

        self._led_blinking = False

    # ------------------------------------------------------------------
    # 액추에이터 제어
    # ------------------------------------------------------------------

    def apply(
        self,
        device_id: str,
        state: str,
        value=None,
    ) -> bool:
        """백엔드의 목표 상태를 실제 하드웨어에 반영합니다."""

        # 도어락
        if device_id == "door_lock_1":

            if state == "unlocked":
                self.door.on()
                print("   🚪 도어락 잠금 해제")

            else:
                self.door.off()
                print("   🚪 도어락 잠금")

            return True

        # 노래방 전원
        if device_id == "relay_1":

            if state == "on":
                self.relay.on()
                print("   ⚡ 노래방 반주기 전원 ON")

            else:
                self.relay.off()
                print("   ⚡ 노래방 반주기 전원 OFF")

            return True

        # 조명
        if device_id == "led_1":

            self._stop_blink()

            if state == "blink":

                self.led.blink(
                    on_time=0.4,
                    off_time=0.4,
                    background=True,
                )

                self._led_blinking = True

                print("   💡 조명 깜빡임")

            elif state == "on":

                self.led.on()
                print("   💡 조명 ON")

            else:

                self.led.off()
                print("   💡 조명 OFF")

            return True

        # 선풍기
        if device_id == "fan_1":

            if state == "on":

                self.fan.on()
                print(
                    "   🌀 선풍기 ON — GPIO 18 HIGH"
                )

            elif state == "off":

                self.fan.off()
                print(
                    "   🌀 선풍기 OFF — GPIO 18 LOW"
                )

            else:

                print(
                    f"   ⚠️ 선풍기에서 지원하지 않는 상태입니다: {state}"
                )

                return False

            return True

        # 스피커
        if device_id == "speaker_1":

            return self._speak(value)

        print(
            f"   ❓ 알 수 없는 장치입니다: {device_id}"
        )

        return False

    # ------------------------------------------------------------------
    # LED 제어 보조 함수
    # ------------------------------------------------------------------

    def _stop_blink(self):

        if self._led_blinking:

            self.led.off()
            self._led_blinking = False

    # ------------------------------------------------------------------
    # 스피커
    # ------------------------------------------------------------------

    def _speak(self, value) -> bool:

        if SPEAKER_MODE != "pi":
            return False

        message = (
            (value or {}).get("message")
            if isinstance(value, dict)
            else None
        )

        if not message:
            return False

        try:

            subprocess.Popen(
                [
                    "espeak-ng",
                    "-v",
                    "ko",
                    "-s",
                    "150",
                    message,
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )

            print(f"   🔊 스피커: {message}")

            return True

        except FileNotFoundError:

            print("   ⚠️ espeak-ng가 설치되어 있지 않습니다.")
            print(
                "      sudo apt install -y espeak-ng"
            )

            return False

        except Exception as exc:

            print(f"   ⚠️ 음성 출력 실패: {exc}")

            return False

    # ------------------------------------------------------------------
    # 키패드
    # ------------------------------------------------------------------

    def scan_keypad(self):

        for r_i, row in enumerate(self.rows):

            row.off()

            try:

                for c_i, col in enumerate(self.cols):

                    if col.is_active:

                        return pins.KEYPAD_LAYOUT[r_i][c_i]

            finally:

                row.on()

        return None

    # ------------------------------------------------------------------
    # 안전 상태
    # ------------------------------------------------------------------

    def safe_state(self):
        """모든 출력 장치를 안전한 OFF 상태로 전환합니다."""

        self._stop_blink()

        self.door.off()
        self.relay.off()
        self.led.off()

        # 선풍기 릴레이 OFF
        self.fan.off()

    # ------------------------------------------------------------------
    # GPIO 자원 해제
    # ------------------------------------------------------------------

    def close(self):

        self.safe_state()

        devices = [
            self.door,
            self.relay,
            self.led,
            self.fan,
            self.pir,
            *self.rows,
            *self.cols,
        ]

        for dev in devices:

            try:
                dev.close()

            except Exception:
                pass


# ==============================================================================
# 4. 백엔드 통신
# ==============================================================================

class BackendClient:
    """백엔드에 목표 상태를 요청하고 실제 상태를 보고합니다."""

    def __init__(self):

        self.session = requests.Session()
        self.session.headers.update(HEADERS)

        self._offline_notified = False

    def _log_offline(self, what: str, exc: Exception):

        if not self._offline_notified:

            print(
                f"\n❌ [백엔드 연결 실패] {what}: {exc}"
            )

            print(
                f"   BACKEND_URL: {BACKEND_URL}"
            )

            print(
                "   백엔드와 네트워크 연결을 확인하세요."
            )

            self._offline_notified = True

    def _mark_online(self):

        if self._offline_notified:

            print(
                "\n✅ [백엔드 재연결] 통신이 복구되었습니다."
            )

            self._offline_notified = False

    # ------------------------------------------------------------------
    # 목표 상태 조회
    # ------------------------------------------------------------------

    def get_desired(self, device_id: str):

        try:

            res = self.session.get(
                f"{BACKEND_URL}/api/v1/devices/{device_id}/desired-state",
                timeout=HTTP_TIMEOUT,
            )

        except requests.exceptions.RequestException as exc:

            self._log_offline(
                f"{device_id} 목표 상태 조회",
                exc,
            )

            return None

        self._mark_online()

        if res.status_code == 401:

            print(
                f"🚨 [인증 실패 401] {device_id}: DEVICE_API_KEY 확인 필요"
            )

            return None

        if res.status_code == 404:

            print(
                f"🔍 [장치 없음 404] {device_id}: "
                "백엔드 장치 등록 여부를 확인하세요."
            )

            return None

        if res.status_code != 200:

            print(
                f"⚠️ [응답 이상 {res.status_code}] "
                f"{device_id}: {res.text[:120]}"
            )

            return None

        data = res.json().get("data", {})

        return (
            data.get("desired_state"),
            data.get("value"),
        )

    # ------------------------------------------------------------------
    # 실제 상태 보고
    # ------------------------------------------------------------------

    def report_state(
        self,
        device_id: str,
        state: str,
        value=None,
    ) -> bool:

        try:

            res = self.session.post(
                f"{BACKEND_URL}/api/v1/devices/{device_id}/state",
                json={
                    "state": state,
                    "value": value,
                },
                timeout=HTTP_TIMEOUT,
            )

        except requests.exceptions.RequestException as exc:

            self._log_offline(
                f"{device_id} 상태 보고",
                exc,
            )

            return False

        self._mark_online()

        if res.status_code == 200:

            print(
                f"   📤 보고 완료 — {device_id}: {state}"
            )

            return True

        print(
            f"   ⚠️ 보고 실패: {device_id} "
            f"(HTTP {res.status_code})"
        )

        return False

    # ------------------------------------------------------------------
    # 키패드 PIN 인증
    # ------------------------------------------------------------------

    def verify_pin(self, pin_code: str):

        try:

            res = self.session.post(
                f"{BACKEND_URL}/api/booth/verify-keypad",
                json={
                    "pin": pin_code,
                },
                timeout=HTTP_TIMEOUT,
            )

        except requests.exceptions.RequestException as exc:

            self._log_offline(
                "키패드 인증",
                exc,
            )

            return None

        self._mark_online()

        body = {}

        try:

            body = res.json()

        except ValueError:
            pass

        if res.status_code == 200:

            return {
                "success": True,
                "message": body.get(
                    "data",
                    {},
                ).get(
                    "message",
                    "인증 성공",
                ),
            }

        return {
            "success": False,
            "message": body.get(
                "error",
                {},
            ).get(
                "message",
                f"인증 실패 (코드 {res.status_code})",
            ),
        }

    # ------------------------------------------------------------------
    # PIR 입장 감지 보고
    # ------------------------------------------------------------------

    def report_entry(self) -> bool:

        ok = False

        try:

            res = self.session.post(
                f"{BACKEND_URL}/api/v1/vision/events",
                json={
                    "event_type": "person_detected",
                    "detected": True,
                    "count": 1,
                },
                timeout=HTTP_TIMEOUT,
            )

            ok = res.status_code == 200

            self._mark_online()

        except requests.exceptions.RequestException as exc:

            self._log_offline(
                "입장 감지 보고",
                exc,
            )

            return False

        # PIR 센서 이력 보고
        try:

            self.session.post(
                f"{BACKEND_URL}/api/v1/devices/pir_1/state",
                json={
                    "value": 1,
                    "unit": "detection",
                },
                timeout=HTTP_TIMEOUT,
            )

        except requests.exceptions.RequestException:
            pass

        return ok


# ==============================================================================
# 5. 메인 루프
# ==============================================================================

def actuator_ids():
    """백엔드에서 목표 상태를 조회할 액추에이터 목록입니다."""

    ids = [
        "door_lock_1",
        "relay_1",
        "led_1",
        "fan_1",
    ]

    if SPEAKER_MODE == "pi":

        ids.append("speaker_1")

    return ids


def main():

    if not DEVICE_API_KEY:

        print(
            "\n❌ pi/.env의 DEVICE_API_KEY가 비어 있습니다."
        )

        print(
            "   backend/.env의 DEVICE_API_KEY와 동일하게 설정하세요.\n"
        )

        sys.exit(1)

    print("=" * 72)

    print(
        "🎤 [라즈베리파이 5] 학교 노래방 부스 제어 데몬 — 실기기 모드"
    )

    print("=" * 72)

    print(f"📍 백엔드 주소   : {BACKEND_URL}")
    print(f"🔑 출입증(API키) : {DEVICE_API_KEY[:6]}********")
    print(f"⏱️ 폴링 주기     : {POLL_INTERVAL_SEC}초")

    print(
        f"🔊 스피커        : {SPEAKER_MODE}"
    )

    print("🔌 GPIO 배치")
    print(pins.describe())

    print("-" * 72)
    print("종료하려면 Ctrl+C를 누르세요.")
    print("=" * 72)

    hw = BoothHardware()
    api = BackendClient()

    # 시작 시 모든 출력 장치를 안전 상태로 초기화
    hw.safe_state()

    print(
        "\n🔒 안전 상태 초기화 완료"
        " — 도어락 잠금 / 반주기 전원 차단 / 조명 소등 / 선풍기 OFF"
    )

    startup_states = [
        ("door_lock_1", "locked"),
        ("relay_1", "off"),
        ("led_1", "off"),
        ("fan_1", "off"),
    ]

    for device_id, state in startup_states:

        api.report_state(
            device_id,
            state,
        )

    # 현재 상태
    my_state = {
        "door_lock_1": "locked",
        "relay_1": "off",
        "led_1": "off",
        "fan_1": "off",
        "speaker_1": "idle",
    }

    # 상태 보고 재시도 대기열
    pending = {}

    # 키패드
    pin_buffer = ""
    last_key = None
    last_key_time = 0.0

    # 폴링 및 센서 시간
    last_poll_time = 0.0
    last_pir_report = 0.0

    loop_count = 0

    try:

        while True:

            now = time.monotonic()

            # ==========================================================
            # (1) 키패드
            # ==========================================================

            key = hw.scan_keypad()

            if key != last_key:

                last_key = key

                if key is not None:

                    last_key_time = now

                    if key == "*":

                        pin_buffer = ""

                        print(
                            "\n⌨️ 입력을 지웠습니다."
                        )

                    elif key.isdigit():

                        pin_buffer += key

                        print(
                            f"\n⌨️ 입력 중: {'●' * len(pin_buffer)}"
                        )

                    if len(pin_buffer) == 4:

                        print(
                            "🔐 비밀번호 4자리 → 백엔드 인증 요청"
                        )

                        result = api.verify_pin(
                            pin_buffer
                        )

                        pin_buffer = ""

                        if result is None:

                            print(
                                "   ⚠️ 백엔드에 연결할 수 없습니다."
                            )

                        elif result["success"]:

                            print(
                                f"   ✅ {result['message']}"
                            )

                            print(
                                "   도어락과 전원은 다음 폴링에서 제어됩니다."
                            )

                            last_poll_time = 0.0

                        else:

                            print(
                                f"   ❌ {result['message']}"
                            )

            # 입력 시간 초과
            if (
                pin_buffer
                and (now - last_key_time) > KEYPAD_BUFFER_TIMEOUT_SEC
            ):

                pin_buffer = ""

                print(
                    "\n⌨️ 입력 시간 초과 — 입력을 초기화했습니다."
                )

            # ==========================================================
            # (2) PIR 입장 감지
            # ==========================================================

            if (
                hw.pir.is_active
                and (now - last_pir_report) > PIR_COOLDOWN_SEC
            ):

                last_pir_report = now

                print(
                    "\n👀 [입장 감지] 부스 앞에서 사람이 감지되었습니다."
                )

                api.report_entry()

            # ==========================================================
            # (3) 백엔드 폴링
            # ==========================================================

            if (now - last_poll_time) >= POLL_INTERVAL_SEC:

                last_poll_time = now
                loop_count += 1

                # 이전 상태 보고 실패 재시도
                for device_id, (state, value) in list(pending.items()):

                    if api.report_state(
                        device_id,
                        state,
                        value,
                    ):

                        del pending[device_id]

                # 모든 액추에이터 목표 상태 조회
                for device_id in actuator_ids():

                    result = api.get_desired(
                        device_id
                    )

                    if result is None:
                        continue

                    desired_state, desired_value = result

                    if not desired_state:
                        continue

                    if desired_state == my_state.get(device_id):
                        continue

                    print("\n" + "-" * 60)

                    print(
                        f"📬 [지시] {device_id}: "
                        f"{my_state.get(device_id)} → {desired_state}"
                    )

                    if hw.apply(
                        device_id,
                        desired_state,
                        desired_value,
                    ):

                        my_state[device_id] = desired_state

                        if not api.report_state(
                            device_id,
                            desired_state,
                            desired_value,
                        ):

                            pending[device_id] = (
                                desired_state,
                                desired_value,
                            )

                    print("-" * 60)

                sys.stdout.write(
                    f"\r💓 동작 중... (폴링 {loop_count}회) [Ctrl+C 종료]"
                )

                sys.stdout.flush()

            # 키패드 스캔 주기
            time.sleep(0.05)

    except KeyboardInterrupt:

        print(
            "\n\n👋 종료 요청을 받았습니다."
        )

    finally:

        print(
            "\n🔒 안전 상태로 되돌립니다."
            " — 도어락 잠금 / 반주기 전원 차단 / 조명 소등 / 선풍기 OFF"
        )

        hw.safe_state()

        shutdown_states = [
            ("door_lock_1", "locked"),
            ("relay_1", "off"),
            ("led_1", "off"),
            ("fan_1", "off"),
        ]

        for device_id, state in shutdown_states:

            api.report_state(
                device_id,
                state,
            )

        hw.close()

        print(
            "\n💡 데몬 종료 시 모든 출력 장치는 안전 상태로 전환됩니다."
        )

        print(
            "   데몬을 다시 실행하면 백엔드의 목표 상태를 다시 확인합니다."
        )

        print(
            "수고하셨습니다!\n"
        )


if __name__ == "__main__":

    main()