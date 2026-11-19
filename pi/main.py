"""
main.py
--------------------------------------------------------------------------------
[라즈베리파이 5 — 학교 노래방 부스 제어 데몬 (실기기)]

02_karaoke_daemon_mock.py 는 print() 로 "하는 척"만 했습니다.
이 파일은 그 print 자리에 **진짜 GPIO 제어**를 넣고, 모의 데몬에는 없던
**실물 키패드 입력**과 **PIR 입장 감지 보고**를 추가한 것입니다.

┌─ 이 프로그램이 하는 일 (네 가지) ────────────────────────────────────┐
│ 1. 백엔드에 "지금 할 일 있나요?" 물어보기      (GET  desired-state)   │
│ 2. 지시대로 도어락·릴레이·LED 움직이기         (gpiozero)            │
│ 3. "시킨 대로 했습니다" 보고하기               (POST state)          │
│ 4. 키패드로 누른 비밀번호와 PIR 감지를 올려보내기                     │
└──────────────────────────────────────────────────────────────────────┘

★ 중요 — 백엔드는 GPIO를 직접 만지지 않습니다.
  백엔드는 학생 PC(또는 Render)에서 돌고, GPIO는 물리적으로 다른 기기인
  라즈베리파이에 있습니다. 백엔드는 "목표 상태(desired_state)"를 보관해 주는
  중계자이고, 실제로 부품을 움직이는 것은 100% 이 파일입니다.
  자세한 계약은 docs/부록A 3장을 보세요.

★ 대시보드의 '확정 상태'는 이 파일의 보고로만 바뀝니다.
  그래서 이 데몬이 꺼져 있으면 대시보드에 desired 는 바뀌는데 current 는
  그대로 남습니다. 그게 바로 "파이가 지시를 수행하지 못하고 있다"는 신호입니다.

* 실행 방법 (라즈베리파이 터미널):
    cd pi
    source venv/bin/activate
    python main.py                # Ctrl+C 로 종료

* 실행 전에 반드시:
    1) python test_hardware_gpio.py 로 배선 자가진단을 통과할 것
    2) pi/.env 의 BACKEND_URL / DEVICE_API_KEY 를 채울 것
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
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

# ==============================================================================
# 1. 설정 읽기 (pi/.env)
# ==============================================================================

load_dotenv()
os.environ.setdefault("GPIOZERO_PIN_FACTORY", "lgpio")  # 라즈베리파이 5 RP1 칩셋

BACKEND_URL = os.getenv("BACKEND_URL", "http://127.0.0.1:8000").rstrip("/")
DEVICE_API_KEY = os.getenv("DEVICE_API_KEY", "")

try:
    POLL_INTERVAL_SEC = max(0.5, float(os.getenv("POLL_INTERVAL_SEC", "3.0")))
except ValueError:
    POLL_INTERVAL_SEC = 3.0

# 스피커를 누가 울릴 것인가.
#   browser(기본) — 부스 화면(웹)이 환영 음성·퇴실곡을 재생한다. 파이는 관여하지 않는다.
#   pi            — 파이에 연결된 스피커로 espeak-ng 가 직접 읽어 준다.
# 파이가 실제로 소리를 내지 않는데 "재생했다"고 보고하면 대시보드가 거짓말을 하게
# 되므로, browser 모드에서는 speaker_1 을 아예 건드리지 않는다.
SPEAKER_MODE = os.getenv("SPEAKER_MODE", "browser").strip().lower()

HEADERS = {
    "X-Device-Api-Key": DEVICE_API_KEY,
    "Content-Type": "application/json",
}

HTTP_TIMEOUT = 5  # 초

# PIR 이 한 번 감지한 뒤 다시 보고하기까지 쉬는 시간 (사람이 서 있으면 계속 HIGH라서)
PIR_COOLDOWN_SEC = 20.0

# 키패드에서 숫자를 누르다 만 채로 자리를 뜨면 버퍼를 지우는 시간
KEYPAD_BUFFER_TIMEOUT_SEC = 8.0


# ==============================================================================
# 2. gpiozero 로드 (라즈베리파이가 아니면 여기서 친절히 멈춘다)
# ==============================================================================

import board
import neopixel
from adafruit_led_animation.animation.blink import Blink

print(neopixel.__file__)

try:
    from gpiozero import OutputDevice, LED, DigitalInputDevice
except ImportError:
    print("\n❌ [패키지 오류] gpiozero 를 찾을 수 없습니다.")
    print("라즈베리파이 5(RP1 칩셋)에서는 PyPI 빌드 오류를 피하기 위해")
    print("APT 패키지 + --system-site-packages 가상환경을 씁니다:\n")
    print("  sudo apt update && sudo apt install -y python3-gpiozero python3-lgpio")
    print("  cd pi")
    print("  python3 -m venv --system-site-packages venv")
    print("  source venv/bin/activate")
    print("  pip install -r requirements.txt\n")
    print("💡 지금이 Windows PC라면, 실기기 없이 통신만 확인하는")
    print("   python 02_karaoke_daemon_mock.py 를 대신 실행하세요.\n")
    sys.exit(1)


# ==============================================================================
# 3. 하드웨어 — GPIO를 감싼 부분
# ==============================================================================

class BoothHardware:
    """도어락·전원 릴레이·조명·PIR·키패드를 한 곳에서 다룬다."""

    def __init__(self):
        # 액추에이터. initial_value=False 로 만들어 '꺼진 상태'에서 출발한다.
        # (릴레이 극성은 booth_pins.RELAY_ACTIVE_HIGH 가 결정한다 — 그 파일 설명 참고)
        self.door = OutputDevice(
            pins.DOOR_LOCK_PIN, active_high=pins.RELAY_ACTIVE_HIGH, initial_value=False
        )
        self.relay = OutputDevice(
            pins.RELAY_POWER_PIN, active_high=pins.RELAY_ACTIVE_HIGH, initial_value=False
        )
        self.fan = OutputDevice(
            pins.FAN_PIN, active_high=pins.RELAY_ACTIVE_HIGH, initial_value=False
        )
        self.neopixel = neopixel.NeoPixel(
            board.D10,
            60,
            brightness = 0.1,
            auto_write=False
        )
        self.blink = Blink(self.neopixel, speed=0.5, color=(255, 255, 255))

        # 센서
        self.pir = DigitalInputDevice(pins.PIR_PIN)

        # 키패드: 행은 출력(평소 HIGH), 열은 입력(내부 풀업)
        self.rows = [OutputDevice(p, initial_value=True) for p in pins.KEYPAD_ROW_PINS]
        self.cols = [DigitalInputDevice(p, pull_up=True) for p in pins.KEYPAD_COL_PINS]

        self._led_blinking = False
        self._led_playing = False
        self._rainbow_offset = 0


    # ── 액추에이터 반영 ────────────────────────────────────────────────
    def apply(self, device_id: str, state: str, value=None) -> bool:
        """백엔드가 시킨 목표 상태를 실제 부품에 반영한다. 반영했으면 True."""
        if device_id == "door_lock_1":
            if state == "unlocked":
                self.door.on()
                print("   🚪 철컥! 도어락을 해제했습니다.")
            else:
                self.door.off()
                print("   🚪 딸깍! 도어락을 잠갔습니다.")
            return True

        if device_id == "relay_1":
            if state == "on":
                self.relay.on()
                print("   ⚡ 릴레이 ON — 노래방 반주기에 전원을 공급했습니다.")
            else:
                self.relay.off()
                print("   ⚡ 릴레이 OFF — 반주기 전원을 차단했습니다.")
            return True

        if device_id == "led_1":
            self._stop_blink()
            self._led_playing = False
            if state == "blink":
                self.blink.animate()
                self._led_blinking = True
                print("   💡 조명 깜빡임 — 종료 10분 전 알림을 표시합니다.")
            elif state == "on":
                self.neopixel.fill((255, 255, 255))
                self.neopixel.show()
                print("   💡 조명을 켰습니다.")
            elif state == "playing":
                self._led_playing = True
                print("   💡 playtime! — rainbow bright")
            else:
                self.neopixel.fill((0, 0, 0))
                self.neopixel.show()
                print("   💡 조명을 껐습니다.")
            return True

        if device_id == "speaker_1":
            return self._speak(value)

        if device_id == "fan_1":
            if state == "on":
                self.fan.on()
                print("   🚪 fan on")
            else:
                self.fan.off()
                print("   🚪 fan off")
            return True

        print(f"   ❓ 어떻게 다루는지 모르는 부품입니다: {device_id}")
        return False

    def _stop_blink(self):
        if self._led_blinking:
            self._led_blinking = False
            
    def update_animation(self):
        """LED ¾Ö´Ï¸ÞÀÌ¼ÇÀ» °è¼Ó °»½ÅÇÑ´Ù."""
        if self._led_blinking:
            self.blink.animate()

    def _speak(self, value) -> bool:
        """SPEAKER_MODE=pi 일 때만 파이 스피커로 읽어 준다."""
        if SPEAKER_MODE != "pi":
            return False
        message = (value or {}).get("message") if isinstance(value, dict) else None
        if not message:
            return False
        try:
            # 소리 내는 동안 폴링이 멈추면 안 되므로 기다리지 않는다(Popen)
            subprocess.Popen(
                ["espeak-ng", "-v", "ko", "-s", "150", message],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            print(f"   🔊 스피커: {message}")
            return True
        except FileNotFoundError:
            print("   ⚠️ espeak-ng 가 없어 음성을 낼 수 없습니다.")
            print("      sudo apt install -y espeak-ng  (또는 .env 에서 SPEAKER_MODE=browser)")
            return False
        except Exception as exc:
            print(f"   ⚠️ 음성 출력 실패: {exc}")
            return False

    def update_rainbow(self):
        # �������� LED �ִϸ��̼�
        if self._led_playing:
            self.neopixel.fill((0, 0, 0))

            for i in range(60):
                hue = (i * 256 // 60 + self._rainbow_offset) % 256
                self.neopixel[i] = self._wheel(hue)

            self.neopixel.show()
            self._rainbow_offset = (self._rainbow_offset + 20) % 256


    def _wheel(self, pos):
        # RGB ���� ��ȯ
        if pos < 85:
            return (255 - pos * 3, pos * 3, 0)
        elif pos < 170:
            pos -= 85
            return (0, 255 - pos * 3, pos * 3)
        else:
            pos -= 170
            return (pos * 3, 0, 255 - pos * 3)

    # ── 키패드 ────────────────────────────────────────────────────────
    def scan_keypad(self):
        """지금 눌려 있는 키 한 글자를 돌려준다. 아무것도 안 눌렸으면 None."""
        for r_i, row in enumerate(self.rows):
            row.off()  # 이 행만 LOW 로 내린다
            try:
                for c_i, col in enumerate(self.cols):
                    # pull_up=True 이므로 is_active == True 는 '핀이 LOW' = 눌림
                    if col.is_active:
                        return pins.KEYPAD_LAYOUT[r_i][c_i]
            finally:
                row.on()  # 반드시 다시 HIGH 로 되돌린다
        return None

    # ── 안전 상태 ─────────────────────────────────────────────────────
    def safe_state(self):
        """문 잠그고, 220V 끄고, 조명 끈다."""
        self._stop_blink()
        self.door.off()
        self.relay.off()
        self.neopixel.fill((0, 0, 0))
        self.neopixel.show()
        self.fan.off()

    def close(self):
        self.safe_state()
        for dev in [self.door, self.relay, self.pir, *self.rows, *self.cols]:
            try:
                dev.close()
            except Exception:
                pass
        self.neopixel.deinit()


# ==============================================================================
# 4. 백엔드와의 통신
# ==============================================================================

class BackendClient:
    """백엔드에 묻고 보고하는 부분. 어떤 실패도 프로그램을 멈추지 않는다."""

    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update(HEADERS)
        self._offline_notified = False

    def _log_offline(self, what: str, exc: Exception):
        # 인터넷이 끊기면 매 루프마다 같은 줄이 쏟아져 화면을 덮는다.
        # 처음 한 번만 자세히 알리고, 복구되면 다시 알린다.
        if not self._offline_notified:
            print(f"\n❌ [백엔드 연결 실패] {what}: {exc}")
            print(f"   1) 백엔드가 켜져 있는지  2) BACKEND_URL({BACKEND_URL})이 맞는지")
            print("   3) 파이와 백엔드 PC가 같은 공유기에 붙어 있는지 확인하세요.")
            print("   (연결될 때까지 조용히 재시도합니다)")
            self._offline_notified = True

    def _mark_online(self):
        if self._offline_notified:
            print("\n✅ [백엔드 재연결] 통신이 복구되었습니다.")
            self._offline_notified = False

    def get_desired(self, device_id: str):
        """목표 상태를 물어본다. (desired_state, value) 또는 None."""
        try:
            res = self.session.get(
                f"{BACKEND_URL}/api/v1/devices/{device_id}/desired-state",
                timeout=HTTP_TIMEOUT,
            )
        except requests.exceptions.RequestException as exc:
            self._log_offline(f"{device_id} 목표 상태 조회", exc)
            return None

        self._mark_online()

        if res.status_code == 401:
            print(f"🚨 [인증 실패 401] {device_id}: DEVICE_API_KEY 가 백엔드와 다릅니다.")
            return None
        if res.status_code == 404:
            print(f"🔍 [부품 없음 404] {device_id}: devices 테이블에 없는 id 입니다.")
            return None
        if res.status_code != 200:
            print(f"⚠️ [응답 이상 {res.status_code}] {device_id}: {res.text[:120]}")
            return None

        data = res.json().get("data", {})
        return data.get("desired_state"), data.get("value")

    def report_state(self, device_id: str, state: str, value=None) -> bool:
        """반영 결과를 보고한다. 성공하면 True."""
        try:
            res = self.session.post(
                f"{BACKEND_URL}/api/v1/devices/{device_id}/state",
                json={"state": state, "value": value},
                timeout=HTTP_TIMEOUT,
            )
        except requests.exceptions.RequestException as exc:
            self._log_offline(f"{device_id} 상태 보고", exc)
            return False

        self._mark_online()
        if res.status_code == 200:
            print(f"   📤 보고 완료 — 대시보드에 '{state}' 로 확정 표시됩니다.")
            return True
        print(f"   ⚠️ 보고 실패 (코드 {res.status_code}) — 다음 폴링에서 다시 시도합니다.")
        return False

    def verify_pin(self, pin_code: str):
        """키패드로 누른 4자리를 백엔드에 검증 요청한다."""
        try:
            res = self.session.post(
                f"{BACKEND_URL}/api/booth/verify-keypad",
                json={"pin": pin_code},
                timeout=HTTP_TIMEOUT,
            )
        except requests.exceptions.RequestException as exc:
            self._log_offline("키패드 인증", exc)
            return None

        self._mark_online()
        body = {}
        try:
            body = res.json()
        except ValueError:
            pass

        if res.status_code == 200:
            return {"success": True, "message": body.get("data", {}).get("message", "인증 성공")}
        return {
            "success": False,
            "message": body.get("error", {}).get("message", f"인증 실패 (코드 {res.status_code})"),
        }

    def report_entry(self) -> bool:
        """PIR 감지를 입장 이벤트로 올린다 (백엔드가 환영 안내를 트리거한다)."""
        ok = False
        try:
            res = self.session.post(
                f"{BACKEND_URL}/api/v1/vision/events",
                json={"event_type": "person_detected", "detected": True, "count": 1},
                timeout=HTTP_TIMEOUT,
            )
            ok = res.status_code == 200
            self._mark_online()
        except requests.exceptions.RequestException as exc:
            self._log_offline("입장 감지 보고", exc)
            return False

        # 센서 이력에도 남긴다 (대시보드의 pir_1 행이 갱신된다)
        try:
            self.session.post(
                f"{BACKEND_URL}/api/v1/devices/pir_1/state",
                json={"value": 1, "unit": "detection"},
                timeout=HTTP_TIMEOUT,
            )
        except requests.exceptions.RequestException:
            pass
        return ok


# ==============================================================================
# 5. 메인 루프
# ==============================================================================

def actuator_ids():
    """폴링할 액추에이터 목록. 스피커는 파이가 실제로 울릴 때만 포함한다."""
    ids = ["door_lock_1", "relay_1", "led_1", "fan_1"]
    if SPEAKER_MODE == "pi":
        ids.append("speaker_1")
    return ids


def main():
    if not DEVICE_API_KEY:
        print("\n❌ pi/.env 의 DEVICE_API_KEY 가 비어 있습니다.")
        print("   backend/.env 의 DEVICE_API_KEY 와 똑같은 값을 넣어 주세요.\n")
        sys.exit(1)

    print("=" * 72)
    print("🎤 [라즈베리파이 5] 학교 노래방 부스 제어 데몬 — 실기기 모드")
    print("=" * 72)
    print(f"📍 백엔드 주소   : {BACKEND_URL}")
    print(f"🔑 출입증(API키) : {DEVICE_API_KEY[:6]}********")
    print(f"⏱️ 폴링 주기     : {POLL_INTERVAL_SEC}초")
    print(f"🔊 스피커        : {SPEAKER_MODE}"
          f"{'  (부스 웹 화면이 소리를 냅니다)' if SPEAKER_MODE != 'pi' else '  (파이 스피커가 읽어 줍니다)'}")
    print("🔌 GPIO 배치")
    print(pins.describe())
    print("-" * 72)
    print("종료하려면 Ctrl + C 를 누르세요.")
    print("=" * 72)

    hw = BoothHardware()
    api = BackendClient()

    # 시작할 때는 무조건 안전 상태에서 출발하고, 그 사실을 백엔드에 알린다.
    # (그래야 대시보드의 '확정 상태'가 실제 하드웨어와 같은 지점에서 시작한다.
    #  백엔드에 남아 있던 목표 상태는 첫 폴링에서 자동으로 다시 반영된다.)
    hw.safe_state()
    print("\n🔒 안전 상태로 초기화 — 도어락 잠금 / 전원 차단 / 조명 소등")
    for device_id, state in [("door_lock_1", "locked"), ("relay_1", "off"), ("led_1", "off")]:
        api.report_state(device_id, state)

    # 내가 아는 각 부품의 현재 상태
    my_state = {"door_lock_1": "locked", "relay_1": "off", "led_1": "off", "speaker_1": "idle", "fan_1": "off"}
    pending = {}          # 보고하지 못한 것 — 다음 루프에서 다시 보낸다
    pin_buffer = ""       # 키패드로 누르는 중인 숫자
    last_key = None       # 같은 키가 연속으로 읽히는 것(채터링) 방지
    last_key_time = 0.0
    last_poll_time = 0.0
    last_pir_report = 0.0
    loop_count = 0

    try:
        while True:
            now = time.monotonic()

            # ── (1) 키패드: 사람이 누르는 것이라 자주 봐야 한다 ──────────
            key = hw.scan_keypad()
            if key != last_key:
                last_key = key
                if key is not None:
                    last_key_time = now
                    if key == "*":
                        pin_buffer = ""
                        print("\n⌨️  입력을 지웠습니다.")
                    elif key.isdigit():
                        pin_buffer += key
                        print(f"\n⌨️  입력 중: {'●' * len(pin_buffer)}")

                    if len(pin_buffer) == 4:
                        print("🔐 비밀번호 4자리 → 백엔드에 확인을 요청합니다...")
                        result = api.verify_pin(pin_buffer)
                        pin_buffer = ""
                        if result is None:
                            print("   ⚠️ 백엔드에 닿지 못해 확인할 수 없습니다.")
                        elif result["success"]:
                            print(f"   ✅ {result['message']}")
                            print("   (도어락·전원은 다음 폴링에서 백엔드 지시대로 열립니다)")
                            last_poll_time = 0.0  # 기다리지 말고 곧바로 폴링
                        else:
                            print(f"   ❌ {result['message']}")

            # 누르다 만 입력은 일정 시간 뒤 지운다
            if pin_buffer and (now - last_key_time) > KEYPAD_BUFFER_TIMEOUT_SEC:
                pin_buffer = ""
                print("\n⌨️  입력이 없어 비밀번호 입력을 초기화했습니다.")

            # ── (2) PIR 입장 감지 ───────────────────────────────────────
            if hw.pir.is_active and (now - last_pir_report) > PIR_COOLDOWN_SEC:
                last_pir_report = now
                print("\n👀 [입장 감지] 부스 앞에서 사람이 감지되었습니다.")
                api.report_entry()

            # ── (3) 주기 폴링: 백엔드의 지시 확인 ───────────────────────
            if (now - last_poll_time) >= POLL_INTERVAL_SEC:
                last_poll_time = now
                loop_count += 1

                # 지난번에 실패한 보고부터 정리
                for device_id, (state, value) in list(pending.items()):
                    if api.report_state(device_id, state, value):
                        del pending[device_id]

                for device_id in actuator_ids():
                    result = api.get_desired(device_id)
                    if result is None:
                        continue
                    desired_state, desired_value = result
                    if not desired_state or desired_state == my_state.get(device_id):
                        continue

                    print("\n" + "-" * 60)
                    print(f"📬 [지시] {device_id}: {my_state.get(device_id)} → {desired_state}")
                    if hw.apply(device_id, desired_state, desired_value):
                        my_state[device_id] = desired_state
                        if not api.report_state(device_id, desired_state, desired_value):
                            pending[device_id] = (desired_state, desired_value)
                    print("-" * 60)

                sys.stdout.write(f"\r💓 동작 중... (폴링 {loop_count}회) [Ctrl+C 종료]")
                sys.stdout.flush()

            # 키패드를 놓치지 않을 만큼 자주, CPU는 거의 쓰지 않을 만큼 쉰다
            hw.update_animation()
            hw.update_rainbow()
            time.sleep(0.05)

    except KeyboardInterrupt:
        print("\n\n👋 종료 요청을 받았습니다.")
    finally:
        print("🔒 안전 상태로 되돌립니다 — 도어락 잠금 / 전원 차단 / 조명 소등")
        hw.safe_state()
        for device_id, state in [("door_lock_1", "locked"), ("relay_1", "off"), ("led_1", "off")]:
            api.report_state(device_id, state)
        hw.close()
        print("\n💡 데몬을 끈 뒤 대시보드에서 desired 와 current 가 달라 보일 수 있습니다.")
        print("   고장이 아니라 사실을 그대로 보여 주는 것입니다 —")
        print("   '백엔드는 아직 열라고 하는데, 실기기는 안전하게 잠겨 있다'는 뜻이고,")
        print("   데몬을 다시 켜면 첫 폴링에서 목표 상태대로 자동 복귀합니다.")
        print("수고하셨습니다!\n")


if __name__ == "__main__":
    main()
