# 실습 — 대화창 AI로 프론트엔드 작업하기 (컨텍스트 엔지니어링)

[본편 06 매뉴얼](../06-프론트엔드-컨텍스트-엔지니어링-매뉴얼.html)을 손으로 따라 해 보는 연습 3개입니다.
AI 에이전트 없이 **웹 대화창 AI 하나와 VS Code**만 씁니다. AI 서비스는 어떤 것이든 됩니다.

| 실습 | 연습하는 것 | 유형 | `--files` | 만든 프롬프트 |
|---|---|---|---|---|
| **1 설명 받기** (15분) | 컨텍스트를 줄 때와 안 줄 때 답이 얼마나 다른지 | `explain` | `hooks/useBoothSession.ts` `components/booth/SessionStrip.tsx` | [20,791자](프롬프트/실습1-설명받기.md) |
| **2 기능 추가** (40분) | 계획 확인 → 파일 전체 받기 → 붙여 넣기 → `ai:check` → 눈으로 확인 | `feature` | `components/booth/VirtualBoothSimulator.tsx` | [31,075자](프롬프트/실습2-기능추가.md) |
| **3 오류 고치기** (30분) | 오류 메시지가 없는 버그를 **증거**로 묻기 | `bugfix` | `hooks/useBoothData.ts` `components/booth/VirtualBoothSimulator.tsx` | [42,647자](프롬프트/실습3-오류고치기.md) |

`프롬프트/` 폴더의 파일은 도구가 **실제로 만든 결과**입니다(karaoke 브랜치, 2026년 11월 기준). 무엇이 어떤 순서로
들어가는지 보는 견본일 뿐입니다. 코드가 바뀌면 내용도 달라지므로, 실습할 때는 **반드시 아래 명령으로 직접 다시 만듭니다.**

실습 2·3은 [문 열림 센서 + 경고 부저 실습](../실습-문센서-부저/README.md)과 같은 기능입니다. 그쪽 영상은 AI 에이전트가
파일을 고치는 과정이고, 여기서는 같은 일을 **대화창 AI와 복사·붙여넣기**로 합니다. 정답 비교에 그쪽 패치를 씁니다.

---

## 준비 (한 번만)

```powershell
cd frontend
npm install                      # 이미 했다면 건너뜁니다
git switch -c practice-ctx       # 실습용 가지. 끝나면 지워 버리면 됩니다
```

실습 2·3에는 문 열림 센서(`door_sensor_1`)와 경고 부저(`buzzer_1`)가 백엔드에 있어야 합니다.
백엔드 담당이 아직 넣지 않았다면 저장소 맨 위 폴더에서 백엔드 패치 두 개를 적용하고 백엔드를 다시 켭니다.

```powershell
git apply docs/실습-문센서-부저/patches/be-1-기기-등록.patch
git apply docs/실습-문센서-부저/patches/be-2-문-열림-경고-규칙.patch
```

- MySQL(로컬 개발)은 백엔드를 다시 켜면 두 기기가 저절로 등록됩니다.
- Supabase(PostgreSQL)는 표를 저절로 만들지 않습니다. `backend/db/init_supabase.sql`의 바뀐 부분을 SQL 편집기에서 실행합니다.
- 백엔드 파일이 바뀌어도 `npm run ai:check`는 `frontend` 안만 봅니다. 프론트 담당은 백엔드 파일을 커밋하지 않습니다.

> 프론트 담당은 백엔드 코드를 고치지 않습니다. 패치 적용은 실습 환경을 맞추는 일일 뿐입니다.

---

## 실습 1 — 설명 받기

**목표**: 같은 질문을 (가) 아무것도 붙이지 않고, (나) `ai:context`로 만든 프롬프트로 물어 답을 비교합니다.

1. 새 대화를 열고 그냥 묻습니다.
   > 우리 프로젝트의 useBoothSession 훅이 무엇을 하는지, 부스 화면의 남은 시간이 어떻게 1초씩 줄어드는지 설명해 줘.

   AI는 우리 파일을 볼 수 없으므로 일반론이나 **지어낸 코드**로 답합니다. 그 답을 메모장에 붙여 둡니다.
2. 프롬프트를 만듭니다 (`frontend` 폴더에서).
   ```powershell
   npm run ai:context -- --type explain --task "useBoothSession 훅이 무엇을 하는지, 언제 서버에 다시 물어보는지, 부스 화면의 남은 시간이 어떻게 1초씩 줄어드는지 알고 싶어요" --files hooks/useBoothSession.ts components/booth/SessionStrip.tsx
   ```
