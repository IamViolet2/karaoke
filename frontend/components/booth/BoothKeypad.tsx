
"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { KeyRound, Loader2, Delete, RotateCcw } from "lucide-react";
import { apiUrl } from "@/utils/apiConfig";
import type { BoothAuthNotice } from "@/hooks/useBoothData";

const KEY_ROWS = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
  ["BACKSPACE", "0", "CLEAR"],
];

const BUFFER_TIMEOUT_MS = 8_000;
const RESULT_HOLD_MS = 6_000;
const REQUEST_TIMEOUT_MS = 12_000;

type Tone = "idle" | "busy" | "ok" | "admin" | "warn" | "error";

const TONE_CLASS: Record<Tone, string> = {
  idle: "bg-canvas border-line-strong text-ink-2",
  busy: "bg-canvas border-line-strong text-ink-2",
  ok: "bg-free-soft border-free text-free",
  admin: "bg-brass-soft border-brass text-brass",
  warn: "bg-brass-soft border-brass text-ink",
  error: "bg-live-soft border-live text-live",
};

let beepCtx: AudioContext | null = null;

function beep(freq: number, ms: number) {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as {
        webkitAudioContext?: typeof AudioContext;
      }).webkitAudioContext;

    if (!Ctx) return;

    beepCtx = beepCtx ?? new Ctx();

    if (beepCtx.state === "suspended") {
      void beepCtx.resume();
    }

    const osc = beepCtx.createOscillator();
    const gain = beepCtx.createGain();
    const t = beepCtx.currentTime;

    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0.08, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + ms / 1000);

    osc.connect(gain);
    gain.connect(beepCtx.destination);

    osc.start(t);
    osc.stop(t + ms / 1000);
  } catch {
    // 소리가 안 나도 키패드는 동작한다.
  }
}

function getErrorMessage(body: any, status: number): string {
  const candidates = [
    body?.error?.message,
    body?.detail?.message,
    body?.detail?.error?.message,
    body?.detail,
    body?.message,
    body?.data?.message,
  ];

  const message = candidates.find(
    (value) => typeof value === "string" && value.trim().length > 0
  );

  if (typeof message === "string") return message;

  if (status === 401 || status === 403) {
    return "인증 권한을 확인할 수 없습니다. 선생님께 문의해 주세요.";
  }

  if (status === 404) {
    return "인증 API를 찾을 수 없습니다. 서버 설정을 확인해 주세요.";
  }

  if (status === 429) {
    return "여러 번 틀려 잠시 막혔습니다. 잠시 뒤 다시 눌러 주세요.";
  }

  if (status >= 500) {
    return "부스 서버에서 오류가 발생했습니다. 선생님께 알려 주세요.";
  }

  return "비밀번호가 맞지 않습니다.";
}

interface BoothKeypadProps {
  notice?: BoothAuthNotice | null;
  onVerified?: () => void;
  onAuthSuccess?: (mode?: string) => void;
  onAuthAttempt?: () => void;
}

