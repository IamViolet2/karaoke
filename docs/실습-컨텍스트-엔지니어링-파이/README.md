# 실습 — 대화창 AI로 라즈베리파이 작업하기 (컨텍스트 엔지니어링)

[본편 07 매뉴얼](../07-라즈베리파이-컨텍스트-엔지니어링-매뉴얼.html)을 손으로 따라 해 보는 연습 4개입니다.
AI 에이전트 없이 **웹 대화창 AI 하나와 VS Code**만 씁니다. AI 서비스는 어떤 것이든 됩니다.
코드는 PC에서 고치고 **가짜 핀(mock)** 으로 먼저 확인한 뒤, 라즈베리파이로 옮겨 실기기에서 확인합니다.

| 실습 | 연습하는 것 | 유형 | `--files` | 만든 프롬프트 |
|---|---|---|---|---|
| **1 설명 받기** (15분) | 컨텍스트를 줄 때와 안 줄 때 답이 얼마나 다른지 | `explain` | `main.py` | [34,245자](프롬프트/실습1-설명받기.md) |
| **2 배선 계획** (20분) | 코드보다 먼저 배선표를 받고, 핀이 겹치지 않는지 직접 확인 | `wiring` | `booth_pins.py` | [12,963자](프롬프트/실습2-배선계획.md) |
| **3 기능 추가** (45분) | 계획 확인 → 큰 파일 나눠 받기 → `check.py` → 가짜 핀으로 실행 | `feature` | `main.py` | [32,525자](프롬프트/실습3-기능추가.md) |
| **4 오류 고치기** (25분) | 점검기가 잡은 실행 오류를 **오류 글**로 묻기 | `bugfix` | `main.py` | [36,399자](프롬프트/실습4-오류고치기.md) |

`프롬프트/` 폴더의 파일은 도구가 **실제로 만든 결과**입니다(karaoke 브랜치, 2026년 11월 기준). 무엇이 어떤 순서로 들어가는지 보는
견본일 뿐이므로, 실습할 때는 **반드시 아래 명령으로 직접 다시 만듭니다.** `증거/` 폴더의 출력도 모두 실제로 실행해 얻은 것입니다.

실습 2~4는 [문 열림 센서 + 경고 부저 실습](../실습-문센서-부저/README.md)의 ① 라즈베리파이 편과 같은 기능입니다. 그쪽 영상은 AI 에이전트가
파일을 고치는 과정이고, 여기서는 같은 일을 **대화창 AI와 복사·붙여넣기**로 합니다. 정답 비교에 그쪽 패치를 씁니다.

---

## 준비 (한 번만)

**PC (Windows PowerShell)** — 코드를 고치고 가짜 핀으로 확인하는 곳

```powershell
cd pi
python -m venv venv
venv\Scripts\activate
pip install gpiozero requests python-dotenv     # PC에서는 lgpio 없이 가짜 핀만 씁니다
copy .env.example .env                          # BACKEND_URL=http://127.0.0.1:8000, DEVICE_API_KEY는 backend/.env 와 같은 값
git switch -c practice-pi                       # 실습용 가지. 끝나면 지워 버리면 됩니다
```

**라즈베리파이** — [부록I](../부록I-라즈베리파이5-실기기-마이그레이션-매뉴얼.html) 1~5단계(가상환경, `pi/.env`)를 마친 상태면 됩니다.

실습 3에서 관리자 화면과 함께 확인하려면 문 열림 센서(`door_sensor_1`)와 경고 부저(`buzzer_1`)가 백엔드에 있어야 합니다.
백엔드 담당이 아직 넣지 않았다면 저장소 맨 위 폴더에서 백엔드 패치 두 개를 적용하고 백엔드를 다시 켭니다.

```powershell
git apply docs/실습-문센서-부저/patches/be-1-기기-등록.patch
git apply docs/실습-문센서-부저/patches/be-2-문-열림-경고-규칙.patch
```

