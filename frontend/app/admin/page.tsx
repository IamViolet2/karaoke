
"use client";

import React, {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import Link from "next/link";
import { Monitor, Home, RefreshCw } from "lucide-react";

import { CctvPanel } from "@/components/admin/CctvPanel";

import { AppHeader } from "@/components/layout/AppHeader";
import { AdminGate } from "@/components/booth/AdminGate";
import { VirtualBoothSimulator } from "@/components/booth/VirtualBoothSimulator";
import { ReservationSection } from "@/components/booth/ReservationSection";
import { SongHistorySection } from "@/components/booth/SongHistorySection";
import { VideoCheckPanel } from "@/components/booth/VideoCheckPanel";
import { OpsSummary } from "@/components/admin/OpsSummary";
import { SchedulerPanel } from "@/components/admin/SchedulerPanel";
import { AnthemRankingPanel } from "@/components/admin/AnthemRankingPanel";
import { useBoothData } from "@/hooks/useBoothData";
import { apiUrl } from "@/utils/apiConfig";
import {
  adminFetch,
  clearAdminSession,
  subscribeAdminSession,
  getAdminSnapshot,
  getAdminServerSnapshot,
} from "@/utils/adminSession";

/**
 * `/admin` — 선생님 노트북 화면
 */
export default function AdminPage() {
  const {
    devices,
    reservations,
    allSongs,
    favoriteSongs,
    lastEventMsg,
    isConnected,
    fetchDevices,
    fetchReservations,
  } = useBoothData();

  const adminAuthed = useSyncExternalStore(
    subscribeAdminSession,
    getAdminSnapshot,
    getAdminServerSnapshot
  );

  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(
    null
  );
  const [isExtending, setIsExtending] = useState(false);

  /** 관리자 토큰이 만료됐을 때 공통 처리 */
  const handleExpired = useCallback(() => {
    clearAdminSession();
    setRemainingSeconds(null);
    alert("관리자 인증이 만료되었습니다. 관리자 PIN으로 다시 인증해 주세요.");
  }, []);

  /**
   * 관리자 세션 조회
   *
   * 최초 조회에 실패하면 1.5초 뒤 다시 조회한다.
   * 네트워크가 일시적으로 불안정해도 카운트다운이 멈춰 있는 상황을 방지한다.
   */
  useEffect(() => {
    if (!adminAuthed) {
      setRemainingSeconds(null);
      return;
    }

    let cancelled = false;
    let retryTimer: number | null = null;

    const checkSession = async () => {
      try {
        const res = await adminFetch("/api/admin/session", {
          method: "GET",
        });

        if (cancelled) return;

        if (res.status === 401) {
          handleExpired();
          return;
        }

        if (!res.ok) {
          console.error(
            "관리자 세션 조회 실패:",
            res.status,
            res.statusText
          );

          retryTimer = window.setTimeout(checkSession, 1500);
          return;
        }

        const data = await res.json().catch(() => null);

        if (cancelled) return;

        if (!data?.data?.valid) {
          handleExpired();
          return;
        }

        const seconds = Number(data.data.remaining_seconds);

        if (!Number.isFinite(seconds) || seconds < 0) {
          console.error("관리자 세션 남은 시간 응답이 올바르지 않습니다:", data);

          retryTimer = window.setTimeout(checkSession, 1500);
          return;
        }

        if (seconds === 0) {
          handleExpired();
          return;
        }

        setRemainingSeconds(Math.ceil(seconds));
      } catch (error) {
        if (cancelled) return;

        console.error("관리자 세션 확인 오류:", error);

        // 일시적인 서버 연결 오류라면 다시 조회한다.
        retryTimer = window.setTimeout(checkSession, 1500);
      }
    };

    checkSession();

    return () => {
      cancelled = true;

      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [adminAuthed, handleExpired]);

  /**
   * 남은 시간 카운트다운
   *
   * remainingSeconds가 null에서 숫자로 바뀌면 타이머를 시작한다.
   * 매초 숫자가 바뀌더라도 타이머를 재생성하지 않는다.
   */
  useEffect(() => {
    if (!adminAuthed || remainingSeconds === null) {
      return;
    }

    const timer = window.setInterval(() => {
      setRemainingSeconds((current) => {
        if (current === null) return null;

        return Math.max(0, current - 1);
      });
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [adminAuthed, remainingSeconds !== null]);

  /**
   * 남은 시간이 0초가 되면 관리자 인증을 만료 처리한다.
   */
  useEffect(() => {
    if (adminAuthed && remainingSeconds === 0) {
      handleExpired();
    }
  }, [adminAuthed, remainingSeconds, handleExpired]);

  /**
   * 관리자 세션 1시간 연장
   * 기존 토큰을 사용하며 새로운 토큰을 발급하지 않는다.
   */
  const handleExtendSession = useCallback(async () => {
    if (isExtending) return;

    setIsExtending(true);

    try {
      const res = await adminFetch("/api/admin/session/extend", {
        method: "POST",
      });

      if (res.status === 401) {
        handleExpired();
        return;
      }

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        const message =
          data?.detail?.message ||
          data?.error?.message ||
          "관리자 세션 연장에 실패했습니다.";

        alert(message);
        return;
      }

      const newRemainingSeconds = Number(
        data?.data?.remaining_seconds ?? data?.data?.expires_in
      );

      if (!Number.isFinite(newRemainingSeconds) || newRemainingSeconds <= 0) {
        alert("세션 연장 응답이 올바르지 않습니다.");
        return;
      }

      setRemainingSeconds(newRemainingSeconds);
      alert("관리자 세션이 1시간 연장되었습니다.");
    } catch (error) {
      console.error("관리자 세션 연장 오류:", error);
      alert("서버 연결에 실패했습니다. 세션 연장 여부를 확인해 주세요.");
    } finally {
      setIsExtending(false);
    }
  }, [isExtending, handleExpired]);

  /** 남은 시간을 MM:SS 형식으로 표시 */
  const formatRemainingTime = (seconds: number | null) => {
    if (seconds === null) return "--:--";

    const minutes = Math.floor(seconds / 60);
    const remaining = seconds % 60;

    return `${String(minutes).padStart(2, "0")}:${String(
      remaining
    ).padStart(2, "0")}`;
  };

  const handleDeviceControl = useCallback(
    async (deviceId: string, state: string, value?: unknown) => {
      try {
        const res = await adminFetch(`/api/devices/${deviceId}/control`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ desired_state: state, value }),
        });

        if (res.status === 401) {
          handleExpired();
          return;
        }

        if (!res.ok) {
          const data = await res.json().catch(() => null);
          const message =
            data?.error?.message ||
            data?.detail?.message ||
            data?.detail ||
            "기기 제어 요청에 실패했습니다.";

          alert(
            typeof message === "string"
              ? message
              : JSON.stringify(message)
          );
          return;
        }

        await fetchDevices();
      } catch (e) {
        console.error("기기 제어 오류:", e);
        alert("서버 연결에 실패했습니다. 네트워크 상태를 확인해 주세요.");
      }
    },
    [fetchDevices, handleExpired]
  );

  /** 시나리오 강제 실행 3종 */
  const runScenario = useCallback(
    async (path: string) => {
      const isEndScenario = path === "/api/booth/simulate-end";

      try {
        const res = await adminFetch(path, { method: "POST" });

        if (res.status === 401) {
          handleExpired();
          return;
        }

        const data = await res.json().catch(() => null);

        if (!res.ok || data?.data?.success === false) {
          const detail = data?.detail;

          const message =
            data?.error?.message ||
            data?.data?.message ||
            (typeof detail === "string"
              ? detail
              : detail?.message ||
                detail?.error?.message ||
                (detail ? JSON.stringify(detail) : null)) ||
            data?.message ||
            "시나리오 실행에 실패했습니다.";

          console.error("시나리오 실행 실패:", {
            path,
            status: res.status,
            response: data,
          });

          alert(message);
          return;
        }

        if (!isEndScenario) {
          await fetchDevices();
        }
      } catch (e) {
        console.error("시나리오 실행 오류:", e);

        alert(
          isEndScenario
            ? "종료 요청 중 서버 연결에 실패했습니다. 실제 기기와 예약 상태를 다시 확인해 주세요."
            : "서버 연결에 실패했습니다. 시나리오 실행 결과를 확인해 주세요."
        );
      } finally {
        if (isEndScenario) {
          await Promise.all([
            fetchDevices(),
            fetchReservations(),
          ]);
        }
      }
    },
    [fetchDevices, fetchReservations, handleExpired]
  );

  /**
   * [대신 입력] — 학생 대신 부스 키패드에 PIN을 넣는다.
   */
  const handleRemoteEntry = useCallback(
    async (pin: string) => {
      try {
        const res = await fetch(apiUrl("/api/booth/verify-keypad"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin }),
        });

        const data = await res.json().catch(() => null);

        fetchDevices();
        fetchReservations();

        return {
          success: res.ok,
          mode: data?.data?.mode,
          message: data?.data?.message || data?.error?.message,
        };
      } catch {
        return {
          success: false,
          message: "서버 연결에 실패했습니다.",
        };
      }
    },
    [fetchDevices, fetchReservations]
  );

  return (
    <div className="theme-day min-h-screen bg-canvas text-ink">
      <AppHeader
        title="관리자 운영 화면"
        subtitle="기기 제어 · 시나리오 실행 · 예약 관리 (선생님 전용)"
        devices={devices}
        isConnected={isConnected}
        actions={
          <div className="flex items-center gap-2">
            <Link
              href="/booth"
              className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-raised hover:bg-line-strong/90 border border-line-strong text-xs font-bold text-ink-2 transition-colors"
            >
              <Monitor className="w-3.5 h-3.5" />
              부스 화면
            </Link>

            <Link
              href="/"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-raised hover:bg-line-strong/90 border border-line-strong text-xs font-bold text-ink-2 transition-colors"
            >
              <Home className="w-3.5 h-3.5" />
              예약 화면
            </Link>

            {adminAuthed && (
              <button
                type="button"
                onClick={handleExtendSession}
                disabled={isExtending}
                title="관리자 세션을 1시간 연장합니다."
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-raised hover:bg-line-strong/90 border border-line-strong text-xs font-bold text-ink-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 ${
                    isExtending ? "animate-spin" : ""
                  }`}
                />
                {isExtending
                  ? "연장 중..."
                  : `세션 연장 ${formatRemainingTime(remainingSeconds)}`}
              </button>
            )}
          </div>
        }
      />

      <main className="max-w-7xl mx-auto px-4 lg:px-8 py-6 space-y-6">
        <AdminGate isAuthed={adminAuthed} />

        {adminAuthed && (
          <>
            <OpsSummary
              devices={devices}
              reservations={reservations}
              isConnected={isConnected}
            />

            <CctvPanel />

            <SchedulerPanel />

            <AnthemRankingPanel />

            <VirtualBoothSimulator
              devices={devices}
              onDeviceControl={handleDeviceControl}
              onSimulateEntry={() =>
                runScenario("/api/booth/simulate-entry")
              }
              onSimulateWarning={() =>
                runScenario("/api/booth/simulate-10min-warning")
              }
              onSimulateEnd={() =>
                runScenario("/api/booth/simulate-end")
              }
              lastEventMessage={lastEventMsg}
              isAdmin={adminAuthed}
            />

            <ReservationSection
              reservations={reservations}
              onReservationCreated={fetchReservations}
              onRemoteEntry={handleRemoteEntry}
              sections="list"
            />

            <VideoCheckPanel />

            <SongHistorySection
              allSongs={allSongs}
              favoriteSongs={favoriteSongs}
            />
          </>
        )}
      </main>

      <footer className="max-w-7xl mx-auto px-4 lg:px-8 py-8 mt-12 border-t border-line text-center text-xs text-ink-3 space-y-1">
        <p>
          관리자 운영 화면 · 전시 전에 backend/.env 의 ADMIN_PIN 을 바꾸고
          ALLOW_TEST_PIN 을 false 로 두세요
        </p>
      </footer>
    </div>
  );
}
  