export function BoothKeypad({
  notice = null,
  onVerified,
  onAuthSuccess,
  onAuthAttempt,
}: BoothKeypadProps) {
  const [digits, setDigits] = useState("");
  const [tone, setTone] = useState<Tone>("idle");
  const [message, setMessage] = useState<string | null>(null);

  const digitsRef = useRef("");
  const busyRef = useRef(false);
  const requestSeqRef = useRef(0);
  const activeControllerRef = useRef<AbortController | null>(null);

  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seenNoticeRef = useRef(notice?.seq ?? 0);

  const showResult = useCallback((nextTone: Tone, text: string) => {
    setTone(nextTone);
    setMessage(text);

    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
    }

    holdTimerRef.current = setTimeout(() => {
      setTone("idle");
      setMessage(null);
      holdTimerRef.current = null;
    }, RESULT_HOLD_MS);
  }, []);

  const clearDigits = useCallback(() => {
    digitsRef.current = "";
    setDigits("");
  }, []);

  const deleteLastDigit = useCallback(() => {
    if (busyRef.current) return;

    beep(440, 70);

    const next = digitsRef.current.slice(0, -1);
    digitsRef.current = next;
    setDigits(next);

    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }

    setTone("idle");
    setMessage(null);
  }, []);

  const clearAllDigits = useCallback(() => {
    if (busyRef.current) return;

    beep(440, 90);
    clearDigits();

    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }

    setTone("idle");
    setMessage(null);
  }, [clearDigits]);

  const submit = useCallback(
    async (pin: string) => {
      if (busyRef.current) return;

      busyRef.current = true;

      const requestId = ++requestSeqRef.current;
      const controller = new AbortController();

      activeControllerRef.current = controller;

      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }

      setTone("busy");
      setMessage("확인 중입니다…");

      try {
        onAuthAttempt?.();
      } catch (error) {
        console.error("인증 시도 콜백 오류:", error);
      }

      let timedOut = false;

      const timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, REQUEST_TIMEOUT_MS);

      try {
        const res = await fetch(apiUrl("/api/booth/verify-keypad"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ pin }),
          signal: controller.signal,
        });

        if (requestId !== requestSeqRef.current || controller.signal.aborted) {
          return;
        }

        const body = await res.json().catch(() => null);

        if (requestId !== requestSeqRef.current || controller.signal.aborted) {
          return;
        }

        if (!res.ok) {
          beep(220, 300);
          showResult("error", getErrorMessage(body, res.status));
          return;
        }

        const mode =
          typeof body?.data?.mode === "string"
            ? body.data.mode
            : undefined;

        const admin = mode === "admin";

        beep(1320, 120);

        showResult(
          admin ? "admin" : "ok",
          admin
            ? "관리자 인증 — 문이 열립니다 (노래방 전원은 켜지 않습니다)"
            : body?.data?.message ?? "인증 성공! 문이 열립니다"
        );

        try {
          onAuthSuccess?.(mode);
        } catch (callbackError) {
          console.error("인증 성공 콜백 오류:", callbackError);
        }
      } catch (error) {
        if (requestId !== requestSeqRef.current) return;

        beep(220, 300);

        if (
          timedOut ||
          (error instanceof Error && error.name === "AbortError")
        ) {
          showResult(
            "error",
            "인증 요청 시간이 초과되었습니다. 서버 상태를 확인한 뒤 다시 시도해 주세요."
          );
        } else {
          console.error("키패드 인증 요청 오류:", error);

          showResult(
            "error",
            "부스 서버에 연결할 수 없습니다. 선생님께 알려 주세요."
          );
        }
      } finally {
        clearTimeout(timeoutId);

        if (requestId === requestSeqRef.current) {
          busyRef.current = false;
          activeControllerRef.current = null;
          clearDigits();

          try {
            onVerified?.();
          } catch (callbackError) {
            console.error("인증 완료 콜백 오류:", callbackError);
          }
        }
      }
    },
    [
      clearDigits,
      onAuthAttempt,
      onAuthSuccess,
      onVerified,
      showResult,
    ]
  );

  const press = useCallback(
    (key: string) => {
      if (busyRef.current) return;

      if (key === "BACKSPACE") {
        deleteLastDigit();
        return;
      }

      if (key === "CLEAR") {
        clearAllDigits();
        return;
      }

      if (!/^[0-9]$/.test(key)) return;

      beep(880, 60);

      const next = (digitsRef.current + key).slice(0, 4);

      digitsRef.current = next;
      setDigits(next);

      if (tone !== "idle") {
        if (holdTimerRef.current) {
          clearTimeout(holdTimerRef.current);
          holdTimerRef.current = null;
        }

        setTone("idle");
        setMessage(null);
      }

      if (next.length === 4) {
        void submit(next);
      }
    },
    [clearAllDigits, deleteLastDigit, submit, tone]
  );

  useEffect(() => {
    if (!digits || digits.length >= 4) return;

    const id = setTimeout(clearDigits, BUFFER_TIMEOUT_MS);

    return () => clearTimeout(id);
  }, [digits, clearDigits]);

  const pressRef = useRef(press);

  useEffect(() => {
    pressRef.current = press;
  }, [press]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;

      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA")
      ) {
        return;
      }

      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (/^[0-9]$/.test(e.key)) {
        pressRef.current(e.key);
      } else if (e.key === "Backspace") {
        pressRef.current("BACKSPACE");
      } else if (
        e.key === "Delete" ||
        e.key === "Escape" ||
        e.key === "*"
      ) {
        pressRef.current("CLEAR");
      } else {
        return;
      }

      e.preventDefault();
    };

    window.addEventListener("keydown", onKey);

    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 실물 키패드 인증 결과 (서버 방송)
  useEffect(() => {
    if (!notice || notice.seq <= seenNoticeRef.current) return;

    seenNoticeRef.current = notice.seq;

    const nextTone: Tone = notice.success
      ? notice.mode === "admin"
        ? "admin"
        : "ok"
      : "error";

    const id = setTimeout(() => {
      showResult(nextTone, notice.message);
    }, 0);

    return () => clearTimeout(id);
  }, [notice, showResult]);

  useEffect(
    () => () => {
      requestSeqRef.current += 1;
      activeControllerRef.current?.abort();

      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
      }
    },
    []
  );

  return (
    <div className="w-full max-w-2xl mx-auto rounded-2xl bg-raised border border-line p-5 sm:p-7 space-y-5">
      <div className="flex items-center gap-3">
        <KeyRound className="w-6 h-6 text-brass shrink-0" aria-hidden />
        <span className="text-lg font-bold text-ink">도어 키패드</span>
        <span className="ml-auto text-sm text-ink-3">
          4자리 · 자동 확인
        </span>
      </div>

      <div
        className={`rounded-xl border px-4 py-5 min-h-[7rem] flex flex-col items-center justify-center text-center transition-colors ${TONE_CLASS[tone]}`}
        role="status"
        aria-live="polite"
        data-testid="keypad-display"
      >
        {message ? (
          <p className="text-base sm:text-lg font-bold leading-snug flex items-center gap-2">
            {tone === "busy" && (
              <Loader2
                className="w-5 h-5 animate-spin shrink-0"
                aria-hidden
              />
            )}
            {message}
          </p>
        ) : (
          <>
            <span className="text-sm sm:text-base text-ink-3">
              예약 비밀번호를 입력하세요
            </span>

            <span
              className="mt-3 flex gap-4"
              aria-label={`${digits.length}자리 입력됨`}
            >
              {[0, 1, 2, 3].map((i) => (
                <span
                  key={i}
                  className={`w-4 h-4 sm:w-5 sm:h-5 rounded-full border-2 ${
                    i < digits.length
                      ? "bg-ink border-ink"
                      : "border-line-strong"
                  }`}
                />
              ))}
            </span>
          </>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3 sm:gap-4">
        {KEY_ROWS.flat().map((key) => {
          const isDigit = /^[0-9]$/.test(key);
          const isBackspace = key === "BACKSPACE";
          const isClear = key === "CLEAR";

          return (
            <button
              key={key}
              type="button"
              onClick={() => {
                console.log("[BUTTON CLICK]", key);
                press(key);
              }}
              disabled={tone === "busy"}
              aria-label={
                isBackspace
                  ? "지우기"
                  : isClear
                    ? "전체 지우기"
                    : key
              }
              className={`min-h-20 sm:min-h-24 rounded-2xl border font-mono tnum transition-all select-none flex flex-col items-center justify-center gap-1 ${
                isDigit
                  ? "bg-surface border-line-strong text-ink text-3xl sm:text-4xl font-bold hover:bg-canvas active:scale-95 cursor-pointer"
                  : isBackspace
                    ? "bg-live-soft border-live/40 text-live text-lg sm:text-xl font-bold hover:bg-live-soft/70 active:scale-95 cursor-pointer"
                    : "bg-canvas border-line-strong text-ink-2 text-base sm:text-lg font-bold hover:bg-surface active:scale-95 cursor-pointer"
              } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              {isDigit ? (
                key
              ) : isBackspace ? (
                <>
                  <Delete className="w-7 h-7 sm:w-8 sm:h-8" aria-hidden />
                  <span className="font-sans">지우기</span>
                </>
              ) : (
                <>
                  <RotateCcw className="w-6 h-6 sm:w-7 sm:h-7" aria-hidden />
                  <span className="font-sans">전체 지우기</span>
                </>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