> 파이 담당은 백엔드 코드를 고치지 않습니다. 패치 적용은 실습 환경을 맞추는 일일 뿐입니다.
> `check.py`는 `pi` 폴더 안만 보므로 백엔드 파일이 바뀌어도 상관없습니다. 커밋할 때는 `pi` 파일만 올립니다.

---

## 실습 1 — 설명 받기

**목표**: 같은 질문을 (가) 아무것도 붙이지 않고, (나) `context.py`로 만든 프롬프트로 물어 답을 비교합니다.

1. 새 대화를 열고 그냥 묻습니다.
   > 우리 노래방 부스 라즈베리파이의 main.py가 몇 초마다 무엇을 하는지, 관리자 화면에서 '문 열기'를 누르면 도어락이 어떻게 열리는지 설명해 줘.

   AI는 우리 파일을 볼 수 없으므로 일반론이나 **지어낸 코드**(`RPi.GPIO`, MQTT, Flask 서버를 파이에 띄우기 등)로 답하기 쉽습니다. 메모장에 붙여 둡니다.
2. 프롬프트를 만듭니다 (`pi` 폴더에서).
   ```powershell
   python scripts/ai/context.py --type explain --task "main.py가 몇 초마다 무엇을 하는지, 관리자 화면에서 '문 열기'를 누르면 도어락이 실제로 열리기까지 무슨 일이 일어나는지, 백엔드가 꺼져 있으면 어떻게 되는지 알고 싶어요" --files main.py
   ```
3. VS Code로 `pi/.ai/prompt.md`를 열고 **Ctrl+A → Ctrl+C**, **새 대화**에 붙여 넣고 보냅니다.
4. 1번 답과 비교합니다. 좋은 답이면 다음이 맞게 들어 있습니다.
   - `while` 루프는 0.05초마다 돌고, 그 안에서 (1) 키패드 (2) PIR (3) `POLL_INTERVAL_SEC`(기본 3초)마다 백엔드에 묻기를 한다
   - '문 열기' → 백엔드가 `door_lock_1`의 목표를 `unlocked`로 바꿈 → 파이가 다음 폴링에서 `get_desired` → 내가 아는 상태(`my_state`)와 다르면
     `hw.apply` → `self.door.on()` → `report_state`로 보고 → 대시보드에 확정. **백엔드가 파이에 먼저 연락하지 않는다**
   - 백엔드가 꺼지면 `RequestException`을 잡아 처음 한 번만 안내하고 조용히 다시 시도한다. 실패한 보고는 `pending`에 두었다 다시 보낸다
   - 줄 번호를 짚어 가며 설명하고, 파일에 없는 것(백엔드 안쪽 동작)은 추측이라고 밝힌다
5. AI가 알려 준 확인 방법 하나를 직접 해 봅니다 (예: 백엔드를 끈 채 가짜 핀으로 `main.py`를 켜서 안내 문구를 본다).

---

## 실습 2 — 배선 계획: 코드보다 배선표 먼저

**목표**: 문 열림 센서(리드 스위치)와 경고 부저를 어디에 어떻게 꽂을지 **코드 없이** 배선표로 받고, 직접 검토합니다.

1. 프롬프트를 만듭니다. `--type wiring`은 `booth_pins.py`를 저절로 넣고, AI에게 코드를 쓰지 말라고 합니다.
   ```powershell
   python scripts/ai/context.py --type wiring --task "문이 열렸는지 알아내는 문 열림 센서(리드 스위치 MC-38, 선 2가닥)와, 잠긴 문이 열려 있으면 울릴 경고 부저(액티브 부저 모듈, 핀 이름 VCC·GND·S)를 라즈베리파이에 연결하고 싶어요." --done "이미 쓰는 핀과 겹치지 않는 핀을 고른다" --done "부품 핀마다 물리 핀 번호와 BCM 번호가 적힌 배선표가 있다" --done "리드 스위치에 저항이 필요한지, 부저 모듈을 3.3V와 5V 중 어디에 연결할지 이유와 함께 안다" --files booth_pins.py
   ```
   부품 이름과 핀 이름은 **실제 부품에 적힌 대로** 바꿔 씁니다. 모르면 사진 속 글자라도 적습니다.
