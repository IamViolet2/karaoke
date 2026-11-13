
"use client";

import React, { useEffect, useRef, useState } from "react";

import {
  Lock,
  Unlock,
  Power,
  Lightbulb,
  LightbulbOff,
  Volume2,
  VolumeX,
  UserCheck,
  AlertTriangle,
  PlayCircle,
  Sparkles,
  Music,
  Music2,
  Radio,
  Play,
  Pause,
  SlidersHorizontal,
  Fan,
} from "lucide-react";
import { Device } from "@/types";

interface VirtualBoothSimulatorProps {
  devices: Device[];
  onDeviceControl: (
    deviceId: string,
    state: string,
    value?: unknown
  ) => Promise<void>;
  onSimulateEntry: () => Promise<void>;
  onSimulateWarning: () => Promise<void>;
  onSimulateEnd: () => Promise<void>;
  lastEventMessage?: string;
  /** 관리자 인증 여부 — false면 기기 제어·시나리오 강제 실행을 막는다 */
  isAdmin?: boolean;
}

/**
 * 부스 기기 관제 (선생님 화면 /admin)
 *
 * 제어 장치:
 * - door_lock_1: 솔레노이드 도어락
 * - relay_1: 노래방 반주기 및 앰프 전원
 * - led_1: 부스 조명 (on / off / blink / playing)
 * - speaker_1: 안내 스피커
 * - fan_1: 부스 선풍기 (GPIO 18, HIGH=ON)
 *
 * 센서:
 * - pir_1: 입장 감지 센서
 *
 * 실제 GPIO 제어는 Raspberry Pi의 main.py가 담당한다.
 * 이 화면은 백엔드에 desired_state를 전달하고
 * Raspberry Pi가 보고한 current_state를 표시한다.
 */
