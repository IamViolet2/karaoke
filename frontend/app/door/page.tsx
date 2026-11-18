"use client";

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Delete,
  RotateCcw,
  Loader2,
} from "lucide-react";
import { apiUrl } from "@/utils/apiConfig";
import { useBoothData } from "@/hooks/useBoothData";

const KEY_ROWS = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
  ["BACKSPACE", "0", "CLEAR"],
];

const BUFFER_TIMEOUT_MS = 8000;
const RESULT_HOLD_MS = 6000;
const REQUEST_TIMEOUT_MS = 12000;

type Tone = "idle" | "busy" | "ok" | "admin" | "error";

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
    (value) => typeof value === "string" && value.trim()
  );

  if (typeof message === "string") return message;

  if (status === 401 || status === 403) {
    return "인증 권한을 확인할 수 없습니다.";
  }

  if (status === 404) {
    return "인증 API를 찾을 수 없습니다.";
  }

  if (status === 429) {
    return "잠시 후 다시 시도해 주세요.";
  }

  if (status >= 500) {
    return "서버 오류가 발생했습니다.";
  }

  return "비밀번호가 맞지 않습니다.";
}

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
    const time = beepCtx.currentTime;

    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, time);
    gain.gain.setValueAtTime(0.08, time);
    gain.gain.exponentialRampToValueAtTime(
      0.001,
      time + ms / 1000
    );

    osc.connect(gain);
    gain.connect(beepCtx.destination);

    osc.start(time);
    osc.stop(time + ms / 1000);
  } catch {
    // 소리 재생 실패 시에도 키패드는 동작한다.
  }
}

