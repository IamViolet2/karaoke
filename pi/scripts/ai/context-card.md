# 프로젝트 카드 — 학교 노래방 부스 (라즈베리파이)

> 이 카드는 대화창 AI에게 우리 프로젝트를 알려 주는 고정 정보입니다. AI는 우리 파일을 직접 볼 수 없으므로
> 여기 적힌 내용과 함께 붙여 넣은 파일만 사실로 여겨야 합니다. (핀·파일·API가 바뀌면 파이 담당이 이 카드를 고칩니다)

## 무엇을 만드는가
웹 예약과 일회성 4자리 비밀번호로 부스 문(도어락)·전원(릴레이)·조명(LED)·안내 방송을 자동 제어하는 학교 노래방 부스.
- 백엔드: FastAPI (학생 PC 또는 Render). 기기마다 '목표 상태(desired_state)'를 보관하는 중계자다. **GPIO를 직접 만지지 않는다**
- 라즈베리파이 5: `pi/main.py` 데몬이 목표 상태를 몇 초마다 **물어보고(폴링)**, 부품을 움직인 뒤 '실제 상태'를 **보고**한다.
  키패드로 누른 비밀번호와 PIR 입장 감지도 백엔드로 올린다. 백엔드가 파이에 먼저 연락하는 일은 없다
- 파이 담당은 `pi/` 폴더만 고친다. 백엔드·프론트가 바뀌어야 하면 그 담당에게 부탁한다

## 환경
- Raspberry Pi 5 (RP1 칩셋) · Raspberry Pi OS 64-bit (Bookworm 이상) · Python 3.11 이상
- GPIO 라이브러리는 `gpiozero` + `lgpio` (APT: `sudo apt install -y python3-gpiozero python3-lgpio`).
  **`RPi.GPIO`는 Pi 5에서 동작하지 않으므로 쓰지 않는다.** `pip install lgpio`는 C 컴파일 오류가 나므로 하지 않는다.
  가상환경은 `python3 -m venv --system-site-packages venv` (시스템의 gpiozero·lgpio를 물려받음)
- pip 패키지는 `requirements.txt`의 `requests`, `python-dotenv` 두 개뿐이다. 새 패키지를 쓰지 않는다 (꼭 필요하면 먼저 묻는다)
- Windows PC에서도 개발한다: `pip install gpiozero requests python-dotenv` 후 **가짜 핀(mock)**으로 실행한다
  - 파이: `cd pi` → `source venv/bin/activate` → `python main.py`
  - PC PowerShell: `cd pi` → `$env:GPIOZERO_PIN_FACTORY="mock"; python main.py`
  - 파이에서 가짜 핀: `GPIOZERO_PIN_FACTORY=mock python main.py`
- 설정은 `pi/.env` (커밋하지 않음): `BACKEND_URL`, `DEVICE_API_KEY`, `POLL_INTERVAL_SEC`(3.0), `GPIOZERO_PIN_FACTORY`(lgpio),
  `SPEAKER_MODE`(browser | pi), `RELAY_ACTIVE_HIGH`(true | false). 코드는 `os.getenv("이름", 기본값)`으로 읽는다

## pi 폴더 지도
| 파일 | 줄 | 하는 일 |
|---|---|---|
| `booth_pins.py` | 63 | GPIO 핀 번호(BCM)의 **유일한 정본**. `describe()`가 핀 배치를 출력한다 |
| `main.py` | 505 | 실기기 데몬 (아래 구조). **큰 파일** |
| `test_hardware_gpio.py` | 158 | 배선 자가진단. 부품마다 `test_…()` 함수가 하나씩 (실기기에서 실행) |
| `01_ping_backend.py` | 61 | 백엔드와 통신이 되는지만 확인 |
| `02_karaoke_daemon_mock.py` | 195 | GPIO 없이 `print()`로 흉내 내는 모의 데몬 |
| `requirements.txt`, `.env.example` | | 패키지 목록, 설정 키 이름 |

### main.py 구조
1. 설정 읽기: `load_dotenv()`, `os.environ.setdefault("GPIOZERO_PIN_FACTORY", "lgpio")`, `BACKEND_URL`, `DEVICE_API_KEY`,
   `POLL_INTERVAL_SEC`, `SPEAKER_MODE`, `HEADERS`(X-Device-Api-Key), `HTTP_TIMEOUT = 5`, `PIR_COOLDOWN_SEC = 20.0`, `KEYPAD_BUFFER_TIMEOUT_SEC = 8.0`