export function VirtualBoothSimulator({
  devices,
  onDeviceControl,
  onSimulateEntry,
  onSimulateWarning,
  onSimulateEnd,
  lastEventMessage,
  isAdmin = false,
}: VirtualBoothSimulatorProps) {
  // ---------------------------------------------------------------------------
  // 장치 조회
  // ---------------------------------------------------------------------------

  const devMap = devices.reduce<Record<string, Device>>((acc, d) => {
    acc[d.id] = d;
    return acc;
  }, {});

  const doorLock = devMap["door_lock_1"] || { current_state: "locked" };
  const relay = devMap["relay_1"] || { current_state: "off" };
  const led = devMap["led_1"] || { current_state: "off" };
  const speaker = devMap["speaker_1"] || { current_state: "idle" };
  const pir = devMap["pir_1"] || { current_state: "standby" };
  const fan = devMap["fan_1"] || { current_state: "off" };

  const isDoorUnlocked =
    doorLock.current_state === "unlocked" ||
    doorLock.current_state === "open";

  const isPowerOn = relay.current_state === "on";

  // LED 4가지 상태
  const ledStatus = String(led.current_state ?? "off");

  const isLedOn = ledStatus === "on";
  const isLedBlink = ledStatus === "blink";
  const isLedPlaying = ledStatus === "playing";
  const isLedOff = ledStatus === "off";

  const isSpeakerPlaying = speaker.current_state === "playing";
  const isPersonDetected = pir.current_state === "detected";
  const isFanOn = fan.current_state === "on";

  // ---------------------------------------------------------------------------
  // 시나리오 중복 실행 방지
  // ---------------------------------------------------------------------------

  const [isEnding, setIsEnding] = useState(false);

  const handleSimulateEnd = async () => {
    if (!isAdmin || isEnding) return;

    setIsEnding(true);

    try {
      await onSimulateEnd();
    } catch (error) {
      console.error("이용 종료 시나리오 실행 오류:", error);
    } finally {
      setIsEnding(false);
    }
  };

  // ---------------------------------------------------------------------------
  // 퇴실곡 미리 듣기
  // ---------------------------------------------------------------------------

  const closingAudioRef = useRef<HTMLAudioElement | null>(null);

  const [isPlayingClosingAudio, setIsPlayingClosingAudio] =
    useState<boolean>(false);

  useEffect(() => {
    const audio = new Audio("/audio/closing_song.wav");

    audio.volume = 0.85;

    audio.onplay = () => setIsPlayingClosingAudio(true);
    audio.onpause = () => setIsPlayingClosingAudio(false);
    audio.onended = () => setIsPlayingClosingAudio(false);

    closingAudioRef.current = audio;

    return () => {
      audio.pause();
      closingAudioRef.current = null;
    };
  }, []);

  const toggleClosingSong = () => {
    const audio = closingAudioRef.current;

    if (!audio) return;

    if (isPlayingClosingAudio) {
      audio.pause();
      return;
    }

    audio.currentTime = 0;

    audio.play().catch((err) =>
      console.warn("퇴실곡 미리 듣기 실패:", err)
    );
  };

  // ---------------------------------------------------------------------------
  // 선풍기 제어
  // ---------------------------------------------------------------------------

  const [isFanControlling, setIsFanControlling] = useState(false);

  const handleFanToggle = async () => {
    if (!isAdmin || isFanControlling) return;

    setIsFanControlling(true);

    try {
      await onDeviceControl(
        "fan_1",
        isFanOn ? "off" : "on"
      );
    } catch (error) {
      console.error("선풍기 제어 오류:", error);
    } finally {
      setIsFanControlling(false);
    }
  };

  // ---------------------------------------------------------------------------
  // LED 상태 제어
  // ---------------------------------------------------------------------------

  const ledModes = [
    {
      value: "on",
      label: "켜짐",
      icon: Lightbulb,
      activeClass:
        "bg-brass-soft/30 border-brass/50 text-brass",
    },
    {
      value: "off",
      label: "꺼짐",
      icon: LightbulbOff,
      activeClass:
        "bg-raised border-line-strong text-ink",
    },
    {
      value: "blink",
      label: "깜빡임",
      icon: Radio,
      activeClass:
        "bg-live-soft/30 border-live/50 text-live",
    },
    {
      value: "playing",
      label: "노래 중",
      icon: Music2,
      activeClass:
        "bg-free-soft/30 border-free/50 text-free",
    },
  ] as const;

  const handleLedControl = async (state: string) => {
    if (!isAdmin || ledStatus === state) return;

    try {
      await onDeviceControl("led_1", state);
    } catch (error) {
      console.error("LED 제어 오류:", error);
    }
  };

  // ---------------------------------------------------------------------------
  // 화면
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-6">
      {/* 상단 이벤트 알림 */}
      {lastEventMessage && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-surface border border-line text-ink-2 text-sm">
          <Sparkles
            className="w-4 h-4 text-ink-3 shrink-0"
            aria-hidden
          />
          <span>{lastEventMessage}</span>
        </div>
      )}

      {/* 왼쪽: 부스 상태 · 오른쪽: 시나리오 및 직접 제어 */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* ----------------------------------------------------------------- */}
        {/* 왼쪽: 가상 부스 상태 */}
        {/* ----------------------------------------------------------------- */}

        <div className="lg:col-span-7 bg-surface/90 border border-line rounded-2xl p-6 shadow-xl space-y-6">
          <div className="flex items-center justify-between border-b border-line pb-4">
            <div>
              <h3 className="text-lg font-bold text-ink flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-free animate-pulse" />
                가상 노래방 부스 실시간 물리 상태
              </h3>

              <p className="text-xs text-ink-3 mt-0.5">
                액추에이터 5종과 센서의 현재 상태입니다.
                Mock 모드에서는 명령에 따라 상태가 바로 바뀌고,
                Raspberry Pi 연결 시 보고된 실제 상태가 표시됩니다.
              </p>
            </div>
          </div>

          {/* 부스 시각화 */}
          <div
            className={`relative w-full h-64 rounded-xl border-2 transition-all duration-500 flex flex-col justify-between p-6 overflow-hidden ${
              isPowerOn
                ? "bg-canvas border-free/50 shadow-2xl"
                : "bg-canvas/60 border-line"
            }`}
          >
            {/* 천장 조명 */}
            <div className="flex justify-center">
              <div
                className={`px-8 py-1.5 rounded-full text-xs font-semibold flex items-center gap-2 transition-all duration-300 ${
                  isLedBlink
                    ? "bg-live text-on-accent animate-pulse shadow-lg"
                    : isLedPlaying
                    ? "bg-free text-on-accent shadow-lg animate-pulse"
                    : isLedOn
                    ? "bg-brass text-on-accent shadow-md"
                    : "bg-raised text-ink-3"
                }`}
              >
                {isLedBlink ? (
                  <Radio className="w-4 h-4 animate-pulse" />
                ) : isLedPlaying ? (
                  <Music2 className="w-4 h-4 animate-bounce" />
                ) : isLedOn ? (
                  <Lightbulb className="w-4 h-4" />
                ) : (
                  <LightbulbOff className="w-4 h-4" />
                )}

                <span>
                  부스 조명 LED:{" "}
                  {isLedBlink
                    ? "깜빡임 (BLINK)"
                    : isLedPlaying
                    ? "노래 중 (playing)"
                    : isLedOn
                    ? "점등 (ON)"
                    : "소등 (OFF)"}
                </span>
              </div>
            </div>

            {/* 중앙 장치 */}
            <div className="flex items-center justify-between px-4">
              {/* 노래방 반주기 */}
              <div
                className={`w-40 h-28 rounded-lg border flex flex-col items-center justify-center p-3 text-center transition-all duration-500 ${
                  isPowerOn
                    ? "bg-raised border-brass text-ink shadow-lg"
                    : "bg-surface border-line text-ink-3"
                }`}
              >
                <Power
                  className={`w-6 h-6 mb-1 ${
                    isPowerOn
                      ? "text-free animate-pulse"
                      : "text-ink-3"
                  }`}
                />

                <span className="text-xs font-bold">
                  노래방 반주기 & 앰프
                </span>

                <span className="text-[10px] text-ink-3 mt-0.5">
                  릴레이 전원:{" "}
                  {isPowerOn ? "ON (공급 중)" : "OFF (차단됨)"}
                </span>
              </div>

              {/* 도어락 */}
              <div
                className={`flex flex-col items-center justify-center w-36 h-28 rounded-lg border transition-all duration-300 ${
                  isDoorUnlocked
                    ? "bg-free-soft/40 border-free/60 text-free"
                    : "bg-live-soft/40 border-live/60 text-live"
                }`}
              >
                {isDoorUnlocked ? (
                  <Unlock className="w-8 h-8 text-free mb-1 animate-bounce" />
                ) : (
                  <Lock className="w-8 h-8 text-live mb-1" />
                )}

                <span className="text-xs font-bold">
                  솔레노이드 도어락
                </span>

                <span className="text-[10px] mt-0.5 font-mono">
                  {isDoorUnlocked
                    ? "UNLOCKED (개방)"
                    : "LOCKED (잠김)"}
                </span>
              </div>

              {/* 스피커 */}
              <div
                className={`w-36 h-28 rounded-lg border flex flex-col items-center justify-center p-2 text-center transition-all duration-300 ${
                  isSpeakerPlaying || isPlayingClosingAudio
                    ? "bg-brass-soft/40 border-brass/60 text-brass animate-pulse"
                    : "bg-surface border-line text-ink-3"
                }`}
              >
                {isSpeakerPlaying || isPlayingClosingAudio ? (
                  <Volume2 className="w-7 h-7 text-brass mb-1 animate-bounce" />
                ) : (
                  <VolumeX className="w-7 h-7 text-ink-3 mb-1" />
                )}

                <span className="text-xs font-bold">
                  안내 스피커
                </span>

                <span className="text-[10px] text-ink-3 truncate max-w-[120px]">
                  {isPlayingClosingAudio
                    ? "퇴실곡 미리 듣는 중"
                    : isSpeakerPlaying
                    ? speaker.desired_value &&
                      typeof speaker.desired_value === "object" &&
                      "track" in speaker.desired_value
                      ? String(
                          (
                            speaker.desired_value as Record<
                              string,
                              unknown
                            >
                          ).track
                        )
                      : "음성 안내 중"
                    : "대기 중 (IDLE)"}
                </span>
              </div>
            </div>

            {/* 하단 센서 및 선풍기 상태 */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line/80 pt-2 text-xs">
              <div className="flex items-center gap-2">
                <span
                  className={`w-2 h-2 rounded-full ${
                    isPersonDetected
                      ? "bg-free animate-ping"
                      : "bg-line-strong"
                  }`}
                />

                <span className="text-ink-3">
                  입장 감지 센서 (PIR):{" "}
                  <strong
                    className={
                      isPersonDetected
                        ? "text-free"
                        : "text-ink-3"
                    }
                  >
                    {isPersonDetected
                      ? "사람 입장 감지됨"
                      : "대기 중"}
                  </strong>
                </span>
              </div>

              {/* 선풍기 상태 표시 */}
              <div
                className={`flex items-center gap-1.5 ${
                  isFanOn ? "text-free" : "text-ink-3"
                }`}
              >
                <Fan
                  className={`w-3.5 h-3.5 ${
                    isFanOn ? "animate-spin" : ""
                  }`}
                />

                <span>
                  선풍기:{" "}
                  <strong>
                    {isFanOn ? "작동 중 (ON)" : "정지 (OFF)"}
                  </strong>
                </span>
              </div>

              <button
                onClick={() => void onSimulateEntry()}
                disabled={!isAdmin || isEnding}
                className="px-3 py-1 rounded bg-raised hover:bg-line-strong/90 text-ink-2 border border-line-strong text-[11px] transition-colors flex items-center gap-1.5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <UserCheck className="w-3.5 h-3.5 text-free" />
                입장 감지 테스트
              </button>
            </div>
          </div>
        </div>

        {/* ----------------------------------------------------------------- */}
        {/* 오른쪽: 시나리오 및 기기 제어 */}
        {/* ----------------------------------------------------------------- */}

        <div className="lg:col-span-5 bg-surface/90 border border-line rounded-2xl p-6 shadow-xl space-y-5">
          <h3 className="text-base font-bold text-ink flex items-center gap-2 border-b border-line pb-3">
            <SlidersHorizontal className="w-4 h-4 text-brass" />
            시나리오 실행 · 직접 제어
          </h3>

          {/* 자동화 시나리오 */}
          <div className="space-y-2 pt-2">
            <h4 className="text-xs font-semibold text-ink-3">
              자동화 시나리오 강제 실행 (소리는 부스 화면에서 납니다)
            </h4>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                onClick={() => void onSimulateWarning()}
                disabled={!isAdmin || isEnding}
                className="px-3 py-2 rounded-lg bg-raised/80 hover:bg-raised/90 border border-line-strong text-xs font-medium text-brass flex items-center justify-center gap-2 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <AlertTriangle className="w-4 h-4 text-brass" />
                종료 10분 전 (LED 깜빡임)
              </button>

              <button
                onClick={() => void handleSimulateEnd()}
                disabled={!isAdmin || isEnding}
                aria-busy={isEnding}
                className="px-3 py-2 rounded-lg bg-raised/80 hover:bg-raised/90 border border-line-strong text-xs font-medium text-live flex items-center justify-center gap-2 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <PlayCircle className="w-4 h-4 text-live" />
                {isEnding
                  ? "이용 종료 처리 중..."
                  : "이용 종료 (퇴실곡+전원차단)"}
              </button>
            </div>
          </div>

          {/* 퇴실곡 미리 듣기 */}
          <div className="p-3.5 rounded-xl bg-canvas/80 border border-brass/30 flex items-center justify-between gap-3 shadow-inner">
            <div className="flex items-center gap-3 min-w-0">
              <div
                className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                  isPlayingClosingAudio
                    ? "bg-brass/20 text-brass animate-pulse"
                    : "bg-raised text-ink-3"
                }`}
              >
                <Music className="w-5 h-5" />
              </div>

              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-ink-2 truncate">
                    더윈드(The Wind) - 다시 만나
                  </span>

                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-brass/20 text-brass font-mono">
                    퇴실곡 (0:58~)
                  </span>
                </div>

                <p className="text-[11px] text-ink-3 truncate">
                  {isPlayingClosingAudio
                    ? "이 노트북에서 미리 듣는 중"
                    : "이용이 끝나면 부스 화면이 안내 후 틀어 줍니다"}
                </p>
              </div>
            </div>

            <button
              onClick={toggleClosingSong}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 shrink-0 transition-all cursor-pointer ${
                isPlayingClosingAudio
                  ? "bg-brass hover:bg-brass/90 text-on-accent shadow-md"
                  : "bg-raised hover:bg-line-strong/90 text-brass border border-brass/30"
              }`}
            >
              {isPlayingClosingAudio ? (
                <>
                  <Pause className="w-3.5 h-3.5" />
                  정지
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5 fill-current" />
                  미리 듣기
                </>
              )}
            </button>
          </div>

          {/* ----------------------------------------------------------------- */}
          {/* 수동 장치 제어 */}
          {/* ----------------------------------------------------------------- */}

          <div className="grid grid-cols-2 gap-3 pt-2">
            {/* 도어락 */}
            <button
              onClick={() =>
                onDeviceControl(
                  "door_lock_1",
                  isDoorUnlocked ? "locked" : "unlocked"
                )
              }
              disabled={!isAdmin}
              className={`p-3 rounded-xl border text-xs font-medium flex flex-col items-center gap-1.5 transition-all cursor-pointer ${
                isDoorUnlocked
                  ? "bg-free-soft/30 border-free/50 text-free"
                  : "bg-raised/50 border-line-strong text-ink-3 hover:text-ink"
              } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              {isDoorUnlocked ? (
                <Unlock className="w-4 h-4" />
              ) : (
                <Lock className="w-4 h-4" />
              )}

              도어락 {isDoorUnlocked ? "수동 잠금" : "수동 해제"}
            </button>

            {/* 반주기 전원 */}
            <button
              onClick={() =>
                onDeviceControl(
                  "relay_1",
                  isPowerOn ? "off" : "on"
                )
              }
              disabled={!isAdmin}
              className={`p-3 rounded-xl border text-xs font-medium flex flex-col items-center gap-1.5 transition-all cursor-pointer ${
                isPowerOn
                  ? "bg-brass-soft/30 border-brass/50 text-brass"
                  : "bg-raised/50 border-line-strong text-ink-3 hover:text-ink"
              } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              <Power className="w-4 h-4" />

              릴레이 전원 {isPowerOn ? "끄기" : "켜기"}
            </button>

            {/* LED 4가지 상태 선택 */}
            <div className="col-span-2 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-ink-2">
                  부스 조명 LED
                </span>

                <span className="text-[10px] text-ink-3">
                  현재:{" "}
                  {isLedOn
                    ? "켜짐"
                    : isLedOff
                    ? "꺼짐"
                    : isLedBlink
                    ? "깜빡임"
                    : isLedPlaying
                    ? "노래 중"
                    : ledStatus}
                </span>
              </div>

              <div className="grid grid-cols-4 gap-2">
                {ledModes.map(({ value, label, icon: Icon, activeClass }) => {
                  const isActive = ledStatus === value;

                  return (
                    <button
                      key={value}
                      onClick={() => void handleLedControl(value)}
                      disabled={!isAdmin}
                      aria-pressed={isActive}
                      className={`min-w-0 p-3 rounded-xl border text-xs font-medium flex flex-col items-center justify-center gap-1.5 transition-all cursor-pointer ${
                        isActive
                          ? activeClass
                          : "bg-raised/50 border-line-strong text-ink-3 hover:text-ink hover:border-line"
                      } disabled:opacity-50 disabled:cursor-not-allowed`}
                    >
                      <Icon
                        className={`w-4 h-4 ${
                          isActive && value === "blink"
                            ? "animate-pulse"
                            : isActive && value === "playing"
                            ? "animate-bounce"
                            : ""
                        }`}
                      />

                      <span className="whitespace-nowrap">
                        {label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 스피커 */}
            <button
              onClick={() =>
                onDeviceControl("speaker_1", "playing", {
                  message:
                    "부스 스피커 테스트입니다. 소리가 잘 들리나요?",
                })
              }
              title="부스 화면(/booth)이 이 문장을 읽습니다 — 부스 스피커 점검용"
              disabled={!isAdmin}
              className="p-3 rounded-xl border text-xs font-medium flex flex-col items-center gap-1.5 transition-all cursor-pointer bg-raised/50 border-line-strong text-ink-3 hover:text-ink disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Volume2 className="w-4 h-4" />
              스피커 테스트
            </button>

            {/* 선풍기 */}
            <button
              onClick={handleFanToggle}
              disabled={!isAdmin || isFanControlling}
              className={`p-3 rounded-xl border text-xs font-medium flex flex-row items-center justify-center gap-2 transition-all cursor-pointer ${
                isFanOn
                  ? "bg-free-soft/30 border-free/50 text-free"
                  : "bg-raised/50 border-line-strong text-ink-3 hover:text-ink"
              } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              <Fan
                className={`w-4 h-4 ${
                  isFanOn && !isFanControlling
                    ? "animate-spin"
                    : ""
                }`}
              />

              {isFanControlling
                ? "선풍기 명령 전달 중..."
                : `부스 선풍기 ${isFanOn ? "끄기 (ON)" : "켜기 (OFF)"}`}
            </button>
          </div>

          <p className="text-[11px] text-ink-3 leading-relaxed border-t border-line/80 pt-3">
            비밀번호 키패드와 안내 음성·퇴실곡은{" "}
            <strong className="text-ink-2">부스 화면(/booth)</strong>에
            있습니다. 예약 목록의 [대신 입력]으로 학생 대신 인증할 수도 있습니다.
          </p>
        </div>
      </div>
    </div>
  );
}