2. 받은 배선표를 직접 검토합니다.
   - 고른 BCM 번호가 `booth_pins.py`의 17·27·22·24·5·6·13·19·26·16·20·21과 **겹치지 않는가**
   - BCM 번호와 물리 핀 번호가 짝이 맞는가 (예: BCM 23 = 16번, BCM 25 = 22번). [핀 배치표](../부록I-라즈베리파이5-실기기-마이그레이션-매뉴얼.html)로 확인
   - 리드 스위치는 한쪽 GPIO, 다른 쪽 GND + **내부 풀업**이면 저항이 없어도 된다는 설명이 있는가
   - 부저 모듈의 전압과 S 핀 신호(3.3V)에 대한 설명, "전원을 뽑고 연결", "선생님 확인" 단계가 있는가
3. 배선표를 선생님께 보여 확인받습니다. 정답 비교: 영상 실습은 문 센서 **BCM 23(16번)**, 부저 **BCM 25(22번)** 를 썼습니다. 다른 빈 핀이어도 됩니다.

---

## 실습 3 — 기능 추가: 데몬에 문 센서·부저

**목표**: `booth_pins.py`와 `main.py`에 문 열림 센서와 경고 부저를 넣습니다. `main.py`는 505줄이라 **나눠 받기**를 연습합니다.

**완료 기준**
- 가짜 핀으로 `main.py`를 켜면 핀 배치에 경고 부저(GPIO25)와 문 열림 센서(GPIO23)가 보인다
- 관리자 화면에서 '경고 부저 울리기'를 누르면 터미널에 `buzzer_1` 지시와 '보고 완료'가 찍힌다
- `python scripts/ai/check.py` 가 통과한다

1. 프롬프트를 만듭니다. 실습 2에서 다른 핀을 골랐다면 번호를 바꿉니다.
   ```powershell
   python scripts/ai/context.py --type feature --task "문 열림 센서(리드 스위치, 한쪽 선은 GPIO23, 다른 쪽은 GND, 내부 풀업)와 경고 부저(GPIO25)를 데몬에 추가하고 싶어요. 문 상태는 바뀔 때만 door_sensor_1로 보고하고(1 = 열림, 0 = 닫힘, unit은 door_open), buzzer_1은 다른 액추에이터처럼 목표 상태(on/off)를 폴링해서 따라요. 두 기기는 백엔드에 이미 등록되어 있어요." --done "가짜 핀으로 main.py를 켜면 핀 배치에 경고 부저(GPIO25)와 문 열림 센서(GPIO23)가 보인다" --done "관리자 화면에서 '경고 부저 울리기'를 누르면 터미널에 buzzer_1 지시와 '보고 완료'가 찍힌다" --done "python scripts/ai/check.py 가 통과한다" --files main.py
   ```
2. 새 대화에 붙여 넣고 **계획**을 확인합니다.
   - 고칠 파일이 `booth_pins.py`와 `main.py`인가 (새 작은 파일을 만들자고 하면 그것도 좋다)
   - 부저가 `apply()`·`safe_state()`·`close()`·`actuator_ids()`·`my_state`에 모두 들어가는가 — **꺼진 상태에서 시작·종료**
   - 문 센서는 **값이 바뀔 때만** 보고하는가 (0.05초 루프마다 보내면 백엔드가 넘친다)
   - `RPi.GPIO`, 새 pip 패키지, 없는 API를 쓰지 않는가. 핀 번호는 `booth_pins.py`에만 있는가