2. gpiozero 불러오기: `from gpiozero import OutputDevice, LED, DigitalInputDevice` (없으면 설치 안내를 출력하고 종료)
3. `class BoothHardware` — GPIO를 감싼 부분
   - `__init__`: `door`·`relay` = `OutputDevice(핀, active_high=pins.RELAY_ACTIVE_HIGH, initial_value=False)`, `led` = `LED`,
     `pir` = `DigitalInputDevice`, 키패드 `rows`(출력, 평소 HIGH)·`cols`(입력, `pull_up=True`)
   - `apply(device_id, state, value) -> bool`: `door_lock_1`(unlocked/locked), `relay_1`(on/off), `led_1`(on/off/blink), `speaker_1`
   - `scan_keypad()`, `safe_state()`(문 잠금·220V 끔·조명 끔), `close()`(안전 상태 후 모든 장치 `close()`)
4. `class BackendClient` — HTTP. `get_desired(id) -> (state, value) | None`, `report_state(id, state, value) -> bool`,
   `verify_pin(pin)`, `report_entry()`. 어떤 실패도 프로그램을 멈추지 않는다 (연결 실패는 처음 한 번만 자세히 출력)
5. `actuator_ids()` → `["door_lock_1", "relay_1", "led_1"]` (+ `speaker_1`은 `SPEAKER_MODE=pi`일 때만)
   `main()`: 시작하면 안전 상태로 만들고 보고 → 0.05초마다 도는 `while` 루프: (1) 키패드 (2) PIR (3) `POLL_INTERVAL_SEC`마다
   목표 상태를 묻고, 내가 아는 상태(`my_state`)와 다르면 `apply` 후 보고 (실패한 보고는 `pending`에 두었다 다시) → Ctrl+C면 `finally`에서 안전 상태

## 핀 배치 (BCM 번호 · 물리 핀 번호)
| 부품 | `booth_pins.py` 상수 | BCM | 물리 핀 |
|---|---|---|---|
| 솔레노이드 도어락 릴레이 | `DOOR_LOCK_PIN` | 17 | 11 |
| 반주기·앰프 220V 전원 릴레이 | `RELAY_POWER_PIN` | 27 | 13 |
| 부스 조명 LED | `LED_PIN` | 22 | 15 |
| PIR 인체 감지 | `PIR_PIN` | 24 | 18 |
| 키패드 행 | `KEYPAD_ROW_PINS` | 5, 6, 13, 19 | 29, 31, 33, 35 |
| 키패드 열 | `KEYPAD_COL_PINS` | 26, 16, 20, 21 | 37, 36, 38, 40 |
- 비어 있는 BCM: **4(7번), 12(32번), 18(12번), 23(16번), 25(22번)** 을 먼저 쓴다. 2·3(I2C), 7~11(SPI), 14·15(UART)는
  그 통신을 쓸 계획이면 피한다. 0·1은 쓰지 않는다
- GND: 6, 9, 14, 20, 25, 30, 34, 39번 · 3.3V: 1, 17번 · 5V: 2, 4번
- GPIO는 **3.3V**다. 5V 신호를 GPIO 입력에 바로 넣지 않는다
- 코드에서 쓰는 번호는 BCM, 실제로 꽂는 자리는 물리 핀 번호다. 배선표에는 둘 다 적는다

## 백엔드와의 약속 (모든 요청에 헤더 `X-Device-Api-Key: <DEVICE_API_KEY>`)
- `GET {BACKEND_URL}/api/v1/devices/{device_id}/desired-state`
  → 200 `{"data": {"device_id", "kind", "desired_state", "value", "updated_at"}}` · 401 키가 다름 · 404 등록 안 된 id
- `POST {BACKEND_URL}/api/v1/devices/{device_id}/state`
  - 액추에이터가 반영을 보고: `{"state": "unlocked", "value": null}`
  - 센서가 값을 보고(`state` 없이): `{"value": 1, "unit": "detection"}` — 대시보드에는 `current_value`로 보인다
  - → 200 `{"data": {"device_id", "recorded": true}}`
