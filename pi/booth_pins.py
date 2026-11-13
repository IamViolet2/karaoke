"""
booth_pins.py
--------------------------------------------------------------------------------
[노래방 부스 GPIO 핀 배치 — 하나뿐인 진실(single source of truth)]

핀 번호를 여러 파일에 복사해 두면 반드시 어긋납니다.
그래서 핀 번호는 이 파일에만 적습니다.

  - test_hardware_gpio.py (배선 자가진단)
  - main.py               (실제 데몬)

둘 다 여기서 가져다 씁니다. 배선을 바꾸면 이 파일 한 곳만 고치면 됩니다.

번호는 모두 BCM 기준입니다 (물리 핀 번호가 아닙니다).
--------------------------------------------------------------------------------
"""

import os

# ── 액추에이터 ────────────────────────────────────────────────────────────
DOOR_LOCK_PIN = 17    # 솔레노이드 도어락 (릴레이 1채널)
RELAY_POWER_PIN = 27  # 반주기/앰프 220V 기기 전원 릴레이
LED_PIN = 22          # 부스 실내 LED 조명 바
FAN_PIN = 18          # 선풍기 릴레이 (HIGH=ON, LOW=OFF)

# ── 센서 ──────────────────────────────────────────────────────────────────
PIR_PIN = 24
KEYPAD_ROW_PINS = [5, 6, 13, 19]
KEYPAD_COL_PINS = [26, 16, 20, 21]

# 키패드 각 자리에 새겨진 글자
KEYPAD_LAYOUT = [
    ["1", "2", "3", "A"],
    ["4", "5", "6", "B"],
    ["7", "8", "9", "C"],
    ["*", "0", "#", "D"],
]

# ── 릴레이 극성 ───────────────────────────────────────────────────────────
#
# 도어락 및 노래방 전원 릴레이의 극성 설정입니다.
# 선풍기는 별도로 HIGH=ON, LOW=OFF로 고정합니다.
#
RELAY_ACTIVE_HIGH = (
    os.getenv("RELAY_ACTIVE_HIGH", "true").strip().lower() != "false"
)


def describe() -> str:
    """콘솔에 핀 배치를 한눈에 보여 줍니다."""
    return (
        f"  🚪 도어락        GPIO {DOOR_LOCK_PIN}\n"
        f"  ⚡ 전원 릴레이    GPIO {RELAY_POWER_PIN}  (220V — 취급 주의)\n"
        f"  💡 조명 LED      GPIO {LED_PIN}\n"
        f"  🌀 선풍기 릴레이  GPIO {FAN_PIN}  (HIGH=ON / LOW=OFF)\n"
        f"  👀 PIR 센서      GPIO {PIR_PIN}\n"
        f"  🔢 키패드 행      GPIO {KEYPAD_ROW_PINS}\n"
        f"  🔢 키패드 열      GPIO {KEYPAD_COL_PINS}\n"
        f"  🔌 릴레이 극성    RELAY_ACTIVE_HIGH={RELAY_ACTIVE_HIGH}"
    )