
"use client";

import React from "react";
import { KaraokeRoomSection } from "@/components/booth/KaraokeRoomSection";
import { BoothAudio } from "@/components/booth/BoothAudio";
import { useBoothData } from "@/hooks/useBoothData";
import { useBoothSession } from "@/hooks/useBoothSession";

/**
 * `/booth` — 부스 대형 화면
 *
 * 이 화면은 부스 안 모니터에 계속 띄워 두는 키오스크 화면이다.
 *   - 상단 헤더, 탭, 다른 화면으로 가는 링크를 두지 않는다.
 *   - 이용자가 실수로 다른 화면으로 빠져나가지 않도록 한다.
 *
 * 관리자가 이 화면으로 오고 싶을 때는 `/admin`의 [부스 화면] 버튼을 쓴다.
 *
 * 화면은 부스 전원(relay_1)을 따라 바뀐다.
 *   대기(전원 꺼짐) → 키패드 비밀번호 인증 · 순위
 *   준비(인증됨)    → 환영 인사 · [노래방 시작하기]
 *   노래방          → 반주·채점 · 이용 시간 안내
 *
 * 안내 음성과 퇴실곡도 이 화면이 낸다 (BoothAudio).
 */
export default function BoothPage() {
  const {
    devices,
    isConnected,
    topToday,
    topAll,
    anthemTop,
    announcement,
    authNotice,
    fetchDevices,
    fetchSongs,
    fetchScores,
  } = useBoothData();

  const isPowerOn =
    devices.find((d) => d.id === "relay_1")?.current_state === "on";

  const session = useBoothSession(isPowerOn);

  return (
    <div className="theme-stage min-h-screen bg-canvas text-ink">
      <main className="max-w-7xl mx-auto px-4 lg:px-8 py-6">
        <KaraokeRoomSection
          devices={devices}
          onSongCompleted={fetchSongs}
          topToday={topToday}
          topAll={topAll}
          anthemTop={anthemTop}
          onScoreRecorded={fetchScores}
          session={session}
          authNotice={authNotice}
          onKeypadVerified={fetchDevices}
        />
      </main>

      <BoothAudio announcement={announcement} />

      {/*
        부스 화면에는 헤더가 없어서, 백엔드와 끊긴 것을 알아챌 방법이 없다.
        노래를 방해하지 않도록 구석에 점 하나로만 표시한다.
      */}
      <div
        className="fixed bottom-3 right-3 flex items-center gap-1.5 px-2 py-1 rounded-full
                   bg-surface/70 border border-line text-[10px] font-mono text-ink-3
                   pointer-events-none select-none"
        aria-live="polite"
      >
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            isConnected ? "bg-free" : "bg-live"
          }`}
        />
        {isConnected ? "연결됨" : "서버 끊김"}
      </div>
    </div>
  );
}