- `POST {BACKEND_URL}/api/booth/verify-keypad` `{"pin": "1234"}` → 200 `{"data": {"message"}}` / 실패 `{"error": {"code", "message"}}`
- `POST {BACKEND_URL}/api/v1/vision/events` `{"event_type": "person_detected", "detected": true, "count": 1}` (PIR 입장 감지)
- 기기 id와 상태: `door_lock_1` locked·unlocked · `relay_1` on·off · `led_1` on·off·blink · `speaker_1` (value에 message) ·
  `keypad_1` · `pir_1`(센서, value 1). **새 기기 id는 백엔드 담당이 먼저 등록해야 한다** (안 하면 404)
- 여기 없는 API를 지어내지 않는다. 필요하면 "백엔드에 이런 API·기기가 필요하다"고 따로 적는다

## 안전 규칙 (반드시)
- 배선은 **파이 전원을 뽑은 상태에서만** 바꾼다. 실기기 첫 연결과 220V 연결은 **선생님 입회** 아래, 자가진단이 통과한 뒤에
- 새 로직은 **가짜 핀(mock)으로 먼저** 확인하고 실기기로 옮긴다
- 시작·종료·오류 때는 안전 상태: 도어락 잠금, 220V 릴레이 끔, 조명 끔. **새 액추에이터도 `safe_state()`와 `close()`에 넣는다**
- 릴레이는 `OutputDevice(핀, active_high=pins.RELAY_ACTIVE_HIGH, initial_value=False)`. LOW 트리거 보드는 `.env`에서 `RELAY_ACTIVE_HIGH=false`
- 솔레노이드 도어락은 12V 별도 전원. 파이의 5V 핀에서 끌어오지 않는다. LED 같은 소자는 전류 제한 저항을 거친다

## 코드 규칙 (이 폴더에서 실제로 쓰는 것)
- 핀 번호는 **`booth_pins.py`에만** 적는다. 다른 파일은 `import booth_pins as pins` 후 `pins.XXX_PIN`으로 쓴다
- 새 부품을 붙이는 자리: `booth_pins.py` 상수와 `describe()` 한 줄 → `BoothHardware.__init__`에서 생성 → 액추에이터면
  `apply()`·`safe_state()`·`close()`·`actuator_ids()`·`my_state` 초깃값, 센서면 **값이 바뀔 때만** 보고
- HTTP 요청은 `timeout=HTTP_TIMEOUT`, `requests.exceptions.RequestException`을 잡아 프로그램이 멈추지 않게 한다
- 메인 루프는 0.05초마다 돈다. 그 안에서 오래 막는 일(`time.sleep` 몇 초, `input()`)을 하지 않는다. 깜빡임·삐 소리는 `background=True`
- 들여쓰기는 스페이스 4칸(탭 금지), 함수에 타입힌트, 주석은 한국어로 '왜'를 적는다. 출력은 한국어 `print`(기존 이모지 스타일 그대로)
- Windows 출력 깨짐을 막는 `if sys.platform == "win32":` 부분은 그대로 둔다

## 알려진 함정
- `localhost`는 파이 자신이다. `BACKEND_URL`에는 백엔드 PC의 IP를 쓴다
- 401 = `pi/.env`와 `backend/.env`의 `DEVICE_API_KEY`가 다름 (값은 대화창에 붙이지 말고 두 파일을 직접 비교)
- 404 = 백엔드에 그 기기 id가 없음 → 백엔드 담당이 등록
- `gpiozero.exc.GPIOPinInUse` = 같은 핀을 두 부품이 씀 → `booth_pins.py` 확인
- `PinInvalidState … defined as floating, but "active_state" is not defined` = `pull_up=None`(외부 풀업·풀다운)이면 `active_state`도 정해야 함
- PC에서 `ModuleNotFoundError: No module named 'gpiozero'` → `pip install gpiozero` (PC에서는 mock으로만)
- 가짜 핀에서 입력 값 바꾸기: `Device.pin_factory.pin(번호).drive_low()` / `.drive_high()`.
  `pull_up=True` 입력에 스위치가 닫히면 LOW → `Button.is_pressed`가 `True`
