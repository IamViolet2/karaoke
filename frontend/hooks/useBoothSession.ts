
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl } from "@/utils/apiConfig";
import { BoothSession } from "@/types";

/** 받은 시각을 함께 들고 다닌다 — 남은 시간을 화면에서 줄여 나갈 때 쓴다 */
export type BoothSessionState = BoothSession & { fetchedAt: number };

const REFRESH_MS = 1_000;

/**
 * 지금 부스를 쓰는 사람과 남은 시간
 * (부스 화면 전용, GET /api/booth/session)
 *
 * 부스 전원이 켜져 있는 동안만 조회한다.
 * 남은 시간은 서버가 잰 값(remaining_sec)과 받은 시각(fetchedAt)을 함께 보관하고,
 * 화면에서는 받은 뒤로 흐른 시간만 뺀다.
 */
export function useBoothSession(isPowerOn: boolean): BoothSessionState | null {
  const [session, setSession] = useState<BoothSessionState | null>(null);
  const inFlightRef = useRef(false);

  const fetchSession = useCallback(async (signal: AbortSignal) => {
    if (inFlightRef.current || signal.aborted) return;

    inFlightRef.current = true;

    try {
      const res = await fetch(apiUrl("/api/booth/session"), {
        method: "GET",
        cache: "no-store",
        signal,
      });

      if (!res.ok) {
        if (!signal.aborted) {
          setSession(null);
        }
        return;
      }

      const body = await res.json();

      if (signal.aborted) return;

      const data = body?.data as BoothSession | null | undefined;

      if (!data || typeof data !== "object") {
        setSession(null);
        return;
      }

      setSession({
        ...data,
        fetchedAt: Date.now(),
      });
    } catch (error) {
      if (signal.aborted) return;

      // 조회 실패 시 이전 이용자 정보가 계속 표시되지 않도록 초기화한다.
      setSession(null);
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!isPowerOn) {
      setSession(null);
      return;
    }

    const controller = new AbortController();

    // 화면 진입 직후 첫 조회
    const first = setTimeout(() => {
      void fetchSession(controller.signal);
    }, 0);

    // 이후 1초 간격으로 세션 상태 갱신
    const timer = setInterval(() => {
      void fetchSession(controller.signal);
    }, REFRESH_MS);

    return () => {
      clearTimeout(first);
      clearInterval(timer);
      controller.abort();
      inFlightRef.current = false;
    };
  }, [isPowerOn, fetchSession]);

  return isPowerOn ? session : null;
}

/** 지금 남은 시간(초). 알 수 없으면 null */
export function remainingSeconds(
  session: BoothSessionState | null,
  nowMs: number
): number | null {
  if (!session?.kind || typeof session.remaining_sec !== "number") {
    return null;
  }

  return Math.max(
    0,
    session.remaining_sec -
      Math.floor((nowMs - session.fetchedAt) / 1000)
  );
}

/**
 * "13:20"
 * 서버가 부스 시간대로 보내 준 값에서 시:분만 꺼낸다.
 * 브라우저 시간대와 무관하다.
 */
export function endsAtLabel(
  session: BoothSessionState | null
): string | null {
  const text = session?.ends_at;

  return text && text.length >= 16 ? text.slice(11, 16) : null;
}
