"use client";

import React, { useEffect, useState } from "react";
import { AlertTriangle, Clock, PowerOff } from "lucide-react";
import {
  BoothSessionState,
  endsAtLabel,
  remainingSeconds,
} from "@/hooks/useBoothSession";

/** 1초마다 바뀌는 현재 시각. 이 작은 컴포넌트 안에서만 다시 그리게 한다 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (!active) return;

    const first = setTimeout(() => setNow(Date.now()), 0);
    const id = setInterval(() => setNow(Date.now()), 1000);

    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [active]);

  return now;
}

export function formatClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 경고 기준 초를 사람이 읽기 쉬운 문장으로 변환 */
function formatWarningTime(sec: number): string {
  if (sec % 60 === 0) {
    return `${sec / 60}분 전`;
  }

  if (sec >= 60) {
    const minutes = Math.floor(sec / 60);
    const seconds = sec % 60;

    return seconds > 0
      ? `${minutes}분 ${seconds}초 전`
      : `${minutes}분 전`;
  }

  return `${sec}초 전`;
}

/** 남은 시간 "12:34" — 서버 기준. 알 수 없으면 아무것도 그리지 않는다 */
export function RemainingClock({
  session,
}: {
  session: BoothSessionState | null;
}) {
  const now = useNow(Boolean(session?.kind));
  const left = remainingSeconds(session, now || session?.fetchedAt || 0);

  if (left === null) return null;

  return <span className="font-mono tnum">{formatClock(left)}</span>;
}

/**
 * 노래방 화면 상단 브랜드 라인에 표시되는 이용 정보
 * 기존 별도 세션 정보 줄을 제거하고 상단 한 줄에 통합한다.
 */
export function SessionStrip({
  session,
  isPowerOn,
  ledBlink,
}: {
  session: BoothSessionState | null;
  isPowerOn: boolean;
  ledBlink: boolean;
}) {
  const now = useNow(isPowerOn && Boolean(session?.kind));

  if (!isPowerOn) {
    return (
      <span
        className="flex items-center gap-2 rounded-full border border-rose-300/20 bg-rose-400/[0.08] px-3 py-2 text-[11px] font-semibold text-rose-200"
        role="status"
        data-testid="session-ended"
      >
        <PowerOff className="h-4 w-4 shrink-0" aria-hidden />
        이용 시간이 끝났습니다
      </span>
    );
  }

  const left = remainingSeconds(session, now || session?.fetchedAt || 0);
  const until = endsAtLabel(session);
  const endingSoon = left !== null && left <= 60;
  const warnBeforeSec =
    typeof session?.warn_before_sec === "number"
      ? session.warn_before_sec
      : null;

  const warnBefore =
    session?.kind === "reservation" &&
    left !== null &&
    warnBeforeSec !== null &&
    left <= warnBeforeSec;

  const showWarning = ledBlink || warnBefore;

  return (
    <div
      className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 text-[11px] sm:text-xs"
      data-testid="session-strip"
    >
      <span className="flex shrink-0 items-center gap-2 rounded-full border border-emerald-300/20 bg-emerald-400/[0.08] px-3 py-2 font-semibold text-emerald-200">
        <span
          className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.9)]"
          aria-hidden
        />
        이용 중
      </span>

      {session?.user_name && (
        <strong className="whitespace-nowrap text-slate-200">
          {session.user_name}님
        </strong>
      )}

      {until && (
        <span className="flex items-center gap-1.5 whitespace-nowrap text-slate-400">
          <Clock className="h-3.5 w-3.5 text-slate-500" aria-hidden />
          {until}까지
        </span>
      )}

      {left !== null && (
        <span className="whitespace-nowrap text-slate-400">
          남은 시간{" "}
          <strong className="font-mono tnum text-sm text-white">
            {formatClock(left)}
          </strong>
        </span>
      )}

      {(endingSoon || showWarning) && (
        <span className="flex items-center gap-1.5 whitespace-nowrap rounded-full border border-amber-300/30 bg-amber-400/[0.10] px-3 py-1.5 font-bold text-amber-200">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {endingSoon
            ? "곧 끝납니다 — 마무리해 주세요"
            : `종료 ${warnBeforeSec !== null ? formatWarningTime(warnBeforeSec) : "임박"} — 정리를 준비해 주세요`}
        </span>
      )}
    </div>
  );
}