3. "진행" → `booth_pins.py` 전체를 받아 붙여 넣기 → "다음" → `main.py`는 `(1/2)`, `(2/2)`로 옵니다.
   `(1/2)`을 `main.py`에 <kbd>Ctrl+A</kbd> → <kbd>Ctrl+V</kbd>, "다음", `(2/2)`는 <kbd>Ctrl+End</kbd> → <kbd>Enter</kbd> → <kbd>Ctrl+V</kbd> → 저장.
4. 점검합니다. 조각 표시 줄이 있으면 지우라는 ⚠️가 나옵니다 → 그 줄을 지우고 다시 점검합니다.
   ```powershell
   python scripts/ai/check.py
   ```
   정답을 붙여 넣었을 때의 실제 출력입니다 (AI 답마다 줄 수는 다릅니다).
   ```text
   🔎 AI 코드 붙여넣기 점검 (라즈베리파이)

   • pi/booth_pins.py (+4 −0)
   • pi/main.py (+68 −9)

   📌 핀 배치 (booth_pins.py)
       ✅ 핀 14개, 겹침 없음

   ⏳ 가짜 핀(mock)으로 main.py 의 부품을 만들어 보는 중…
       ✅ 가짜 핀 시동 검사: 부품 만들기 → 안전 상태 → 정리 통과 · 폴링할 액추에이터: door_lock_1,relay_1,led_1,buzzer_1

   ✅ 문제를 찾지 못했습니다.
      이제 가짜 핀으로 실행해 터미널 출력과 관리자 화면을 눈으로 확인하세요. 실기기는 그다음, 선생님과 함께.
   ```
5. **가짜 핀으로 실행**하며 눈으로 확인합니다. 백엔드를 켜고, 문을 키보드로 흉내 내는 `mock_door.py`만 꺼내 씁니다.
   ```powershell
   git apply --include=pi/mock_door.py ../docs/실습-문센서-부저/patches/pi-3-부품-없이-연습.patch
   python mock_door.py        # o + Enter = 문 열기, c + Enter = 문 닫기, q + Enter = 끝내기
   ```
   (`mock_door.py`는 `pins.DOOR_SENSOR_PIN`과 `main.main()`을 씁니다. AI가 상수 이름을 다르게 지었다면 그 이름으로 고쳐 씁니다.)
   관리자 화면에서 '경고 부저 울리기·끄기'를 누르고, `o`와 `c`로 문을 열고 닫아 봅니다.
   실제 출력: [`증거/실습3-가짜핀-실행결과.txt`](증거/실습3-가짜핀-실행결과.txt) — 이런 줄이 보이면 됩니다.
   ```text
   📬 [지시] buzzer_1: off → on
      🔔 삐- 삐- 경고 부저를 울립니다 (잠긴 문이 열려 있습니다).
      📤 보고 완료 — 대시보드에 'on' 로 확정 표시됩니다.
   🧲 [문 센서] 문이 열렸습니다.
      📤 문 상태 보고 완료 — 대시보드에 '열림'으로 표시됩니다.
   ```
6. 정답과 비교: VS Code로 [`pi-1-핀과-데몬.patch`](../실습-문센서-부저/patches/pi-1-핀과-데몬.patch)를 엽니다. AI 답이 달라도 완료 기준을 통과하면 됩니다.
7. `pi` 파일만 커밋합니다: `git add booth_pins.py main.py` → `git commit -m "문 센서·부저 추가"` (`mock_door.py`·백엔드 파일은 올리지 않음).
   그다음 07 매뉴얼의 '파이로 옮기기'대로 라즈베리파이에 옮기고 → **파이 전원을 뽑고** 배선 → 선생님 확인 → `python test_hardware_gpio.py` → `python main.py`.

**일부러 틀려 보기 (5분, 추천)** — `check.py`가 무엇을 잡는지 직접 봅니다. 각각 해 본 뒤 VS Code 소스 제어에서 **변경 내용 취소**로 되돌립니다.

