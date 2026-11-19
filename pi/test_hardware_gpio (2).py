"""
test_hardware_gpio.py
--------------------------------------------------------------------------------
[라즈베리파이 5 담당자를 위한 노래방 부스 하드웨어 배선 및 GPIO 1분 자가진단 도구]

* 목적:
  - 백엔드 연결 전, 라즈베리파이 5의 물리 부품(솔레노이드 도어락, 기기 전원 릴레이,
    부스 조명 LED, PIR 인체감지 센서)이 정상 작동하는지 확인합니다.
  - RP1 칩셋 환경에서 lgpio 및 gpiozero 핀 팩토리가 정상 로드되는지 검증합니다.

* 실행 방법 (라즈베리파이 터미널):
  python test_hardware_gpio.py
--------------------------------------------------------------------------------
"""

import os
import sys
import time
from dotenv import load_dotenv

if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

load_dotenv()

# GPIOZERO Pin Factory 기본값 설정 (라즈베리파이 5 RP1 칩셋 대응)
os.environ.setdefault("GPIOZERO_PIN_FACTORY", "lgpio")

print("=" * 65)
print("🎤 [라즈베리파이 5] 노래방 부스 GPIO 하드웨어 배선 자가진단 도구")
print("=" * 65)

# 1. gpiozero 및 lgpio 라이브러리 로드 검증
try:
    from gpiozero import OutputDevice, LED, DigitalInputDevice
    from gpiozero.pins.lgpio import LGPIOFactory
    print("✅ [패키지 확인] gpiozero 및 lgpio 모듈이 정상적으로 로드되었습니다.")
except ImportError as e:
    print("\n❌ [패키지 오류] gpiozero 또는 lgpio 라이브러리를 찾을 수 없습니다.")
    print("라즈베리파이 5(RP1 칩셋)에서는 PyPI pip 빌드 오류를 방지하기 위해")
    print("OS 기본 APT 패키지와 --system-site-packages 가상환경을 사용해야 합니다:\n")
    print("  1) 시스템 APT 패키지 설치:")
    print("     sudo apt update && sudo apt install -y python3-gpiozero python3-lgpio\n")
    print("  2) 가상환경 생성 (시스템 패키지 상속):")
    print("     cd pi")
    print("     python3 -m venv --system-site-packages venv")
    print("     source venv/bin/activate\n")
    print("  3) 순수 Python 의존성 설치:")
    print("     pip install -r requirements.txt\n")
    if sys.platform == "win32":
        print("💡 (안내: 현재 Windows PC 환경입니다. 실제 GPIO 배선 테스트는 라즈베리파이 5에서 실행하세요.)\n")
    sys.exit(1)

# 2. 노래방 부스 핀 번호 — booth_pins.py 한 곳에만 적는다.
#    여기에 복사해 두면 main.py와 어긋나서, GPIO27을 LED로 알고 배선했다가
#    220V 전원 릴레이를 건드리는 사고가 난다. (그 설명은 booth_pins.py 참고)
from booth_pins import (
    DOOR_LOCK_PIN,
    RELAY_POWER_PIN,
    LED_PIN,
    PIR_PIN,
    KEYPAD_ROW_PINS,
    KEYPAD_COL_PINS,
    RELAY_ACTIVE_HIGH,
)


def test_door_lock():
    print(f"\n[1/5] 솔레노이드 도어락 릴레이 테스트 (GPIO {DOOR_LOCK_PIN})...")
    try:
        door = OutputDevice(DOOR_LOCK_PIN, active_high=RELAY_ACTIVE_HIGH, initial_value=False)
        print("  🚪 철컥! 도어락 해제 (HIGH - 부스 문 열림, 1.5초간 유지)...")
        door.on()
        time.sleep(1.5)
        print("  🚪 딸깍! 도어락 잠금 (LOW - 부스 문 잠김)...")
        door.off()
        door.close()
        print("  ✅ 솔레노이드 도어락 테스트 완료")
    except Exception as e:
        print(f"  ⚠️ 도어락 테스트 실패: {e}")


