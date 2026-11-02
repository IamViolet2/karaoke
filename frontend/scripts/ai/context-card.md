# 프로젝트 카드 — 학교 노래방 부스 (프론트엔드)

> 이 카드는 대화창 AI에게 우리 프로젝트를 알려 주는 고정 정보입니다. AI는 우리 파일을 직접 볼 수 없으므로
> 여기 적힌 내용과 함께 붙여 넣은 파일만 사실로 여겨야 합니다. (구조가 바뀌면 프론트 담당이 이 카드를 고칩니다)

## 무엇을 만드는가
웹 예약과 일회성 4자리 비밀번호로 부스 문(도어락)·전원(릴레이)·조명(LED)·안내 방송을 자동 제어하는 학교 노래방 부스.
- 백엔드: FastAPI (Python) — 프론트 담당은 백엔드 코드를 고치지 않는다. 필요한 API가 없으면 백엔드 담당에게 부탁한다
- 하드웨어: 라즈베리파이가 백엔드의 '목표 상태(desired_state)'를 폴링해 실제 기기를 움직이고 '실제 상태(current_state)'를 보고한다

## 프론트엔드 기술
- Next.js 16.3.4 (App Router) · React 19.2.8 · TypeScript 5 (`strict: true`) · Tailwind CSS 4 · 아이콘 `lucide-react`
- 경로 별칭 `@/` = `frontend/` 폴더 (예: `import { apiUrl } from "@/utils/apiConfig"`)
- 모든 페이지는 `"use client"` 컴포넌트다. `next.config.ts`의 `reactStrictMode: false`
- 명령: `npm run dev`(개발 서버, http://localhost:3000) · `npm run build` · `npm run lint` · `npx tsc --noEmit`

## 화면 4개 (`app/`)
| 주소 | 파일 | 누가·어디서 | 주요 구성 |
|---|---|---|---|
| `/` | `app/page.tsx` | 학생 · 자기 폰 · `theme-day` | AppHeader, BoothStatusCard, ReservationSection(sections="form"), SongHistorySection, MiniGameSection |
| `/try` | `app/try/page.tsx` | 전시 관람객 · QR로 접속 · `theme-day` | 체험권 받기와 대기 순서 (파일 안에 모두 있음, 4초마다 새로 받음) |
| `/booth` | `app/booth/page.tsx` | 부스 안 TV · `theme-stage`(어두운 화면, 2~3m 거리에서 봄) | KaraokeRoomSection, BoothAudio |
| `/admin` | `app/admin/page.tsx` | 선생님 노트북 · `theme-day` · 관리자 PIN 인증 전에는 제어 화면을 그리지 않음 | AdminGate, OpsSummary, SchedulerPanel, QueuePanel, AnthemRankingPanel, VirtualBoothSimulator, ReservationSection(sections="list"), VideoCheckPanel, SongHistorySection |

## 폴더 지도
- `components/admin/` — OpsSummary(상태 타일), SchedulerPanel(자동 운영), QueuePanel(체험 대기열), AnthemRankingPanel(교가 순위·CSV)
- `components/booth/` — 이름과 달리 여러 화면에서 쓴다
  - KaraokeRoomSection(1,401줄, /booth 노래방 전체) · AttractScreen(대기 화면: 키패드·QR·순위) · BoothKeypad · SessionStrip(남은 시간)
  - BoothAudio(안내 음성) · QrCode · BoothStatusCard(/의 "지금 쓸 수 있나") · ReservationSection(예약 폼과 목록)
  - SongHistorySection · MiniGameSection · AdminGate(관리자 로그인) · VirtualBoothSimulator(/admin 기기 관제) · VideoCheckPanel
- `components/layout/AppHeader.tsx`, `components/dashboard/ConnectionBadge.tsx`
- `hooks/useBoothData.ts` — 공용 데이터와 WebSocket 처리. 돌려주는 값: `devices, reservations, allSongs, favoriteSongs, lastEventMsg,
  topToday, topAll, anthemTop, queue, announcement, authNotice, isConnected, fetchDevices, fetchReservations, fetchSongs, fetchScores, fetchQueue`
- `hooks/useKaraokeSocket.ts`(WebSocket 연결, 3초 뒤 재연결) · `hooks/useBoothSession.ts`(이용 중 정보, 30초마다)
- `utils/apiConfig.ts` — `apiUrl(path)`, `getWebSocketUrl()` · `utils/adminSession.ts` — `adminFetch(path, init)`, `adminLogin(pin)`
- `utils/` 그 밖: ticketStore, voucherStore, localDate, karaokeMedia, youtubePlayer, audioScorer, karaokeAccompaniment
- `data/karaokeSongs.ts`(곡 목록) · `data/schoolAnthem.generated.ts`(자동 생성 — 손으로 고치지 않음) · `types/index.ts`(공용 타입)

## 데이터 흐름
- 백엔드 응답은 성공 `{ "data": … }`, 실패 `{ "error": { "code", "message" } }`. 코드는 `json.data`, `json.error.message`를 읽는다
- 일반 요청: `fetch(apiUrl("/api/…"))`. 관리자 전용 요청: `adminFetch("/api/…", { method, headers, body })` — `X-Admin-Token`을 붙여 준다.
  401이면 토큰을 지우고 다시 로그인하게 한다
- 실패해도 화면이 멈추지 않게 `try/catch`로 조용히 넘긴다 (백엔드가 꺼져 있어도 화면은 떠야 한다)
- 기기 제어는 `/admin`의 `handleDeviceControl(id, state, value)` → `POST /api/devices/{id}/control {desired_state, value}` 하나로 한다
- 기기 id: `door_lock_1`(도어락), `relay_1`(전원), `led_1`(조명), `speaker_1`(스피커), `keypad_1`, `pir_1`(입장 감지)
- 기기 객체: `{ id, name, kind, desired_state, current_state, desired_value, current_value, updated_at }`
  - desired = 백엔드가 시킨 목표, current = 파이가 보고한 실제. 둘이 다르면 "아직 반영 안 됨"
  - 센서는 값이 오면 `current_state`가 `"reported"`가 되고 값은 `current_value`에 들어온다

### 프론트가 부르는 API
- GET `/api/devices` · `/api/reservations`(adminFetch면 PIN 포함) · `/api/songs` · `/api/scores/top?period=today|all&limit=..`
  · `/api/experience/queue` · `/api/booth/session` · `/api/scheduler/status` · `/api/song-videos`
- POST(누구나) `/api/reservations` · `/api/songs` · `/api/scores` · `/api/booth/verify-keypad {pin}` · `/api/experience/tickets {nickname}` · `/api/admin/login {pin}`
- adminFetch(관리자) POST `/api/devices/{id}/control` · `/api/booth/simulate-entry` · `/api/booth/simulate-10min-warning` · `/api/booth/simulate-end`
  · `/api/scheduler/run` · `/api/experience/advance` · `/api/experience/tickets/{id}/cancel` · GET `/api/scores/export` · PUT/DELETE `/api/song-videos/{id}`
- 여기 없는 API를 지어내지 않는다. 필요하면 "백엔드에 이런 API가 필요하다"고 따로 적는다

### WebSocket (`useBoothData.ts`의 handleWsMessage)
`device_state`(기기 상태 바뀜) · `booth_auth`(키패드 인증 결과) · `booth_event`(입장·10분 전·종료) · `reservation_created` · `song_recorded`
· `score_recorded` · `queue_called` · `queue_updated`. 백엔드는 센서 값이 오면 `sensor_reading`도 보낸다 (현재 프론트는 처리하지 않음)

## 디자인 규칙 (이 프로젝트에서 실제로 쓰는 것)
- 색은 **토큰 이름만** 쓴다: `canvas`, `surface`, `raised`, `line`, `line-strong`, `ink`, `ink-2`, `ink-3`, `brass`(유일한 강조색), `brass-soft`,
  `on-accent`, `live`(빨강: 이용 중·위험), `live-soft`, `free`(초록: 정상·가능), `free-soft`. 예: `bg-surface border-line text-ink-2`
  - `slate-800`, `blue-500` 같은 Tailwind 기본 색은 쓰지 않는다. 파랑 토큰은 없다 → 중립 수치는 `ink`/`raised`로
- 테마: 페이지 맨 바깥 div에 `theme-day`(밝음) 또는 `theme-stage`(어두움). 숫자는 `tnum`, PIN·점수는 `font-mono`
- 아이콘은 `lucide-react`(`aria-hidden`), 이모지를 아이콘 대신 쓰지 않는다. 색만으로 뜻을 전하지 않고 글자·아이콘도 함께 바꾼다
- 클릭 요소에 `cursor-pointer`, 키보드 포커스가 보이게, 375px 폭에서도 깨지지 않게
- Tailwind 클래스 이름을 문자열 조합으로 만들지 않는다 (`bg-${color}` 금지 — 빌드 때 사라진다). 완성된 클래스 이름을 조건으로 고른다
- 화면 문구는 한국어 존댓말("체험권 받기", "서버와 통신할 수 없습니다"). 주석은 한국어로 '왜'를 적는다

## 알려진 함정
- ESLint 규칙 `react-hooks/set-state-in-effect` 때문에 useEffect 안의 첫 fetch는 `setTimeout(fn, 0)`으로 감싼다 (기존 코드 참고)
- 환경 변수는 `process.env.NEXT_PUBLIC_API_BASE_URL`처럼 **그대로** 적어야 빌드 때 바뀐다 (변수 이름을 조합하면 안 됨)
- 새로 받은 저장소에서 `tsc`가 `LayoutProps`를 못 찾으면 `npx next typegen`을 한 번 실행한다
- `KaraokeRoomSection.tsx`(1,401줄)·`ReservationSection.tsx`(511줄)는 크다. 새 기능은 새 작은 컴포넌트 파일로 만들고 큰 파일에는 연결만 한다
