
"use client";

import { useState, useEffect, useCallback, useSyncExternalStore } from "react";
import { apiUrl } from "@/utils/apiConfig";
import {
  adminFetch,
  subscribeAdminSession,
  getAdminSnapshot,
  getAdminServerSnapshot,
} from "@/utils/adminSession";
import { useKaraokeSocket } from "@/hooks/useKaraokeSocket";
import { SCHOOL_ANTHEM_TITLE } from "@/data/karaokeSongs";
import {
  Device,
  Reservation,
  ScoreRecord,
  Song,
  WebSocketMessage,
} from "@/types";

/** 부스 화면이 소리 내어 읽을 안내 한 건. seq 가 바뀔 때마다 새 안내다. */
export interface BoothAnnouncement {
  seq: number;
  /** auth · entry_detected · 10min_warning · session_ended */
  event: string;
  text: string;
}

/**
 * 키패드 인증 결과 방송.
 * 부스 앞 실물 키패드(라즈베리파이)로 누른 결과는 부스 화면이 HTTP 응답을 받지
 * 못한다. 이 방송으로 받아서 "비밀번호가 틀렸습니다" 같은 안내를 화면에 띄운다.
 */
export interface BoothAuthNotice {
  seq: number;
  success: boolean;
  mode?: string;
  /** invalid(틀림) · not_now(예약 시간 아님) */
  reason?: string;
  message: string;
}

/**
 * 부스 공용 데이터 훅 (부록G §3 화면 분리 / 부록J 작업 1)
 *
 * 세 화면(`/`·`/booth`·`/admin`)이 똑같이 필요로 하는 것을 한곳에 모았다.
 *   - 기기 상태 / 예약 목록 / 노래 기록을 백엔드에서 가져온다
 *   - WebSocket으로 실시간 변경을 받아 위 목록을 갱신한다
 *
 * 예전에는 이 코드가 app/page.tsx 안에 화면과 뒤섞여 있었다. 그대로 두고
 * 라우트를 셋으로 나누면 같은 로직이 세 벌로 복제되고, 한 곳만 고치는 실수가
 * 반드시 생긴다. 그래서 라우트를 나누기 **전에** 먼저 뽑아냈다.
 *
 * 백엔드가 꺼져 있어도 화면은 떠야 하므로, 모든 조회는 실패 시 조용히 넘어가고
 * 빈 목록을 유지한다.
 */
