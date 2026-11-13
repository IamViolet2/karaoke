-- ==============================================================================
-- Smart Control Database Initialization Script (MySQL / MariaDB)
-- 프로젝트: 웹 예약 연동 자동화 학교 노래방 부스 관리 시스템
-- ==============================================================================

-- MySQL-only (db-migration 스킬에서 Supabase 전환 시 이 두 줄은 제거한다)
CREATE DATABASE IF NOT EXISTS smart_control
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE smart_control;

-- 이 스크립트를 파이프로 넣을 때(mysql < init.sql) 클라이언트 기본 문자셋이
-- latin1/cp949면 아래 시드 데이터의 한글이 깨져서 저장된다.
-- 접속 문자셋을 스크립트 안에서 직접 못박아 실행 환경과 무관하게 만든다.
SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 1. 디바이스 테이블 (상태 동기화 및 메타데이터)
CREATE TABLE IF NOT EXISTS devices (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  kind VARCHAR(30) NOT NULL,
  desired_state VARCHAR(30) NULL,   -- 대시보드/트리거가 지정한 목표 상태
  current_state VARCHAR(30) NULL,   -- 파이(또는 Mock)가 보고한 실제 상태
  desired_value JSON NULL,          -- on/off로 안 되는 값 (서보 각도, LED 밝기 등)
  current_value JSON NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. 센서 측정치 기록 테이블
CREATE TABLE IF NOT EXISTS sensor_readings (
  id INT AUTO_INCREMENT PRIMARY KEY, -- MySQL-only
  device_id VARCHAR(50) NOT NULL,
  value DOUBLE NULL,
  unit VARCHAR(30) NULL,
  value_json JSON NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);

-- 3. 제어 이력 로그 테이블 (actor: 'user' 또는 'device')
CREATE TABLE IF NOT EXISTS control_log (
  id INT AUTO_INCREMENT PRIMARY KEY, -- MySQL-only
  device_id VARCHAR(50) NOT NULL,
  action VARCHAR(50) NOT NULL,
  value JSON NULL,
  actor VARCHAR(20) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);

-- 4. 비전 감지 이벤트 테이블
CREATE TABLE IF NOT EXISTS vision_events (
  id INT AUTO_INCREMENT PRIMARY KEY, -- MySQL-only
  event_type VARCHAR(50) NOT NULL,
  detected BOOLEAN NOT NULL DEFAULT FALSE,
  count INT DEFAULT 0,
  confidence FLOAT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 5. 노래방 예약 테이블 (F-01, F-02: 당일 예약 불가, 중복 방지, 4자리 일회성 PIN)
CREATE TABLE IF NOT EXISTS reservations (
  id INT AUTO_INCREMENT PRIMARY KEY, -- MySQL-only
  grade INT NOT NULL,                  -- 학년 (1, 2, 3)
  department VARCHAR(50) NOT NULL,     -- 학과 (정보통신과 등)
  student_name VARCHAR(50) NOT NULL,   -- 신청자 이름
  user_count INT NOT NULL DEFAULT 1,   -- 인원수 (최대 10명)
  reservation_date DATE NOT NULL,      -- 예약 일자
  time_slot VARCHAR(20) NOT NULL,      -- 타임슬롯 ('lunch', 'dinner')
  pin_code VARCHAR(4) NOT NULL,        -- 일회성 4자리 비밀번호
  status VARCHAR(20) NOT NULL DEFAULT 'reserved', -- 'reserved', 'active', 'completed', 'cancelled', 'no_show'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_date_slot (reservation_date, time_slot) -- 동일 날짜/시간대 중복 예약 차단
);

-- 6. 노래 기록 및 나의 18번 관리 테이블 (F-05)
CREATE TABLE IF NOT EXISTS song_history (
  id INT AUTO_INCREMENT PRIMARY KEY, -- MySQL-only
  title VARCHAR(100) NOT NULL,
  singer VARCHAR(100) NOT NULL,
  sing_count INT NOT NULL DEFAULT 1,
  last_sung_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_title_singer (title, singer)
);

-- ==============================================================================
-- 시드 데이터 (AGENTS.md 팀 정보 기준 디바이스 등록)
-- 재실행해도 기존 상태값을 덮어쓰지 않도록 desired_state/current_state는 제외

-- 7. 노래방 영상 등록 (F-06)
--    곡마다 기본 후보 목록은 프론트엔드 코드에 있고, 이 테이블은 그 위에 덮어쓰는
--    "관리자가 직접 지정한 영상"만 담는다. 부스 화면·관람객 폰·관리자 노트북이
--    같은 영상을 보게 하려고 브라우저가 아닌 서버에 저장한다.
CREATE TABLE IF NOT EXISTS song_videos (
  song_id    VARCHAR(64) PRIMARY KEY,
  video_id   VARCHAR(32) NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ==============================================================================
-- 전시 체험 대기열 (부록G §2-③ 전시 체험 모드)
--
-- 전시장 관람객에게는 예약 PIN이 없다. QR을 찍어 그 자리에서 체험권을 받고,
-- 대기 번호를 받아 기다리다가, 차례가 오면 그 체험권의 PIN으로 부스에 들어간다.
--
-- reservations 와 합치지 않은 이유:
--   예약은 '날짜 + 타임슬롯' 단위라 하루 두 건뿐이고 미리 신청한다.
--   체험권은 '줄 선 순서' 단위라 하루에 수십 건이 즉석에서 생긴다.
--   같은 표에 넣으면 중복 예약 차단(uq_date_slot)에 바로 걸린다.
--
-- status 흐름: waiting → called → active → done
--                             ↘ expired (호출했는데 오지 않음)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS queue_tickets (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  ticket_no  INT NOT NULL,                  -- 그날의 대기 번호 (1부터)
  issued_on  DATE NOT NULL,                 -- 발급일 (번호는 날마다 1로 돌아간다)
  nickname   VARCHAR(20) NOT NULL DEFAULT '관람객',
  pin_code   VARCHAR(4) NOT NULL,           -- 이 체험권 전용 4자리
  status     VARCHAR(20) NOT NULL DEFAULT 'waiting',
  issued_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  called_at  DATETIME NULL,
  started_at DATETIME NULL,
  ended_at   DATETIME NULL,
  UNIQUE KEY uq_ticket_day (issued_on, ticket_no),
  INDEX idx_queue_status (issued_on, status)
);

-- ==============================================================================
-- 점수 기록 (부록G §2-④ 점수 저장 + 실시간 랭킹)
--
-- song_history 는 "어떤 곡을 몇 번 불렀나"를 누적한다. 랭킹은 그것과 다른
-- 질문이다 — "누가 언제 몇 점을 받았나"라서 한 곡을 여러 번 부르면 행도 여러 개
-- 생겨야 한다. 그래서 별도 테이블로 둔다.
--
-- 이름은 부스에서 직접 받는다. 예약자 이름을 쓰면 한 팀이 여러 명일 때 누가
-- 불렀는지 알 수 없고, 전시장에서는 예약 없이 체험하는 관람객도 있다.
-- ==============================================================================
CREATE TABLE IF NOT EXISTS score_records (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  nickname   VARCHAR(20) NOT NULL DEFAULT '익명',
  title      VARCHAR(100) NOT NULL,
  singer     VARCHAR(100) NOT NULL,
  score      INT NOT NULL,
  rank_label VARCHAR(20),
  pitch      INT,
  timing     INT,
  volume     INT,
  expression INT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_score (score DESC),
  INDEX idx_created (created_at DESC)
);

-- ==============================================================================
INSERT INTO devices (id, name, kind) VALUES
  -- 액추에이터 목록
  ('door_lock_1', '솔레노이드 도어락', 'door_lock'),
  ('relay_1', '기기 전원 릴레이', 'relay'),
  ('led_1', '부스 조명 LED', 'led'),
  ('speaker_1', '스피커/오디오 모듈', 'speaker'),
    ('fan_1', '부스 선풍기', 'fan'),
  -- 센서 목록
  ('keypad_1', '4x4 비밀번호 키패드', 'keypad'),
  ('pir_1', '입장 감지 센서', 'pir')
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  kind = VALUES(kind);

-- 노래 기록 초기 시드 데이터 (나의 18번 3회 이상 곡 포함)
INSERT INTO song_history (title, singer, sing_count) VALUES
  ('다시 만나', '더윈드', 5),
  ('첫 만남은 계획대로 되지 않아', 'TWS', 4),
  ('Supernova', 'aespa', 3),
  ('Love wins all', '아이유', 2),
  ('Hype Boy', 'NewJeans', 1)
ON DUPLICATE KEY UPDATE
  sing_count = VALUES(sing_count);