def test_power_relay():
    print(f"\n[2/5] 반주기/앰프 기기 전원 릴레이 테스트 (GPIO {RELAY_POWER_PIN})...")
    try:
        relay = OutputDevice(RELAY_POWER_PIN, active_high=RELAY_ACTIVE_HIGH, initial_value=False)
        print("  ⚡ 릴레이 작동! 노래방 반주기 전원 공급 (HIGH - 1.5초간 유지)...")
        relay.on()
        time.sleep(1.5)
        print("  ⚡ 릴레이 차단! 노래방 반주기 전원 OFF (LOW)...")
        relay.off()
        relay.close()
        print("  ✅ 기기 전원 릴레이 테스트 완료")
    except Exception as e:
        print(f"  ⚠️ 기기 전원 릴레이 테스트 실패: {e}")


def test_booth_led():
    print(f"\n[3/5] 부스 실내 조명 LED 테스트 (GPIO {LED_PIN})...")
    try:
        led = LED(LED_PIN)
        print("  💡 LED 켜짐 (1초 유지)...")
        led.on()
        time.sleep(1.0)
        print("  💡 LED 깜빡임 테스트 (종료 10분 전 알림 시뮬레이션: 0.3초 주기 3회)...")
        led.blink(on_time=0.3, off_time=0.3, n=3, background=False)
        led.off()
        led.close()
        print("  ✅ 부스 조명 LED 테스트 완료")
    except Exception as e:
        print(f"  ⚠️ 조명 LED 테스트 실패: {e}")


def test_pir_sensor():
    print(f"\n[4/5] PIR 인체감지 센서 읽기 테스트 (GPIO {PIR_PIN})...")
    try:
        pir = DigitalInputDevice(PIR_PIN)
        state_str = "감지됨 (사람 있음) 🚶" if pir.is_active else "미감지 (빈 부스) 🈳"
        print(f"  👀 현재 감지 상태: {state_str} (디지털 값: {pir.value})")
        print("  💡 (센서 앞을 손으로 가리거나 움직이면 값이 1(HIGH)로 변경됩니다)")
        pir.close()
        print("  ✅ PIR 인체감지 센서 읽기 완료")
    except Exception as e:
        print(f"  ⚠️ PIR 센서 테스트 실패: {e}")


def test_keypad_pins():
    print(f"\n[5/5] 4x4 매트릭스 키패드 핀 배선 점검...")
    print(f"  🔢 행(Row) 핀: GPIO {KEYPAD_ROW_PINS}")
    print(f"  🔢 열(Col) 핀: GPIO {KEYPAD_COL_PINS}")
    try:
        # 핀 할당 가능 여부 기본 점검
        rows = [OutputDevice(pin, initial_value=False) for pin in KEYPAD_ROW_PINS]
        cols = [DigitalInputDevice(pin, pull_up=True) for pin in KEYPAD_COL_PINS]
        for r in rows:
            r.close()
        for c in cols:
            c.close()
        print("  ✅ 키패드 8개 GPIO 핀 할당 점검 완료")
    except Exception as e:
        print(f"  ⚠️ 키패드 핀 점검 경고: {e}")


if __name__ == "__main__":
    print(f"[*] GPIOZERO_PIN_FACTORY = {os.environ.get('GPIOZERO_PIN_FACTORY')}")
    print(f"[*] RELAY_ACTIVE_HIGH     = {RELAY_ACTIVE_HIGH}"
          f"  (동작이 반대로 나오면 pi/.env에 RELAY_ACTIVE_HIGH=false)")
    print("[!] 220V 기기는 이 자가진단이 정상으로 나온 뒤에 연결하세요.")
    test_door_lock()
    test_power_relay()
    test_booth_led()
    test_pir_sensor()
    test_keypad_pins()
    print("\n" + "=" * 65)
    print("🎉 노래방 부스 하드웨어 자가진단 항목을 모두 실행했습니다.")
    print("통신 점검을 위해 'python 01_ping_backend.py'를 실행해 보세요!\n")