| 해 볼 것 | `check.py`가 하는 말 (실제 출력, 줄 번호는 그때마다 다릅니다) |
|---|---|
| 메서드 하나를 `# ... _speak 는 기존 코드와 동일 ...` 한 줄로 바꾸기 | `❌ 197번째 줄 — 주석이 '...'로 시작합니다` · `⚠️ 늘어난 줄보다 지워진 줄이 훨씬 많습니다` (가짜 핀 시동 검사는 통과! — 그래서 둘 다 봐야 합니다) |
| 답변의 `### 파일:` 줄과 ```` ``` ```` 줄까지 붙여 넣기 | `❌ 1번째 줄 — 답변의 '### 파일:' 머리말까지 붙여 넣었습니다` · `❌ 2번째 줄 — 파이썬 문법 오류입니다` |
| 한 줄의 들여쓰기를 한 칸 지우기 | `❌ 186번째 줄 — 들여쓰기가 맞지 않습니다 … (IndentationError: unexpected indent)` |
| `requests`를 `reqeusts`로 오타 | `❌ 392번째 줄 — 'reqeusts' 이라는 이름이 어디에도 없습니다 … 실행하면 NameError` |
| `booth_pins.py`에서 `DOOR_SENSOR_PIN = 17` | `❌ GPIO17 을(를) DOOR_LOCK_PIN, DOOR_SENSOR_PIN 가 함께 씁니다` · `❌ 가짜 핀 시동 검사: gpiozero.exc.GPIOPinInUse: pin GPIO17 is already in use …` |
| `import RPi.GPIO as GPIO` 한 줄 더하기 | `❌ RPi.GPIO 는 라즈베리파이 5에서 동작하지 않습니다` · `❌ 가짜 핀 시동 검사: 'RPi' 모듈이 없습니다` |
| `DEVICE_API_KEY = "booth-demo-key-2026"` | `❌ DEVICE_API_KEY 에 비밀 값을 바로 적었습니다. pi/.env 에 두고 os.getenv(…) 로 읽으세요` |
| 조각 `(2/2)`만 붙여 넣기 | `❌ 나눠 받은 조각이 빠졌거나 순서가 틀립니다 (붙은 조각: 2 / 전체 2개)` · `❌ 'requests' 이라는 이름이 어디에도 없습니다` … |

---

## 실습 4 — 오류 고치기: 외부 풀업 저항을 달았더니

**상황**: 실습 3 뒤에 선생님이 "내부 풀업 대신 10kΩ 외부 풀업 저항을 달아 보자"고 하셨습니다. AI에게 그렇게 말하고 받은 `main.py`를
붙여 넣었더니 `check.py`의 가짜 핀 시동 검사와 `python main.py`가 오류로 멈춥니다.

**준비** — 모두 같은 출발점에서 하도록, 두 파일을 원래대로 돌린 뒤 실습 3 정답을 넣고 그 상황을 만드는 패치를 적용합니다 (저장소 맨 위 폴더에서).

```powershell
git checkout karaoke -- pi/main.py pi/booth_pins.py                 # 원래 파일로
git apply docs/실습-문센서-부저/patches/pi-1-핀과-데몬.patch          # 실습 3 정답
git commit -m "실습 4 준비: 실습 3 정답" -- pi/main.py pi/booth_pins.py
git apply "docs/실습-컨텍스트-엔지니어링-파이/준비/실습4-준비.patch"   # AI가 준 답을 붙여 넣은 상태
```

**완료 기준**
- 가짜 핀으로 `python main.py`가 오류 없이 켜진다
- 문이 닫히면(스위치 닫힘, LOW) 0, 열리면 1로 보고하는 뜻은 그대로다
- `python scripts/ai/check.py` 가 통과한다

1. 점검하면 이렇게 멈춥니다 (실제 출력: [`증거/실습4-check결과.txt`](증거/실습4-check결과.txt)).
   ```text
   ⏳ 가짜 핀(mock)으로 main.py 의 부품을 만들어 보는 중…
       ❌ 가짜 핀 시동 검사: gpiozero.exc.PinInvalidState: Pin GPIO23 is defined as floating, but "active_state" is not defined

   오류 내용은 pi/.ai/last-error.txt 에 저장했습니다.
   ```
   `python main.py`로 켜도 같은 오류가 납니다 ([`증거/실습4-main실행결과.txt`](증거/실습4-main실행결과.txt)). 점검기가 저장한 오류 글이 더 짧고 경로가 정리돼 있으니 그것을 씁니다.
2. 프롬프트를 만듭니다. **배선도 증거입니다** — 과제 글에 실제로 어떻게 꽂았는지 적습니다.
   ```powershell
   python scripts/ai/context.py --type bugfix --task "문 열림 센서에 10kΩ 외부 풀업 저항을 달았다고 말하고 AI가 준 main.py를 붙여 넣었더니, check.py의 가짜 핀 시동 검사와 python main.py가 아래 오류로 멈춥니다. 배선은 3.3V(1번 핀) — 10kΩ — GPIO23(16번 핀), 리드 스위치는 GPIO23과 GND(14번 핀) 사이입니다." --done "가짜 핀으로 python main.py가 오류 없이 켜진다" --done "문이 닫히면(스위치 닫힘, LOW) 0, 열리면 1로 보고하는 뜻은 그대로다" --done "python scripts/ai/check.py 가 통과한다" --error .ai/last-error.txt --files main.py
   ```
3. AI의 **원인 설명과 계획**을 확인합니다. 좋은 답이면:
   - `pull_up=None`은 "파이가 풀업도 풀다운도 하지 않는다(떠 있음)"는 뜻이라, gpiozero가 LOW와 HIGH 중 어느 쪽이 '눌림'인지 알 수 없다
   - 외부 **풀업**이므로 스위치가 닫히면 LOW → LOW가 '눌림' → `active_state=False`를 함께 적는다
   - 고칠 곳은 `Button(...)` **한 줄**. `door_is_open()`과 보고 값(1 = 열림)은 그대로 둔다
   - 원인이 배선일 수도 있음을 말하고(저항이 정말 3.3V에 붙었는지), `.env` 값은 묻지 않는다
4. "진행" → `main.py`(나눠서) 받아 붙여 넣기 → `check.py` ✅ → `python mock_door.py`에서 `o`는 '열림', `c`는 '닫힘'으로 보고되는지 확인합니다.
5. 정답과 비교: [`정답/실습4-정답.patch`](정답/실습4-정답.patch) — 한 줄입니다.
   ```diff
   -        self.door_sensor = Button(pins.DOOR_SENSOR_PIN, pull_up=None, bounce_time=0.1)
   +        self.door_sensor = Button(pins.DOOR_SENSOR_PIN, pull_up=None, active_state=False, bounce_time=0.1)
   ```
   실제 확인: 가짜 핀에서 스위치 닫힘(LOW) → `door_is_open() = False`, 열림(HIGH) → `True`. 고치기 전과 뜻이 같습니다.

---

## 다 했으면

저장소 맨 위 폴더에서:

```powershell
git switch karaoke
git branch -D practice-pi                 # 실습 가지 지우기
# 실습용으로 적용한 백엔드 패치를 되돌린다 (백엔드 담당이 이미 넣어 둔 경우라면 하지 않는다)
git apply -R docs/실습-문센서-부저/patches/be-2-문-열림-경고-규칙.patch
git apply -R docs/실습-문센서-부저/patches/be-1-기기-등록.patch
```

- 07 매뉴얼 맨 끝의 점검표로 스스로 점검합니다.
- 실제 과제도 같은 순서입니다: **배선표 → 작업 카드 → `context.py` → 계획 확인 → 파일 전체 → `check.py` → 가짜 핀 → 커밋 → 파이에서 `git pull` → 선생님과 실기기**.