3. VS Code로 `frontend/.ai/prompt.md`를 열고 **Ctrl+A → Ctrl+C**, **새 대화**에 붙여 넣고 보냅니다.
4. 답을 1번 답과 비교합니다. 좋은 답이면 다음이 맞게 들어 있습니다.
   - 전원이 켜져 있는 동안 `GET /api/booth/session`을 **바로 한 번, 그 뒤 30초마다**(`REFRESH_MS = 30_000`) 묻는다
   - 전원이 꺼지면 세션을 비운다 (지난 사람 이름이 다음 사람 화면에 비치지 않게)
   - 남은 시간은 서버가 준 `remaining_sec`에서 **받은 뒤 흐른 초**를 빼서 구한다 (`remainingSeconds`). 부스 PC 시계가 틀려도 맞는 이유
   - 1초마다 다시 그리는 곳은 훅이 아니라 `SessionStrip.tsx`의 `useNow` (1초 `setInterval`)
   - 파일에 없는 내용(예: 백엔드가 `remaining_sec`을 어떻게 계산하는지)은 **추측이라고 밝힌다**
5. AI가 알려 준 확인 방법 하나를 직접 해 봅니다(예: 부스 화면에서 남은 시간이 줄어드는지, Network 탭에서 30초마다 `session` 요청이 보이는지).

**흔한 실수**: 줄 번호가 붙은 설명용 코드를 그대로 복사해 파일에 붙이는 것. `explain`은 코드를 고치지 않는 유형입니다.

---

## 실습 2 — 기능 추가: 관리자 화면에 문 센서·부저

**목표**: `/admin`의 기기 관제 카드에 문 열림 센서와 경고 부저 상태를 보이고, 부저를 켜고 끄는 버튼을 단다.

**완료 기준**
- `/admin`에서 관리자 PIN으로 인증하면 PIR 줄 아래에 '문 열림 센서: 닫힘'과 '경고 부저 꺼짐'이 보인다
- '경고 부저 울리기'를 누르면 표시가 '경고 부저 울림'으로 바뀌고 버튼은 '경고 부저 끄기'가 된다
- `npm run ai:check`와 `npm run build`가 통과한다

1. 프롬프트를 만듭니다.
   ```powershell
   npm run ai:context -- --type feature --task "관리자 화면(/admin)의 '가상 노래방 부스 실시간 물리 상태' 카드에서 입장 감지 센서(PIR) 줄 아래에 문 열림 센서와 경고 부저 상태를 보여 주고, '시나리오 실행 · 직접 제어'의 버튼 목록에 '경고 부저 울리기/끄기' 버튼을 추가하고 싶어요. 두 기기는 백엔드에 이미 등록되어 있어요: door_sensor_1(문 열림 센서, current_value 1 = 열림, 0 = 닫힘), buzzer_1(경고 부저, current_state on = 울림, off = 꺼짐)." --done "/admin에서 관리자 PIN으로 인증하면 PIR 줄 아래에 '문 열림 센서: 닫힘'과 '경고 부저 꺼짐'이 보인다" --done "'경고 부저 울리기'를 누르면 표시가 '경고 부저 울림'으로 바뀌고 버튼은 '경고 부저 끄기'가 된다" --done "npm run ai:check 와 npm run build 가 통과한다" --files components/booth/VirtualBoothSimulator.tsx
   ```
   한 줄이 너무 길면 과제 글을 `frontend/.ai/task.txt`에 적고 `--task-file .ai/task.txt`로 바꿔 씁니다.
2. 새 대화에 붙여 넣습니다. AI는 **계획만** 말하고 "진행할까요?"에서 멈춰야 합니다. 계획을 이렇게 확인합니다.
   - 고칠 파일이 `VirtualBoothSimulator.tsx` **하나**인가 (`types/index.ts`는 이미 `current_value`가 있어 고칠 필요가 없다)
   - 부저 제어에 기존 `onDeviceControl("buzzer_1", "on" | "off")`를 쓰는가. 새 API(`/api/buzzer` 같은 것)를 지어내지 않는가
   - 아이콘은 `lucide-react`, 색은 토큰(`text-live`, `text-ink-3` …)인가. `bg-red-500`이나 이모지는 아닌가
   - 이상하면 고쳐 달라고 하고, 맞으면 **"진행"** 이라고 보냅니다.
