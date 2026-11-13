"use client";

import React, { useEffect, useState } from "react";
import { DoorOpen, LockKeyhole, ShieldCheck } from "lucide-react";
import { BoothKeypad } from "@/components/booth/BoothKeypad";
import { useBoothData } from "@/hooks/useBoothData";

/** /door — PIN 인증 및 실제 도어락 상태 확인 전용 화면 */
export default function DoorPage() {
  const { devices, authNotice, fetchDevices } = useBoothData();
  const [authMode, setAuthMode] = useState<string | null>(null);

  const doorState = devices.find((device) => device.id === "door_lock_1")?.current_state;
  const isUnlocked = doorState === "unlocked";

  // 실물 키패드 인증도 화면에 반영한다.
  useEffect(() => {
    if (!authNotice) return;
    if (authNotice.success) setAuthMode(authNotice.mode ?? "user");
    else setAuthMode(null);
  }, [authNotice]);

  const handleAuthSuccess = (mode?: string) => {
    setAuthMode(mode ?? "user");
    // 인증 성공 직후 한 번 더 상태를 조회한다.
    void fetchDevices();
  };

  return (
    <main className="theme-day min-h-screen bg-[#080B12] px-4 py-10 text-white">
      <div className="mx-auto flex min-h-[calc(100vh-5rem)] w-full max-w-md flex-col justify-center">
        <header className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.06]">
            <LockKeyhole className="h-8 w-8 text-slate-200" />
          </div>
          <p className="text-[10px] font-bold tracking-[0.35em] text-slate-400">
            SCHOOL KARAOKE BOOTH
          </p>
          <h1 className="mt-2 text-3xl font-black tracking-tight">출입 인증</h1>
          <p className="mt-2 text-sm text-slate-400">
            예약 또는 안내받은 4자리 PIN을 입력해 주세요.
          </p>
        </header>

        <section className="rounded-3xl border border-white/10 bg-[#111624] p-6 shadow-2xl shadow-black/40">
          <BoothKeypad
            notice={authNotice}
            onVerified={fetchDevices}
            onAuthSuccess={handleAuthSuccess}
          />

          <div className="mt-6 rounded-2xl border border-white/10 bg-black/20 px-4 py-3">
            <div className="flex items-center gap-2">
              {isUnlocked ? (
                <DoorOpen className="h-4 w-4 text-emerald-400" />
              ) : (
                <LockKeyhole className="h-4 w-4 text-slate-400" />
              )}
              <span className="text-xs font-semibold text-slate-200">
                {isUnlocked ? "도어락 열림 확인" : "도어락 잠김"}
              </span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-slate-400">
              {isUnlocked
                ? authMode === "admin"
                  ? "관리자 출입이 확인되었습니다. 노래방 화면은 검정색으로 유지됩니다."
                  : "문이 실제로 열린 것이 확인되었습니다. 입장해 주세요."
                : authMode
                  ? "PIN 인증은 완료되었습니다. 실제 도어락 열림 신호를 기다리는 중입니다."
                  : "PIN 인증 후 실제 도어락 상태가 확인되면 이곳에 표시됩니다."}
            </p>
          </div>

          <div className="mt-4 flex items-center justify-center gap-2 text-[10px] text-slate-500">
            <ShieldCheck className="h-3.5 w-3.5" />
            <span>인증은 서버에서 처리되며 PIN은 화면에 저장되지 않습니다.</span>
          </div>
        </section>
      </div>
    </main>
  );
}
