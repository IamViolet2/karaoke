"use client";

import React, { useEffect, useState } from "react";
import { KaraokeRoomSection } from "@/components/booth/KaraokeRoomSection";
import { BoothAudio } from "@/components/booth/BoothAudio";
import { useBoothData } from "@/hooks/useBoothData";
import { useBoothSession } from "@/hooks/useBoothSession";

/**
 * /booth — 부스 안 노래방 전용 키오스크 화면.
 * PIN 인증은 /door에서 처리한다. 이 화면은 일반 사용자 인증 이벤트와
 * 실제 도어락 열림(current_state)을 모두 확인하기 전까지 완전히 검정색이다.
 */
export default function BoothPage() {
  const {
    devices,
    topToday,
    topAll,
    anthemTop,
    announcement,
    authNotice,
    fetchSongs,
    fetchScores,
  } = useBoothData();

  const [normalUserAuthorized, setNormalUserAuthorized] = useState(false);
  const [doorWasOpenedForUser, setDoorWasOpenedForUser] = useState(false);

  const doorLockState = devices.find((device) => device.id === "door_lock_1")?.current_state;
  const isDoorUnlocked = doorLockState === "unlocked";
  const isPowerOn = devices.find((device) => device.id === "relay_1")?.current_state === "on";

  // booth_auth는 PIN 자체의 검증 결과일 뿐이다.
  // 일반 사용자 인증만 허용하고 관리자 인증은 기존 사용자 인증을 무효화한다.
  useEffect(() => {
    if (!authNotice) return;

    if (authNotice.mode === "admin") {
      setNormalUserAuthorized(false);
      setDoorWasOpenedForUser(false);
      return;
    }

    if (authNotice.success && authNotice.mode === "user") {
      setNormalUserAuthorized(true);
    }
  }, [authNotice]);

  // current_state가 실제 하드웨어에서 보고된 도어락 상태다.
  // desired_state나 relay_1, booth_auth 성공만으로는 화면을 열지 않는다.
  useEffect(() => {
    if (normalUserAuthorized && isDoorUnlocked) {
      setDoorWasOpenedForUser(true);
      return;
    }

    // 일반 사용자 입장으로 문이 열린 뒤 다시 잠기면 다음 입장을 위해 인증을 초기화한다.
    if (doorWasOpenedForUser && !isDoorUnlocked) {
      setDoorWasOpenedForUser(false);
      setNormalUserAuthorized(false);
    }
  }, [normalUserAuthorized, isDoorUnlocked, doorWasOpenedForUser]);

  const canShowKaraoke =
    normalUserAuthorized && doorWasOpenedForUser && isDoorUnlocked;
  const session = useBoothSession(isPowerOn);

  return (
    <div className="fixed inset-0 min-h-screen overflow-hidden bg-black">
      {canShowKaraoke && (
        <main className="min-h-screen">
          <KaraokeRoomSection
            externalEntryMode
            devices={devices}
            onSongCompleted={fetchSongs}
            topToday={topToday}
            topAll={topAll}
            anthemTop={anthemTop}
            onScoreRecorded={fetchScores}
            session={session}
          />
        </main>
      )}

      {/* 안내 음성은 화면이 검정색인 동안에도 부스 스피커에서 동작한다. */}
      <BoothAudio announcement={announcement} />
    </div>
  );
}