export default function DoorPage() {
  const { authNotice, fetchDevices } = useBoothData();

  const [digits, setDigits] = useState("");
  const [tone, setTone] = useState<Tone>("idle");
  const [message, setMessage] = useState("");

  const digitsRef = useRef("");
  const busyRef = useRef(false);
  const mountedRef = useRef(false);

  const requestSeqRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seenNoticeRef = useRef(authNotice?.seq ?? 0);

  const clearDigits = useCallback(() => {
    digitsRef.current = "";
    setDigits("");
  }, []);

  const clearTimers = useCallback(() => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, []);

  const showResult = useCallback(
    (nextTone: Tone, text: string) => {
      if (!mountedRef.current) return;

      clearTimers();

      setTone(nextTone);
      setMessage(text);

      holdTimerRef.current = setTimeout(() => {
        if (!mountedRef.current) return;

        setTone("idle");
        setMessage("");
        holdTimerRef.current = null;
      }, RESULT_HOLD_MS);
    },
    [clearTimers]
  );

  const resetDisplay = useCallback(() => {
    clearTimers();
    setTone("idle");
    setMessage("");
  }, [clearTimers]);

  const deleteLastDigit = useCallback(() => {
    if (busyRef.current) return;

    beep(440, 70);

    const next = digitsRef.current.slice(0, -1);

    digitsRef.current = next;
    setDigits(next);
    resetDisplay();
  }, [resetDisplay]);

  const clearAllDigits = useCallback(() => {
    if (busyRef.current) return;

    beep(440, 90);
    clearDigits();
    resetDisplay();
  }, [clearDigits, resetDisplay]);

  const submit = useCallback(
    async (pin: string) => {
      if (busyRef.current) return;

      busyRef.current = true;

      const requestId = ++requestSeqRef.current;
      const controller = new AbortController();

      controllerRef.current = controller;

      clearTimers();

      setTone("busy");
      setMessage("인증 확인 중...");

      let timedOut = false;

      const timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(
          apiUrl("/api/booth/verify-keypad"),
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ pin }),
            signal: controller.signal,
          }
        );

        if (
          requestId !== requestSeqRef.current ||
          controller.signal.aborted
        ) {
          return;
        }

        const body = await response.json().catch(() => null);

        if (
          requestId !== requestSeqRef.current ||
          controller.signal.aborted
        ) {
          return;
        }

        if (!response.ok) {
          beep(220, 300);
          showResult(
            "error",
            getErrorMessage(body, response.status)
          );
          return;
        }

        const mode =
          typeof body?.data?.mode === "string"
            ? body.data.mode
            : undefined;

        const isAdmin = mode === "admin";

        beep(1320, 120);

        showResult(
          isAdmin ? "admin" : "ok",
          isAdmin
            ? "관리자 인증 성공"
            : body?.data?.message ?? "인증 성공! 문이 열립니다."
        );
      } catch (error) {
        if (requestId !== requestSeqRef.current) return;

        beep(220, 300);

        if (
          timedOut ||
          (error instanceof Error && error.name === "AbortError")
        ) {
          showResult(
            "error",
            "인증 시간이 초과되었습니다. 다시 시도해 주세요."
          );
        } else {
          console.error("[Door] PIN 인증 오류:", error);

          showResult(
            "error",
            "서버에 연결할 수 없습니다."
          );
        }
      } finally {
        clearTimeout(timeoutId);

        if (requestId === requestSeqRef.current) {
          busyRef.current = false;
          controllerRef.current = null;
          clearDigits();

          if (mountedRef.current) {
            try {
              await fetchDevices();
            } catch (error) {
              console.error("[Door] 장치 상태 조회 오류:", error);
            }
          }
        }
      }
    },
    [clearDigits, clearTimers, fetchDevices, showResult]
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
        resetDisplay();
      }

      if (next.length === 4) {
        void submit(next);
      }
    },
    [clearAllDigits, deleteLastDigit, resetDisplay, submit, tone]
  );

  const pressRef = useRef(press);

  useEffect(() => {
    pressRef.current = press;
  }, [press]);

  // 키보드 입력
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const target = event.target as HTMLElement | null;

      if (
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable
      ) {
        return;
      }

      if (/^[0-9]$/.test(event.key)) {
        pressRef.current(event.key);
      } else if (event.key === "Backspace") {
        pressRef.current("BACKSPACE");
      } else if (
        event.key === "Delete" ||
        event.key === "Escape"
      ) {
        pressRef.current("CLEAR");
      } else {
        return;
      }

      event.preventDefault();
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  // 입력 시간 제한
  useEffect(() => {
    if (!digits || digits.length >= 4 || tone === "busy") return;

    const timer = setTimeout(() => {
      clearDigits();
    }, BUFFER_TIMEOUT_MS);

    return () => clearTimeout(timer);
  }, [digits, clearDigits, tone]);

  // 실물 키패드 인증 결과
  useEffect(() => {
    if (!authNotice || authNotice.seq <= seenNoticeRef.current) {
      return;
    }

    seenNoticeRef.current = authNotice.seq;

    const nextTone: Tone = authNotice.success
      ? authNotice.mode === "admin"
        ? "admin"
        : "ok"
      : "error";

    const timer = setTimeout(() => {
      showResult(nextTone, authNotice.message);

      if (authNotice.success) {
        void fetchDevices();
      }
    }, 0);

    return () => clearTimeout(timer);
  }, [authNotice, showResult, fetchDevices]);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      requestSeqRef.current += 1;

      controllerRef.current?.abort();
      controllerRef.current = null;

      clearTimers();
    };
  }, [clearTimers]);

  const displayStyle =
    tone === "ok"
      ? "border-emerald-400 bg-emerald-50 text-emerald-700"
      : tone === "admin"
        ? "border-amber-400 bg-amber-50 text-amber-700"
        : tone === "error"
          ? "border-red-300 bg-red-50 text-red-600"
          : "border-slate-200 bg-slate-50 text-slate-700";

  return (
    <main
      className="
        fixed
        inset-0
        h-[100dvh]
        w-screen
        overflow-hidden
        overscroll-none
        touch-pan-x
      "
      style={{
        overflow: "hidden",
        WebkitOverflowScrolling: "auto",
      }}
    >
      {/* 화면 정중앙을 기준으로 키패드 회전 */}
      <div
        className="
          absolute
          left-1/2
          top-1/2
          flex
          h-[100vw]
          w-[100dvh]
          -translate-x-1/2
          -translate-y-1/2
          rotate-[-90deg]
          items-center
          justify-center
          overflow-hidden
        "
      >
        <section
          className="
            flex
            h-full
            w-full
            max-w-[680px]
            flex-col
            justify-center
            gap-7
            px-6
            py-5
          "
        >
          {/* PIN 표시 영역 */}
          <div
            className={`
              flex
              min-h-[100px]
              items-center
              justify-center
              rounded-2xl
              border-2
              px-4
              transition-colors
              ${displayStyle}
            `}
            role="status"
            aria-live="polite"
          >
            {tone === "busy" ? (
              <div className="flex items-center gap-3">
                <Loader2 className="h-8 w-8 animate-spin" />
                <span className="text-2xl font-bold">
                  {message}
                </span>
              </div>
            ) : message ? (
              <p className="text-center text-xl font-bold leading-snug">
                {message}
              </p>
            ) : (
              <div className="flex flex-col items-center gap-4">
                <span className="text-base font-semibold text-slate-500">
                  PIN 번호 입력
                </span>

                <div className="flex items-center gap-6">
                  {[0, 1, 2, 3].map((index) => (
                    <span
                      key={index}
                      className={`
                        h-5 w-5 rounded-full border-2
                        ${
                          index < digits.length
                            ? "border-slate-800 bg-slate-800"
                            : "border-slate-300 bg-transparent"
                        }
                      `}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* 숫자 키패드 */}
          <div className="grid grid-cols-3 gap-4">
            {KEY_ROWS.flat().map((key) => {
              const isDigit = /^[0-9]$/.test(key);
              const isBackspace = key === "BACKSPACE";

              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => press(key)}
                  disabled={tone === "busy"}
                  aria-label={
                    isBackspace
                      ? "지우기"
                      : key === "CLEAR"
                        ? "전체 지우기"
                        : key
                  }
                  className={`
                    flex
                    min-h-[100px]
                    select-none
                    flex-col
                    items-center
                    justify-center
                    gap-2
                    rounded-2xl
                    border
                    transition-all
                    active:scale-95
                    disabled:cursor-not-allowed
                    disabled:opacity-40
                    ${
                      isDigit
                        ? "border-slate-200 bg-white text-4xl font-bold text-slate-800 shadow-sm hover:bg-slate-50"
                        : isBackspace
                          ? "border-red-200 bg-red-50 text-red-600 hover:bg-red-100"
                          : "border-slate-200 bg-slate-100 text-slate-600 hover:bg-slate-200"
                    }
                  `}
                >
                  {isDigit ? (
                    key
                  ) : isBackspace ? (
                    <>
                      <Delete className="h-8 w-8" />
                      <span className="text-base font-bold">
                        지우기
                      </span>
                    </>
                  ) : (
                    <>
                      <RotateCcw className="h-7 w-7" />
                      <span className="text-base font-bold">
                        전체 지우기
                      </span>
                    </>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </main>
  );
}