3. 파일 전체가 오면 대화창의 **복사 버튼**으로 코드 블록 안만 복사합니다. VS Code에서 `VirtualBoothSimulator.tsx`를 열고 **Ctrl+A → Ctrl+V → Ctrl+S**.
4. 점검합니다.
   ```powershell
   npm run ai:check
   ```
   정답 파일을 붙여 넣었을 때의 실제 출력입니다 (AI 답마다 줄 수는 다릅니다).
   ```text
   🔎 AI 코드 붙여넣기 점검

   • frontend/components/booth/VirtualBoothSimulator.tsx (+48 −2)

   ✅ 타입 검사: 통과
   ✅ ESLint: 통과

   ✅ 문제를 찾지 못했습니다.
      이제 npm run dev 로 화면을 열어 완료 기준을 눈으로 확인하세요. 확인되면 커밋합니다.
   ```
5. `npm run dev` → `http://localhost:3000/admin` → PIN 인증 → 완료 기준을 하나씩 눈으로 확인합니다.
6. 정답과 비교: VS Code로 [`fe-1-관리자-화면.patch`](../실습-문센서-부저/patches/fe-1-관리자-화면.patch)를 엽니다. `+`로 시작하는 줄이 정답이 더한 줄입니다.
   AI 답이 정답과 달라도 **완료 기준을 통과하고 계획에 없던 변경이 없으면** 됩니다.
7. 커밋합니다. `git add frontend/components/booth/VirtualBoothSimulator.tsx` → `git commit -m "관리자 화면에 문 센서·부저 표시"`

**일부러 틀려 보기 (5분, 추천)** — `ai:check`가 무엇을 잡는지 직접 봅니다. 각각 해 본 뒤 VS Code 소스 제어에서 **변경 내용 취소**로 되돌립니다.