export function useBoothData() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [allSongs, setAllSongs] = useState<Song[]>([]);
  const [favoriteSongs, setFavoriteSongs] = useState<Song[]>([]);
  const [lastEventMsg, setLastEventMsg] = useState<string>("부스 시스템이 정상 대기 중입니다.");

  // 순위 (부록G §2-④) — 오늘 기록과 명예의 전당을 따로 본다
  const [topToday, setTopToday] = useState<ScoreRecord[]>([]);
  const [topAll, setTopAll] = useState<ScoreRecord[]>([]);

  // 축제 교가 부르기 대회 — 오늘 교가 점수, 이름당 최고 기록 하나 (상품 배부 기준)
  const [anthemTop, setAnthemTop] = useState<ScoreRecord[]>([]);

  // 부스 화면(/booth)이 읽어 줄 안내와 키패드 인증 결과.
  // 소리는 부스에서 나야 한다 — 예전에는 선생님 노트북(/admin)에서 났다.
  const [announcement, setAnnouncement] = useState<BoothAnnouncement | null>(null);
  const [authNotice, setAuthNotice] = useState<BoothAuthNotice | null>(null);

  const announce = useCallback((event: string, text?: string) => {
    // 이용 종료는 읽을 문장이 없어도 퇴실곡을 틀어야 하므로 그대로 넘긴다
    if (!text && event !== "session_ended") return;
    setAnnouncement((prev) => ({ seq: (prev?.seq ?? 0) + 1, event, text: text ?? "" }));
  }, []);

  const fetchDevices = useCallback(async () => {
    try {
      const res = await fetch(apiUrl("/api/devices"));
      if (res.ok) {
        const json = await res.json();
        setDevices(json.data || []);
      }
    } catch {
      // 백엔드가 아직 안 떴을 수 있다 — 화면은 그대로 둔다
    }
  }, []);

  // 예약 PIN은 서버가 관리자에게만 내려준다. adminFetch 는 관리자 토큰이 있을 때만
  // 헤더에 붙이므로, 학생·부스 화면에서는 PIN 없이 목록만 받는다.
  const fetchReservations = useCallback(async () => {
    try {
      const res = await adminFetch("/api/reservations");
      if (res.ok) {
        const json = await res.json();
        setReservations(json.data || []);
      }
    } catch {
      // 위와 같다
    }
  }, []);

  const fetchSongs = useCallback(async () => {
    try {
      const res = await fetch(apiUrl("/api/songs"));
      if (res.ok) {
        const json = await res.json();
        setAllSongs(json.data?.all || []);
        setFavoriteSongs(json.data?.favorites || []);
      }
    } catch {
      // 위와 같다
    }
  }, []);

  const fetchScores = useCallback(async () => {
    try {
      const anthemQuery = `period=today&limit=10&best=true&title=${encodeURIComponent(SCHOOL_ANTHEM_TITLE)}`;
      const [todayRes, allRes, anthemRes] = await Promise.all([
        fetch(apiUrl("/api/scores/top?period=today&limit=5")),
        fetch(apiUrl("/api/scores/top?period=all&limit=5")),
        fetch(apiUrl(`/api/scores/top?${anthemQuery}`)),
      ]);
      if (todayRes.ok) setTopToday((await todayRes.json()).data || []);
      if (allRes.ok) setTopAll((await allRes.json()).data || []);
      if (anthemRes.ok) setAnthemTop((await anthemRes.json()).data || []);
    } catch {
      // 순위를 못 받아도 노래방은 돌아가야 한다
    }
  }, []);

  // 관리자로 로그인·로그아웃하면 예약 목록을 다시 받는다 (PIN이 보였다 사라졌다 한다)
  const adminAuthed = useSyncExternalStore(
    subscribeAdminSession,
    getAdminSnapshot,
    getAdminServerSnapshot
  );

  useEffect(() => {
    // effect 본문에서 곧바로 상태를 바꾸지 않도록 첫 조회를 한 틱 미룬다
    // (React 19 규칙 react-hooks/set-state-in-effect)
    const id = setTimeout(() => {
      fetchDevices();
      fetchSongs();
      fetchScores();
    }, 0);
    return () => clearTimeout(id);
  }, [fetchDevices, fetchSongs, fetchScores]);

  useEffect(() => {
    const id = setTimeout(fetchReservations, 0);
    return () => clearTimeout(id);
  }, [fetchReservations, adminAuthed]);

  const handleWsMessage = useCallback(
    (msg: WebSocketMessage) => {
      if (msg.type === "device_state" && msg.device_id) {
        // 관리자 화면의 [스피커 테스트] — 부스 스피커는 부스 화면이 울린다.
        // (actor "user" = 관리자 제어. 파이가 보고한 상태(actor "device")는 읽지 않는다)
        const spoken = (msg.value as { message?: unknown } | null)?.message;
        if (
          msg.device_id === "speaker_1" &&
          msg.actor === "user" &&
          msg.state === "playing" &&
          typeof spoken === "string"
        ) {
          announce("speaker_test", spoken);
        }
        setDevices((prev) =>
          prev.map((d) =>
            d.id === msg.device_id
              ? {
                  ...d,
                  current_state: msg.state ?? d.current_state,
                  current_value: msg.value ?? d.current_value,
                }
              : d
          )
        );
      } else if (msg.type === "booth_auth") {
        const text = msg.message || (msg.success ? "인증 성공!" : "인증 실패!");
        setLastEventMsg(text);
        setAuthNotice((prev) => ({
          seq: (prev?.seq ?? 0) + 1,
          success: Boolean(msg.success),
          mode: msg.mode,
          reason: msg.reason,
          message: text,
        }));
        announce("auth", msg.speech);
        fetchDevices();
      } else if (msg.type === "booth_event") {
        setLastEventMsg(msg.message || "부스 이벤트 감지됨");
        announce(msg.event ?? "booth_event", msg.speech);
        fetchDevices();
      } else if (msg.type === "reservation_created") {
        fetchReservations();
      } else if (msg.type === "song_recorded") {
        fetchSongs();
      } else if (msg.type === "score_recorded") {
        // 누군가 점수를 받으면 부스 화면의 순위가 즉시 바뀐다
        setLastEventMsg(
          `${msg.nickname ?? "익명"}님이 ${msg.title ?? "노래"}로 ${msg.score ?? 0}점을 받았습니다!`
        );
        fetchScores();
      }
    },
    [fetchDevices, fetchReservations, fetchSongs, fetchScores, announce]
  );

  const { isConnected } = useKaraokeSocket(handleWsMessage);

  return {
    devices,
    reservations,
    allSongs,
    favoriteSongs,
    lastEventMsg,
    topToday,
    topAll,
    anthemTop,
    announcement,
    authNotice,
    isConnected,
    fetchDevices,
    fetchReservations,
    fetchSongs,
    fetchScores,
  };
}

/** 헤더 시계 — 서버에서 렌더링하면 시간이 어긋나므로 브라우저에서만 돈다 */
export function useClock(): string {
  const [timeStr, setTimeStr] = useState<string>("");

  useEffect(() => {
    // ko-KR 기본 형식은 "1시 16분 39초"라 자리수가 들쭉날쭉하고 제품 화면에 어울리지 않는다.
    // 두 자리로 고정해 숫자가 흔들리지 않게 한다 (.tnum 과 함께 쓴다).
    const pad = (n: number) => String(n).padStart(2, "0");
    const tick = () => {
      const d = new Date();
      setTimeStr(`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return timeStr;
}