| 해 볼 것 | `ai:check`가 하는 말 (실제 출력, 줄 번호와 개수는 그때마다 다릅니다) |
|---|---|
| 아무 JSX 덩어리를 `{/* ... 기존 코드와 동일 ... */}` 한 줄로 바꾸기 | `❌ 310번째 줄 — 주석이 '...'로 시작합니다` · `⚠️ 늘어난 줄보다 지워진 줄이 훨씬 많습니다` |
| 답변의 `### 파일:` 줄과 ```` ``` ```` 줄까지 같이 붙여 넣기 | `❌ 1번째 줄 — 답변의 '### 파일:' 머리말까지 붙여 넣었습니다` · `❌ 타입 검사: 오류 135개` |
| `onDeviceControl`을 `onDeviceControll`로 오타 | `❌ 타입 검사: 오류 1개` · `Cannot find name 'onDeviceControll'. Did you mean 'onDeviceControl'?` · `.ai/last-error.txt` 저장 |

---

## 실습 3 — 오류 고치기: 새로고침해야 바뀌는 문 센서

**상황**: 실습 2를 마치고 문을 열어 보니 '경고 부저'는 바로 '울림'이 되는데, '문 열림 센서'는 **새로고침해야** '열림'이 됩니다.
콘솔에 빨간 오류도 없습니다. 오류 메시지가 없으니 **본 것**을 증거로 모아 묻습니다.

**완료 기준**
- 문을 열면 새로고침 없이 1초 안에 '문 열림 센서'가 '열림'으로 바뀐다
- 문을 닫으면 새로고침 없이 '닫힘'으로 돌아온다
- 다른 기기(도어락·전원·조명·부저) 표시는 지금처럼 동작한다

1. **증상 재현**: 백엔드·프론트를 켜고 `/admin`에서 인증합니다. 문을 엽니다.
   - 라즈베리파이가 있으면 실제 문을, 부품이 없으면 [`mock_door.py`](../실습-문센서-부저/README.md#부품-없이-연습하기-mock)를 씁니다.
   - 둘 다 없으면 PowerShell 한 줄로 파이를 흉내 냅니다. `<키>`는 `backend/.env`의 `DEVICE_API_KEY` 값입니다.
     **이 키는 터미널에만 씁니다. 대화창에는 절대 붙이지 않습니다.**
     ```powershell
     # 문 열기 (닫기는 "value": 0)
     Invoke-RestMethod -Method Post -Uri http://localhost:8000/api/v1/devices/door_sensor_1/state -Headers @{ "X-Device-Api-Key" = "<키>" } -ContentType "application/json" -Body '{"value": 1, "unit": "door_open"}'
     ```
2. **증거 모으기**: 브라우저에서 **F12 → Network → WS → `ws` 줄 클릭 → Messages**. 문을 열고 닫은 뒤 들어온 줄을 복사합니다.
   `frontend/.ai/evidence.txt`를 새로 만들어 **화면에서 본 것**과 **복사한 메시지**를 그대로 적습니다.
   견본: [`증거/evidence.txt`](증거/evidence.txt) — 실제 백엔드에서 받은 메시지입니다. `.ai/` 폴더는 커밋되지 않습니다.
3. 프롬프트를 만듭니다.
   ```powershell
   npm run ai:context -- --type bugfix --task "관리자 화면(/admin) 기기 관제에서 문을 열면 '경고 부저'는 바로 바뀌는데, '문 열림 센서'는 새로고침해야 바뀝니다." --done "문을 열면 새로고침 없이 1초 안에 '문 열림 센서'가 '열림'으로 바뀐다" --done "문을 닫으면 새로고침 없이 '닫힘'으로 돌아온다" --done "다른 기기(도어락·전원·조명·부저) 표시는 지금처럼 동작한다" --evidence .ai/evidence.txt --files hooks/useBoothData.ts components/booth/VirtualBoothSimulator.tsx
   ```
   `VirtualBoothSimulator.tsx`는 실습 2 뒤로 432줄이라 **큰 파일** 표시가 붙습니다. 답변 형식 4번 때문에 AI는 이 파일을 되도록 고치지 않으려 합니다.
4. AI의 **원인 설명과 계획**을 확인합니다. 좋은 답이면:
   - 부저는 `device_state` 메시지로 오고, `useBoothData.ts`의 `handleWsMessage`가 이것을 처리해 바로 바뀐다
   - 문 센서 값은 `sensor_reading` 메시지로 오는데, `handleWsMessage`에 이 종류를 처리하는 곳이 **없다** → 새로고침해서 `GET /api/devices`를 다시 받아야 바뀐다
   - 고칠 파일은 `useBoothData.ts` **하나**. `sensor_reading`을 받으면 그 기기의 `current_state`를 `"reported"`, `current_value`를 받은 값으로 바꾼다
   - 이런 계획이면 다시 부탁합니다: 몇 초마다 `fetchDevices`를 부르는 **폴링**, 큰 파일 `VirtualBoothSimulator.tsx`를 고치는 것, 백엔드를 고치라는 것
     > 증거의 sensor_reading 메시지를 useBoothData.ts에서 처리하는 가장 작은 수정으로 다시 계획해 줘.
5. "진행" → `useBoothData.ts` 전체를 받아 붙여 넣기 → `npm run ai:check` → 1번처럼 문을 열고 닫아 **새로고침 없이** 바뀌는지 봅니다.
6. 정답과 비교: [`fe-2-실시간-반영.patch`](../실습-문센서-부저/patches/fe-2-실시간-반영.patch) — 7줄을 더한 것이 전부입니다.

실제 확인 결과(같은 백엔드·같은 화면, 문 열기 → 닫기):

| | 처음 | 문 열기 후 | 문 닫기 후 |
|---|---|---|---|
| 고치기 전 | 닫힘 · 부저 꺼짐 | **닫힘** · 부저 울림 | 닫힘 · 부저 꺼짐 |
| 고친 뒤 | 닫힘 · 부저 꺼짐 | **열림** · 부저 울림 | 닫힘 · 부저 꺼짐 |

---

## 다 했으면

저장소 맨 위 폴더에서:

```powershell
git switch karaoke
git branch -D practice-ctx        # 실습 가지 지우기
# 실습용으로 적용한 백엔드 패치를 되돌린다 (백엔드 담당이 이미 넣어 둔 경우라면 하지 않는다)
git apply -R docs/실습-문센서-부저/patches/be-2-문-열림-경고-규칙.patch
git apply -R docs/실습-문센서-부저/patches/be-1-기기-등록.patch
```

- 06 매뉴얼 맨 끝의 체크리스트로 스스로 점검합니다.
- 실제 과제도 같은 순서입니다: **작업 카드 → `ai:context` → 계획 확인 → 파일 전체 → `ai:check` → 눈으로 확인 → 커밋**.
