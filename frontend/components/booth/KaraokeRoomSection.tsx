
"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Music,
  Mic,
  MicOff,
  Play,
  Pause,
  Trophy,
  Search,
  Tv,
  SlidersHorizontal,
  AlertTriangle,
  CheckCircle2,
  HardDrive,
  Radio,
  ShieldCheck,
  Loader2,
} from "lucide-react";

import {
  KaraokeAudioScorer,
  AudioAnalysisResult,
  FinalScore,
} from "@/utils/audioScorer";
import { KaraokeAccompanimentEngine } from "@/utils/karaokeAccompaniment";
import {
  createYouTubePlayer,
  YouTubePlayerHandle,
  YT_STATE,
} from "@/utils/youtubePlayer";
import {
  resolveMedia,
  loadVideoOverrides,
  hasNextAttempt,
  ResolvedMedia,
} from "@/utils/karaokeMedia";
import {
  KARAOKE_SONGS,
  KaraokeSong,
  isSchoolAnthem,
} from "@/data/karaokeSongs";

import { SessionStrip } from "./SessionStrip";
import { BoothKeypad } from "./BoothKeypad";
import type { BoothAuthNotice } from "@/hooks/useBoothData";
import type { BoothSessionState } from "@/hooks/useBoothSession";
import { Device, ScoreRecord } from "@/types";
import { apiUrl } from "@/utils/apiConfig";

type YoutubeTestStatus = "untested" | "testing" | "success" | "failed";

// ----------------------------------------------------------------------
// 대기 / 인증 화면
// 키패드 화면은 기존의 차분한 분위기를 유지한다.
// ----------------------------------------------------------------------

interface AttractScreenProps {
  authenticated: boolean;
  isPowerOn: boolean;
  onEnter: () => void;
  enterNotice: string | null;
  children?: React.ReactNode;
}

const AttractScreen = ({
  authenticated,
  isPowerOn,
  onEnter,
  enterNotice,
  children,
}: AttractScreenProps) => (
  <div className="min-h-[calc(100vh-3rem)] flex items-center justify-center px-4 py-10 bg-canvas">
    <div className="w-full max-w-md bg-surface border border-line rounded-2xl p-7 text-center space-y-5 shadow-xl">
      <div className="inline-flex p-3 rounded-full bg-raised text-ink-2">
        {authenticated ? (
          <ShieldCheck className="w-7 h-7" />
        ) : (
          <Tv className="w-7 h-7" />
        )}
      </div>

      <div className="space-y-2">
        <h2 className="text-xl font-bold text-ink">
          {authenticated ? "인증이 완료되었습니다" : "노래방 부스"}
        </h2>

        <p className="text-xs text-ink-3 leading-relaxed">
          {authenticated
            ? "노래방을 이용할 준비가 완료되었습니다."
            : "이용을 시작하려면 PIN 번호를 입력해 주세요."}
        </p>
      </div>

      {children}

      {authenticated && (
        <div className="space-y-4 pt-2">
          {enterNotice && (
            <p className="text-xs text-ink-2">{enterNotice}</p>
          )}

          {!isPowerOn && (
            <p className="text-xs text-ink-3">
              노래방 전원이 켜지면 시작할 수 있습니다.
            </p>
          )}

          <button
            onClick={onEnter}
            disabled={!isPowerOn}
            className="w-full px-6 py-3 rounded-xl bg-raised hover:bg-line-strong text-ink font-bold text-sm border border-line-strong transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            노래방 입장하기
          </button>
        </div>
      )}
    </div>
  </div>
);

// ----------------------------------------------------------------------
// Props
// ----------------------------------------------------------------------

interface KaraokeRoomSectionProps {
  devices?: Device[];
  onSongCompleted?: () => void;
  topToday?: ScoreRecord[];
  topAll?: ScoreRecord[];
  anthemTop?: ScoreRecord[];
  onScoreRecorded?: () => void;
  session?: BoothSessionState | null;
  authNotice?: BoothAuthNotice | null;
  onKeypadVerified?: () => void;
}

export function KaraokeRoomSection({
  devices = [],
  onSongCompleted,
  topToday = [],
  topAll = [],
  anthemTop = [],
  onScoreRecorded,
  session = null,
  authNotice = null,
  onKeypadVerified,
}: KaraokeRoomSectionProps) {
  const relayDevice = devices.find((d) => d.id === "relay_1");
  const isPowerOn = relayDevice?.current_state === "on";

  const ledBlink =
    devices.find((d) => d.id === "led_1")?.current_state === "blink";

  // ── 인증 & 입장 ──────────────────────────────────────────

  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [hasEntered, setHasEntered] = useState(false);
  const [isEntering, setIsEntering] = useState(false);
  const [nickname, setNickname] = useState("");
  const [enterNotice, setEnterNotice] = useState<string | null>(null);

  const lastAuthNoticeSeqRef = useRef(authNotice?.seq ?? 0);

  // 화면 키패드 요청 직후 도착하는 서버 방송은 해당 요청의 지연 응답일 수 있다.
  const lastScreenAuthAttemptRef = useRef(0);
  const SCREEN_AUTH_NOTICE_GUARD_MS = 30_000;

  const handleScreenAuthAttempt = useCallback(() => {
    lastScreenAuthAttemptRef.current = Date.now();
  }, []);

  // ── 선곡 & 재생 ──────────────────────────────────────────

  const [selectedSong, setSelectedSong] = useState<KaraokeSong>(
    KARAOKE_SONGS[0]
  );

  const [resolved, setResolved] = useState<{
    songId: string;
    media: ResolvedMedia;
  } | null>(null);

  const media =
    resolved?.songId === selectedSong.id ? resolved.media : null;

  const [isPlaying, setIsPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const [attemptIndex, setAttemptIndex] = useState(0);
  const [playerReady, setPlayerReady] = useState(false);

  const [youtubeTestStatus, setYoutubeTestStatus] = useState<
    Record<string, YoutubeTestStatus>
  >({});

  // ── 마이크 & 채점 ────────────────────────────────────────

  const [isMicActive, setIsMicActive] = useState(false);
  const [isVirtualMic, setIsVirtualMic] = useState(false);

  const [audioData, setAudioData] = useState<AudioAnalysisResult>({
    volume: 0,
    pitch: 0,
    note: "-",
    cents: 0,
  });

  const [mrVolume, setMrVolume] = useState(0.7);
  const [showScoreModal, setShowScoreModal] = useState(false);
  const [isCalculatingScore, setIsCalculatingScore] = useState(false);
  const [finalScore, setFinalScore] = useState<FinalScore | null>(null);
  const [animatedScore, setAnimatedScore] = useState(0);

  const [recordStatus, setRecordStatus] = useState<
    "excluded" | "saving" | "saved" | "failed" | null
  >(null);

  // ── refs ─────────────────────────────────────────────────

  const scorerRef = useRef<KaraokeAudioScorer | null>(null);
  const accompanimentRef = useRef<KaraokeAccompanimentEngine | null>(null);
  const ytHostRef = useRef<HTMLDivElement | null>(null);
  const ytHandleRef = useRef<YouTubePlayerHandle | null>(null);
  const localAudioRef = useRef<HTMLMediaElement | null>(null);

  const virtualTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const scoredRef = useRef(false);
  const usedVirtualRef = useRef(false);
  const finishAndScoreRef = useRef<(() => void) | null>(null);
  const selectedSongRef = useRef(selectedSong);
  const attemptIndexRef = useRef(attemptIndex);

  // ─────────────────────────────────────────────────────────
  // 엔진 초기화 / 정리
  // ─────────────────────────────────────────────────────────

  useEffect(() => {
    scorerRef.current = new KaraokeAudioScorer();
    accompanimentRef.current = new KaraokeAccompanimentEngine();

    return () => {
      scorerRef.current?.stopMicrophone();
      accompanimentRef.current?.dispose();
      ytHandleRef.current?.destroy();
      localAudioRef.current?.pause();

      if (virtualTimerRef.current) {
        clearInterval(virtualTimerRef.current);
      }

      if (tickTimerRef.current) {
        clearInterval(tickTimerRef.current);
      }
    };
  }, []);

  // ─────────────────────────────────────────────────────────
  // 물리 키패드 인증 결과 처리
  // 화면 키패드 요청 직후의 지연 서버 알림은 무시한다.
  // ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (!authNotice) return;
    if (authNotice.seq <= lastAuthNoticeSeqRef.current) return;

    lastAuthNoticeSeqRef.current = authNotice.seq;

    const elapsedSinceScreenAttempt =
      Date.now() - lastScreenAuthAttemptRef.current;

    if (elapsedSinceScreenAttempt < SCREEN_AUTH_NOTICE_GUARD_MS) {
      return;
    }

    if (!authNotice.success || authNotice.mode === "admin") {
      return;
    }

    setIsAuthenticated(true);
    setEnterNotice("물리 키패드 인증이 완료되었습니다.");
  }, [authNotice]);

  // ─────────────────────────────────────────────────────────
  // 화면 키패드 인증 성공 처리
  // ─────────────────────────────────────────────────────────

  const handleAuthSuccess = useCallback((mode?: string) => {
    if (mode === "admin") {
      setIsAuthenticated(false);
      setEnterNotice(
        "관리자 인증은 일반 사용자 입장과 별도로 처리됩니다."
      );
      return;
    }

    setIsAuthenticated(true);
    setEnterNotice(
      "인증이 완료되었습니다. 노래방을 시작할 수 있습니다."
    );
  }, []);

  // ─────────────────────────────────────────────────────────
  // 재생 소스 결정
  // ─────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    void loadVideoOverrides()
      .then(() => resolveMedia(selectedSong, attemptIndex))
      .then((m) => {
        if (!cancelled) {
          setResolved({
            songId: selectedSong.id,
            media: m,
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedSong, attemptIndex]);

  // ─────────────────────────────────────────────────────────
  // 모든 재생 중지
  // ─────────────────────────────────────────────────────────

  const stopAllPlayback = useCallback(() => {
    accompanimentRef.current?.stop();

    if (localAudioRef.current) {
      localAudioRef.current.pause();
    }

    ytHandleRef.current?.pause();

    if (tickTimerRef.current) {
      clearInterval(tickTimerRef.current);
      tickTimerRef.current = null;
    }

    setIsPlaying(false);
  }, []);

  // ─────────────────────────────────────────────────────────
  // DB 기록 및 채점
  // ─────────────────────────────────────────────────────────

  const recordSongToDB = useCallback(
    async (song: KaraokeSong): Promise<boolean> => {
      try {
        const res = await fetch(apiUrl("/api/songs"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: song.title,
            singer: song.singer,
          }),
        });

        onSongCompleted?.();
        return res.ok;
      } catch {
        return false;
      }
    },
    [onSongCompleted]
  );

  const recordScoreToDB = useCallback(
    async (song: KaraokeSong, result: FinalScore): Promise<boolean> => {
      try {
        const res = await fetch(apiUrl("/api/scores"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nickname: nickname.trim() || "익명",
            title: song.title,
            singer: song.singer,
            score: result.score,
            rank_label: result.rank,
            pitch: Math.round(result.breakdown.pitch),
            timing: Math.round(result.breakdown.timing),
            volume: Math.round(result.breakdown.volume),
            expression: Math.round(result.breakdown.expression),
          }),
        });

        onScoreRecorded?.();
        return res.ok;
      } catch {
        return false;
      }
    },
    [nickname, onScoreRecorded]
  );

  const finishAndScore = useCallback(() => {
    if (scoredRef.current) return;

    scoredRef.current = true;

    stopAllPlayback();
    setIsCalculatingScore(true);
    setShowScoreModal(true);
    setAnimatedScore(0);
    setRecordStatus(null);

    KaraokeAudioScorer.playDrumrollSound();

    const virtual = usedVirtualRef.current;

    const result: FinalScore = virtual
      ? {
          score: 100,
          comment: "가상보컬로 완벽하게 불렀습니다!",
          rank: "PERFECT",
          breakdown: {
            pitch: 100,
            timing: 100,
            volume: 100,
            expression: 100,
          },
          sangSomething: true,
        }
      : scorerRef.current?.calculateFinalScore() ?? {
          score: 0,
          comment: "채점 모듈을 초기화하지 못했습니다.",
          rank: "-",
          breakdown: {
            pitch: 0,
            timing: 0,
            volume: 0,
            expression: 0,
          },
          sangSomething: false,
        };

    setFinalScore(result);

    let current = 0;
    const step = Math.max(1, Math.ceil(result.score / 25));

    const counter = setInterval(() => {
      current = Math.min(result.score, current + step);
      setAnimatedScore(current);

      if (current >= result.score) {
        clearInterval(counter);
        setIsCalculatingScore(false);

        if (result.sangSomething) {
          KaraokeAudioScorer.playFanfareSound();

          if (
            typeof window !== "undefined" &&
            "speechSynthesis" in window
          ) {
            try {
              window.speechSynthesis.cancel();

              const utt = new SpeechSynthesisUtterance(
                `${result.score}점입니다! ${result.comment}`
              );

              utt.lang = "ko-KR";
              utt.rate = 1.05;
              window.speechSynthesis.speak(utt);
            } catch {}
          }

          if (virtual) {
            setRecordStatus("excluded");
          } else {
            setRecordStatus("saving");

            void Promise.all([
              recordSongToDB(selectedSong),
              recordScoreToDB(selectedSong, result),
            ]).then(([song, score]) =>
              setRecordStatus(song && score ? "saved" : "failed")
            );
          }
        }
      }
    }, 40);
  }, [
    recordSongToDB,
    recordScoreToDB,
    selectedSong,
    stopAllPlayback,
  ]);

  useEffect(() => {
    finishAndScoreRef.current = finishAndScore;
    selectedSongRef.current = selectedSong;
    attemptIndexRef.current = attemptIndex;
  }, [finishAndScore, selectedSong, attemptIndex]);

  // ─────────────────────────────────────────────────────────
  // 유튜브 플레이어 생성 및 송출 테스트
  // ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (
      !media ||
      media.source !== "youtube" ||
      !media.youtubeId ||
      !ytHostRef.current
    ) {
      return;
    }

    let disposed = false;
    const host = ytHostRef.current;

    host.innerHTML = "";

    const mount = document.createElement("div");
    mount.className = "w-full h-full";
    host.appendChild(mount);

    const videoId = media.youtubeId;

    createYouTubePlayer(mount, {
      videoId,
      autoplay: false,

      onReady: (handle) => {
        if (disposed) {
          handle.destroy();
          return;
        }

        ytHandleRef.current = handle;
        handle.setVolume(mrVolume * 100);

        setDuration(handle.getDuration());
        setPlayerReady(true);
        setPlayerError(null);
      },

      onStateChange: (state) => {
        if (disposed) return;

        if (state === YT_STATE.PLAYING) {
          setIsPlaying(true);
          setDuration(ytHandleRef.current?.getDuration() ?? 0);

          setYoutubeTestStatus((prev) => ({
            ...prev,
            [selectedSongRef.current.id]: "success",
          }));

          setPlayerError(null);
        } else if (state === YT_STATE.PAUSED) {
          setIsPlaying(false);
        } else if (state === YT_STATE.ENDED) {
          finishAndScoreRef.current?.();
        }
      },

      onError: (code, message) => {
        if (disposed) return;

        setPlayerReady(false);

        console.warn(
          `[노래방] 유튜브 송출 실패 - 영상=${videoId}, 코드=${code} (${message})`
        );

        if (
          hasNextAttempt(
            selectedSongRef.current,
            attemptIndexRef.current
          )
        ) {
          setYoutubeTestStatus((prev) => ({
            ...prev,
            [selectedSongRef.current.id]: "testing",
          }));

          setPlayerError(
            "현재 영상 송출에 실패했습니다. 다음 후보를 확인합니다."
          );

          setAttemptIndex((prev) => prev + 1);
          return;
        }

        setYoutubeTestStatus((prev) => ({
          ...prev,
          [selectedSongRef.current.id]: "failed",
        }));

        setPlayerError(
          "등록된 유튜브 영상 후보가 모두 실패했습니다."
        );

        setResolved({
          songId: selectedSongRef.current.id,
          media: {
            source: "synth",
            reason: "유튜브 송출 실패 — 내장 자동 반주로 전환했습니다.",
          },
        });
      },
    }).catch((error) => {
      if (disposed) return;

      console.error("[노래방] 유튜브 플레이어 생성 실패", error);

      setPlayerReady(false);

      if (
        hasNextAttempt(
          selectedSongRef.current,
          attemptIndexRef.current
        )
      ) {
        setYoutubeTestStatus((prev) => ({
          ...prev,
          [selectedSongRef.current.id]: "testing",
        }));

        setPlayerError(
          "영상 플레이어 생성에 실패했습니다. 다음 후보를 확인합니다."
        );

        setAttemptIndex((prev) => prev + 1);
        return;
      }

      setYoutubeTestStatus((prev) => ({
        ...prev,
        [selectedSongRef.current.id]: "failed",
      }));

      setPlayerError(
        "유튜브 영상 플레이어를 생성하지 못했습니다."
      );

      setResolved({
        songId: selectedSongRef.current.id,
        media: {
          source: "synth",
          reason: "유튜브 연결 실패 — 내장 자동 반주로 전환했습니다.",
        },
      });
    });

    return () => {
      disposed = true;
      setPlayerReady(false);

      ytHandleRef.current?.destroy();
      ytHandleRef.current = null;

      host.innerHTML = "";
    };
  }, [media?.source, media?.youtubeId, hasEntered]);

  // ─────────────────────────────────────────────────────────
  // 가상 마이크
  // ─────────────────────────────────────────────────────────

  const stopVirtualMic = useCallback(() => {
    setIsVirtualMic(false);

    if (virtualTimerRef.current) {
      clearInterval(virtualTimerRef.current);
      virtualTimerRef.current = null;
    }

    setAudioData({
      volume: 0,
      pitch: 0,
      note: "-",
      cents: 0,
    });
  }, []);

  // ─────────────────────────────────────────────────────────
  // 부스 전원 종료 감지 및 이용 화면 초기화
  // ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (isPowerOn || !hasEntered) return;

    stopAllPlayback();

    scorerRef.current?.stopMicrophone();
    setIsMicActive(false);

    stopVirtualMic();

    setShowScoreModal(false);
    setIsCalculatingScore(false);
    setFinalScore(null);
    setAnimatedScore(0);
    setRecordStatus(null);

    scoredRef.current = false;
    usedVirtualRef.current = false;

    setIsAuthenticated(false);
    setHasEntered(false);
    setIsEntering(false);
    setEnterNotice(null);

    setElapsed(0);
    setPlayerError(null);

    if (
      typeof window !== "undefined" &&
      "speechSynthesis" in window
    ) {
      window.speechSynthesis.cancel();
    }
  }, [
    isPowerOn,
    hasEntered,
    stopAllPlayback,
    stopVirtualMic,
  ]);

  useEffect(() => {
    ytHandleRef.current?.setVolume(mrVolume * 100);

    if (localAudioRef.current) {
      localAudioRef.current.volume = mrVolume;
    }

    accompanimentRef.current?.setVolume(mrVolume);
  }, [mrVolume]);

  // ─────────────────────────────────────────────────────────
  // 재생 시간 타이머
  // ─────────────────────────────────────────────────────────

  const startTicker = useCallback(() => {
    if (tickTimerRef.current) {
      clearInterval(tickTimerRef.current);
    }

    tickTimerRef.current = setInterval(() => {
      const yt = ytHandleRef.current;

      if (yt) {
        const at = yt.getCurrentTime();
        const total = yt.getDuration();

        setElapsed(Math.floor(at));

        if (total > 0 && total - at <= 1) {
          finishAndScoreRef.current?.();
        }
      } else if (localAudioRef.current) {
        setElapsed(Math.floor(localAudioRef.current.currentTime));
      } else {
        setElapsed((prev) => prev + 1);
      }
    }, 1000);
  }, []);

  // ─────────────────────────────────────────────────────────
  // 마이크 제어
  // ─────────────────────────────────────────────────────────

  const startMicrophone = useCallback(async (): Promise<boolean> => {
    if (isVirtualMic) stopVirtualMic();

    const ok =
      (await scorerRef.current?.startMicrophone(setAudioData)) ?? false;

    setIsMicActive(ok);

    return ok;
  }, [isVirtualMic, stopVirtualMic]);

  const toggleMicrophone = useCallback(async () => {
    if (isMicActive) {
      scorerRef.current?.stopMicrophone();
      setIsMicActive(false);

      setAudioData({
        volume: 0,
        pitch: 0,
        note: "-",
        cents: 0,
      });

      return;
    }

    const ok = await startMicrophone();

    if (!ok) {
      alert(
        "마이크를 사용할 수 없습니다. 권한을 확인하거나 가상보컬을 사용해 보세요."
      );
    }
  }, [isMicActive, startMicrophone]);

  const toggleVirtualMic = useCallback(() => {
    if (isVirtualMic) {
      stopVirtualMic();
      return;
    }

    if (isMicActive) {
      scorerRef.current?.stopMicrophone();
      setIsMicActive(false);
    }

    scorerRef.current?.resetScore();
    setIsVirtualMic(true);
    usedVirtualRef.current = true;

    const notes = ["C4", "D4", "E4", "F4", "G4", "A4", "B4", "C5"];

    virtualTimerRef.current = setInterval(() => {
      const volume = Math.floor(45 + Math.random() * 45);
      const pitch = Math.floor(220 + Math.random() * 400);

      scorerRef.current?.feedSimulatedFrame(volume, pitch);

      setAudioData({
        volume,
        pitch,
        note: notes[Math.floor(Math.random() * notes.length)],
        cents: Math.floor(Math.random() * 30 - 15),
      });
    }, 150);
  }, [isMicActive, isVirtualMic, stopVirtualMic]);

  // ─────────────────────────────────────────────────────────
  // 재생 시작
  // ─────────────────────────────────────────────────────────

  const handlePlay = useCallback(async () => {
    if (!media || !isPowerOn) return;

    scoredRef.current = false;
    usedVirtualRef.current = isVirtualMic;

    setShowScoreModal(false);
    setElapsed(0);

    scorerRef.current?.resetScore();
    scorerRef.current?.resumeAnalysis();

    if (media.source === "youtube") {
      const yt = ytHandleRef.current;

      if (!yt) {
        setPlayerError(
          "영상을 불러오는 중입니다. 잠시 후 다시 눌러 주세요."
        );
        return;
      }

      setYoutubeTestStatus((prev) => ({
        ...prev,
        [selectedSong.id]: "testing",
      }));

      setPlayerError(null);

      yt.seekTo(0);
      yt.setVolume(mrVolume * 100);
      yt.play();

      accompanimentRef.current?.stop();
    } else if (media.source === "local" && media.localUrl) {
      accompanimentRef.current?.stop();

      if (isVideoFile(media.localUrl)) {
        if (
          !localAudioRef.current ||
          !(localAudioRef.current instanceof HTMLVideoElement)
        ) {
          setPlayerError(
            "교가 영상을 준비하는 중입니다. 잠시 후 다시 눌러 주세요."
          );
          return;
        }
      } else if (
        !localAudioRef.current ||
        localAudioRef.current instanceof HTMLVideoElement
      ) {
        localAudioRef.current = new Audio();
      }

      const audio = localAudioRef.current;

      if (
        !(audio instanceof HTMLVideoElement) &&
        audio.src !== new URL(media.localUrl, window.location.href).href
      ) {
        audio.src = media.localUrl;
      }

      audio.volume = mrVolume;
      audio.currentTime = 0;

      audio.onloadedmetadata = () =>
        setDuration(Math.floor(audio.duration || 0));

      audio.onended = () => finishAndScore();

      audio.onerror = () => {
        setIsPlaying(false);

        if (tickTimerRef.current) {
          clearInterval(tickTimerRef.current);
          tickTimerRef.current = null;
        }

        if (isSchoolAnthem(selectedSong)) {
          setPlayerError(
            "교가 MP4 파일을 재생할 수 없습니다. 파일 경로와 영상 파일을 확인해 주세요."
          );
          return;
        }

        setResolved({
          songId: selectedSong.id,
          media: {
            source: "synth",
            reason: "반주 파일 재생 실패 — 내장 자동 반주로 전환",
          },
        });
      };

      try {
        await audio.play();
        setPlayerError(null);
      } catch {
        setPlayerError(
          "영상을 재생할 수 없습니다. 파일 경로와 브라우저 재생 권한을 확인해 주세요."
        );
        return;
      }
    } else {
      ytHandleRef.current?.pause();

      accompanimentRef.current?.setVolume(mrVolume);

      accompanimentRef.current?.start({
        bpm: selectedSong.mr.bpm,
        style: selectedSong.mr.style,
        progression: selectedSong.mr.progression,
        tonic: selectedSong.mr.tonic,
      });

      setDuration(selectedSong.approxDurationSec);
    }

    setIsPlaying(true);
    startTicker();
  }, [
    media,
    isPowerOn,
    isVirtualMic,
    mrVolume,
    selectedSong,
    startTicker,
    finishAndScore,
  ]);

  const handlePause = useCallback(() => {
    stopAllPlayback();
    scorerRef.current?.pauseAnalysis();
  }, [stopAllPlayback]);

  // ─────────────────────────────────────────────────────────
  // 입장 처리
  // ─────────────────────────────────────────────────────────

  const handleEnter = useCallback(async () => {
    if (!isAuthenticated || isEntering || !isPowerOn) {
      return;
    }

    setIsEntering(true);
    setEnterNotice("마이크 권한을 확인하는 중...");

    const micOk = await startMicrophone();

    if (micOk) {
      setEnterNotice("준비 완료!");
    } else {
      setEnterNotice("마이크 없이 진행합니다.");
    }

    setIsEntering(false);
    setHasEntered(true);
  }, [isAuthenticated, isEntering, isPowerOn, startMicrophone]);

  // ─────────────────────────────────────────────────────────
  // 곡 선택
  // ─────────────────────────────────────────────────────────

  const handleSelectSong = useCallback(
    (song: KaraokeSong) => {
      stopAllPlayback();

      scoredRef.current = false;
      usedVirtualRef.current = false;

      setSelectedSong(song);
      setPlayerError(null);
      setAttemptIndex(0);
      setPlayerReady(false);
      setElapsed(0);
      setDuration(song.approxDurationSec);
      setShowScoreModal(false);
    },
    [stopAllPlayback]
  );

  // ─────────────────────────────────────────────────────────
  // 곡별 유튜브 테스트 상태 표시
  // ─────────────────────────────────────────────────────────

  const getYoutubeStatus = (
    song: KaraokeSong
  ): YoutubeTestStatus | "anthem" => {
    if (isSchoolAnthem(song)) {
      return "anthem";
    }

    return youtubeTestStatus[song.id] ?? "untested";
  };

  const normalizedSearchQuery = searchQuery.trim().toLocaleLowerCase();

  const filteredSongs = KARAOKE_SONGS.filter((song) => {
    if (!normalizedSearchQuery) return true;

    const title = song.title.toLocaleLowerCase();
    const singer = song.singer.toLocaleLowerCase();
    const songNumber = song.songNumber?.toLocaleLowerCase() ?? "";

    return (
      title.includes(normalizedSearchQuery) ||
      singer.includes(normalizedSearchQuery) ||
      songNumber.includes(normalizedSearchQuery)
    );
  });

  const formatSeconds = (sec: number) => {
    const m = Math.floor(Math.max(0, sec) / 60);
    const s = Math.floor(Math.max(0, sec) % 60);

    return `${m}:${s < 10 ? "0" : ""}${s}`;
  };

  const progressPct =
    duration > 0 ? Math.min(100, (elapsed / duration) * 100) : 0;

  const waitingForPlayer = media?.source === "youtube" && !playerReady;

  const sourceBadge = {
    local: {
      icon: HardDrive,
      label: isSchoolAnthem(selectedSong)
        ? "교가 전용 MP4 영상"
        : "로컬 반주 파일",
      className:
        "bg-violet-400/15 border-violet-300/30 text-violet-100",
    },
    youtube: {
      icon: Tv,
      label: "유튜브 노래방 영상",
      className: "bg-indigo-400/15 border-indigo-300/30 text-indigo-100",
    },
    synth: {
      icon: Radio,
      label: "내장 자동 반주",
      className: "bg-slate-400/10 border-slate-300/20 text-slate-300",
    },
  }[media?.source ?? "synth"];

  const SourceIcon = sourceBadge.icon;

  // ─────────────────────────────────────────────────────────
  // 화면
  // ─────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen">
      {/* 1. 인증 화면: 메인 노래방 화면과 완전히 분리 */}

      {!hasEntered && (
        <AttractScreen
          authenticated={isAuthenticated}
          isPowerOn={isPowerOn}
          onEnter={() => void handleEnter()}
          enterNotice={enterNotice}
        >
          {!isAuthenticated && (
            <BoothKeypad
              notice={authNotice}
              onVerified={onKeypadVerified}
              onAuthSuccess={handleAuthSuccess}
              onAuthAttempt={handleScreenAuthAttempt}
            />
          )}
        </AttractScreen>
      )}

      {/* 2. 프리미엄 노래방 메인 화면 */}

      {hasEntered && (
        <div className="relative min-h-screen overflow-hidden bg-[#070812] text-white">
          {/* 다층 앰비언트 조명 */}
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="absolute -top-64 left-[12%] h-[650px] w-[650px] rounded-full bg-indigo-500/20 blur-[145px]" />
            <div className="absolute -top-48 right-[-8%] h-[650px] w-[650px] rounded-full bg-fuchsia-500/15 blur-[155px]" />
            <div className="absolute top-[38%] left-[35%] h-[550px] w-[550px] rounded-full bg-blue-500/12 blur-[150px]" />
            <div className="absolute -bottom-72 right-[15%] h-[600px] w-[600px] rounded-full bg-violet-600/20 blur-[150px]" />
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(255,255,255,0.055),transparent_48%)]" />
          </div>

          <div className="relative z-10 mx-auto max-w-[1700px] px-3 py-5 sm:px-5 lg:px-8 lg:py-7">
            {/* 상단 브랜드 라인 */}
            <div className="mb-5 flex items-center justify-between gap-3 border-b border-white/10 pb-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-violet-300/30 bg-gradient-to-br from-indigo-400/30 via-violet-500/20 to-fuchsia-400/20 shadow-[0_0_28px_rgba(139,92,246,0.2)]">
                  <Music className="h-5 w-5 text-violet-100" />
                </div>

                <div>
                  <p className="text-[10px] font-black tracking-[0.32em] text-violet-200">
                    IMMERSIVE MUSIC ROOM
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    PREMIUM KARAOKE EXPERIENCE
                  </p>
                </div>
              </div>

              <div className="hidden items-center gap-2 rounded-full border border-emerald-300/20 bg-emerald-400/[0.08] px-3 py-2 sm:flex">
                <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.9)]" />
                <span className="text-[10px] font-semibold tracking-wide text-emerald-200">
                  ROOM ACTIVE
                </span>
              </div>
            </div>

            {/* 세션 정보 */}
            <div className="mb-6 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.045] shadow-[0_12px_50px_rgba(0,0,0,0.18)] backdrop-blur-xl">
              <SessionStrip
                session={session}
                isPowerOn={isPowerOn}
                ledBlink={ledBlink}
              />
            </div>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
              {/* 왼쪽: 메인 영상 및 컨트롤 */}

              <div className="flex min-w-0 flex-col space-y-5 xl:col-span-8">
                {/* 곡 정보 헤더 */}
                <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-white/[0.09] via-white/[0.035] to-indigo-500/[0.07] p-5 shadow-[0_15px_55px_rgba(0,0,0,0.2)] backdrop-blur-xl sm:p-6">
                  <div className="pointer-events-none absolute -right-20 -top-28 h-64 w-64 rounded-full bg-violet-400/15 blur-[75px]" />
                  <div className="pointer-events-none absolute -bottom-32 left-1/3 h-56 w-56 rounded-full bg-blue-400/10 blur-[80px]" />

                  <div className="relative flex flex-wrap items-end justify-between gap-5">
                    <div className="min-w-0 flex-1">
                      <div className="mb-3 flex items-center gap-2">
                        <span className="h-2 w-2 rounded-full bg-fuchsia-300 shadow-[0_0_14px_rgba(232,121,249,0.95)]" />
                        <span className="text-[10px] font-bold tracking-[0.3em] text-fuchsia-200">
                          NOW SELECTED
                        </span>
                      </div>

                      <h2 className="break-words text-3xl font-black leading-tight tracking-tight text-white drop-shadow-[0_3px_18px_rgba(139,92,246,0.25)] sm:text-4xl lg:text-5xl">
                        {selectedSong.title}
                      </h2>

                      <p className="mt-2 text-sm font-medium text-slate-300 sm:text-base">
                        {selectedSong.singer}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full border border-white/15 bg-black/20 px-3 py-2 text-[10px] font-semibold text-slate-200 backdrop-blur-md">
                        {selectedSong.tag}
                      </span>

                      <div
                        className={`flex items-center gap-2 rounded-full border px-3 py-2 text-[10px] font-semibold backdrop-blur-md ${sourceBadge.className}`}
                      >
                        <SourceIcon className="h-3.5 w-3.5" />
                        {sourceBadge.label}
                      </div>
                    </div>
                  </div>
                </div>

                {/* 유튜브 테스트 상태 */}
                {!isSchoolAnthem(selectedSong) && (
                  <div className="flex min-h-5 items-center gap-2 px-1 text-xs">
                    {getYoutubeStatus(selectedSong) === "success" && (
                      <>
                        <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                        <span className="text-emerald-300">
                          유튜브 영상 송출 확인
                        </span>
                      </>
                    )}

                    {getYoutubeStatus(selectedSong) === "testing" && (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin text-violet-300" />
                        <span className="text-violet-200">
                          유튜브 영상 테스트 중
                        </span>
                      </>
                    )}

                    {getYoutubeStatus(selectedSong) === "failed" && (
                      <>
                        <AlertTriangle className="h-4 w-4 text-rose-400" />
                        <span className="text-rose-300">
                          유튜브 후보 실패 — 내장 반주 사용
                        </span>
                      </>
                    )}

                    {getYoutubeStatus(selectedSong) === "untested" && (
                      <>
                        <AlertTriangle className="h-4 w-4 text-slate-500" />
                        <span className="text-slate-400">
                          유튜브 영상 미검증 — 반주 시작을 눌러 테스트
                        </span>
                      </>
                    )}
                  </div>
                )}

                {playerError && (
                  <div className="rounded-xl border border-rose-400/25 bg-rose-500/10 p-3 text-xs text-rose-200 shadow-[0_0_25px_rgba(244,63,94,0.06)]">
                    {playerError}
                  </div>
                )}

                {/* 메인 영상 프레임 */}
                <div className="group relative rounded-[1.35rem] bg-gradient-to-br from-indigo-300/50 via-violet-400/30 to-fuchsia-300/40 p-[1px] shadow-[0_25px_90px_rgba(0,0,0,0.55),0_0_45px_rgba(139,92,246,0.16)]">
                  <div className="pointer-events-none absolute -inset-3 -z-10 rounded-[1.6rem] bg-gradient-to-br from-indigo-500/20 via-violet-500/15 to-fuchsia-500/20 blur-2xl opacity-80 transition-opacity duration-700 group-hover:opacity-100" />

                  <div className="relative aspect-video w-full overflow-hidden rounded-[1.3rem] bg-[#03040A]">
                    <div className="pointer-events-none absolute inset-0 z-10 rounded-[1.3rem] ring-1 ring-inset ring-white/10" />

                    {media?.source === "youtube" ? (
                      <div className="relative h-full w-full">
                        <div
                          ref={ytHostRef}
                          className="h-full w-full"
                        />
                      </div>
                    ) : media?.source === "local" &&
                      media.localUrl &&
                      isVideoFile(media.localUrl) ? (
                      <div className="relative h-full w-full bg-black">
                        <video
                          ref={(element) => {
                            localAudioRef.current = element;
                          }}
                          src={media.localUrl}
                          className="h-full w-full object-contain"
                          playsInline
                          preload="metadata"
                          onLoadedMetadata={(event) => {
                            const video = event.currentTarget;
                            setDuration(
                              Math.floor(video.duration || 0)
                            );
                          }}
                          onTimeUpdate={(event) => {
                            setElapsed(
                              Math.floor(event.currentTarget.currentTime)
                            );
                          }}
                          onPlay={() => {
                            setIsPlaying(true);
                          }}
                          onPause={() => {
                            setIsPlaying(false);
                          }}
                          onEnded={() => {
                            finishAndScore();
                          }}
                          onError={() => {
                            setIsPlaying(false);
                            setPlayerError(
                              "교가 MP4 영상을 불러오지 못했습니다. school-anthem.mp4 파일의 위치와 형식을 확인해 주세요."
                            );
                          }}
                        />
                      </div>
                    ) : (
                      <GuideScreen
                        song={selectedSong}
                        isPlaying={isPlaying}
                        headline={
                          isSchoolAnthem(selectedSong)
                            ? "교가 전용 영상 준비 중"
                            : "내장 자동 반주로 재생 중"
                        }
                        onStart={handlePlay}
                        canStart={isPowerOn}
                      />
                    )}
                  </div>
                </div>

                {/* 진행 바 */}
                <div className="rounded-2xl border border-white/10 bg-white/[0.035] px-4 py-3 shadow-lg backdrop-blur-xl">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[9px] font-bold tracking-[0.2em] text-violet-200/80">
                      PLAYBACK PROGRESS
                    </span>
                    <span className="font-mono text-[10px] text-slate-400">
                      {Math.round(progressPct)}%
                    </span>
                  </div>

                  <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-blue-400 via-violet-400 to-fuchsia-400 shadow-[0_0_18px_rgba(192,132,252,0.65)] transition-all duration-500"
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>

                  <div className="mt-2 flex justify-between font-mono text-[10px] text-slate-500">
                    <span>{formatSeconds(elapsed)}</span>
                    <span>
                      {duration > 0
                        ? formatSeconds(duration)
                        : "--:--"}
                    </span>
                  </div>
                </div>

                {/* 재생 컨트롤 패널 */}
                <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-[#1a1b2c]/95 via-[#111321]/95 to-[#171127]/95 p-4 shadow-[0_20px_65px_rgba(0,0,0,0.35)] backdrop-blur-2xl sm:p-5">
                  <div className="pointer-events-none absolute -right-24 -top-24 h-56 w-56 rounded-full bg-violet-500/10 blur-[75px]" />

                  <div className="relative flex flex-wrap items-center justify-between gap-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        onClick={() =>
                          isPlaying
                            ? handlePause()
                            : void handlePlay()
                        }
                        disabled={
                          !media ||
                          !isPowerOn ||
                          waitingForPlayer
                        }
                        className="flex items-center gap-2 rounded-xl border border-violet-200/30 bg-gradient-to-r from-indigo-500 via-violet-500 to-fuchsia-500 px-5 py-3.5 text-xs font-black text-white shadow-[0_8px_30px_rgba(139,92,246,0.3)] transition-all hover:scale-[1.025] hover:shadow-[0_10px_38px_rgba(139,92,246,0.42)] disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:scale-100"
                      >
                        {waitingForPlayer ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : isPlaying ? (
                          <Pause className="h-4 w-4" />
                        ) : (
                          <Play className="h-4 w-4 fill-current" />
                        )}

                        {waitingForPlayer
                          ? "불러오는 중"
                          : isPlaying
                            ? "일시정지"
                            : "반주 시작"}
                      </button>

                      <button
                        onClick={finishAndScore}
                        disabled={!isPowerOn}
                        className="flex items-center gap-2 rounded-xl border border-fuchsia-300/25 bg-fuchsia-400/[0.10] px-5 py-3.5 text-xs font-bold text-fuchsia-100 transition-all hover:border-fuchsia-200/50 hover:bg-fuchsia-400/[0.18] disabled:cursor-not-allowed disabled:opacity-30"
                      >
                        <Trophy className="h-4 w-4" />
                        노래 완료 &amp; 채점
                      </button>
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                      {/* 음량 */}
                      <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/25 px-3 py-2.5">
                        <SlidersHorizontal className="h-3.5 w-3.5 text-violet-300" />

                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.05"
                          value={mrVolume}
                          onChange={(e) =>
                            setMrVolume(parseFloat(e.target.value))
                          }
                          className="h-1.5 w-16 cursor-pointer appearance-none rounded-lg bg-white/15 accent-violet-400"
                        />
                      </div>

                      {/* 마이크 */}
                      <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/25 px-2 py-1.5">
                        <button
                          onClick={() => void toggleMicrophone()}
                          title="마이크 켜기 / 끄기"
                          className={`rounded-lg border p-2 transition-colors ${
                            isMicActive
                              ? "border-rose-400/40 bg-rose-500/15 text-rose-300"
                              : "border-white/10 bg-white/[0.04] text-slate-400 hover:text-white"
                          }`}
                        >
                          {isMicActive ? (
                            <Mic className="h-4 w-4" />
                          ) : (
                            <MicOff className="h-4 w-4" />
                          )}
                        </button>

                        <button
                          onClick={toggleVirtualMic}
                          className={`rounded-lg border px-2.5 py-2 text-[10px] font-semibold transition-colors ${
                            isVirtualMic
                              ? "border-emerald-400/40 bg-emerald-500/15 text-emerald-300"
                              : "border-white/10 bg-white/[0.04] text-slate-400 hover:text-white"
                          }`}
                        >
                          {isVirtualMic
                            ? "가상보컬 ON"
                            : "가상보컬"}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* 오른쪽: 선곡 라이브러리 */}

              <aside className="relative flex min-h-[560px] flex-col overflow-hidden rounded-[1.4rem] border border-violet-200/15 bg-gradient-to-b from-[#1b1b30]/95 via-[#111321]/95 to-[#0c0d18]/95 shadow-[0_25px_75px_rgba(0,0,0,0.42),0_0_40px_rgba(99,102,241,0.08)] backdrop-blur-2xl xl:col-span-4">
                <div className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-fuchsia-500/12 blur-[80px]" />
                <div className="pointer-events-none absolute -bottom-28 -left-24 h-64 w-64 rounded-full bg-indigo-500/12 blur-[80px]" />

                {/* 목록 헤더 */}
                <div className="relative border-b border-white/10 px-5 py-5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="mb-2 flex items-center gap-2">
                        <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-violet-300/25 bg-violet-400/10">
                          <Music className="h-4 w-4 text-violet-200" />
                        </div>

                        <span className="text-[10px] font-black tracking-[0.25em] text-violet-200">
                          MUSIC LIBRARY
                        </span>
                      </div>

                      <h3 className="text-lg font-black tracking-tight text-white">
                        곡 선택
                      </h3>

                      <p className="mt-1 text-[10px] text-slate-400">
                        원하는 곡을 검색하고 선택해 주세요.
                      </p>
                    </div>

                    <div className="rounded-xl border border-white/10 bg-white/[0.05] px-3 py-2 text-center">
                      <p className="text-lg font-black leading-none text-white">
                        {KARAOKE_SONGS.length}
                      </p>
                      <p className="mt-1 text-[8px] font-bold tracking-widest text-slate-500">
                        TRACKS
                      </p>
                    </div>
                  </div>
                </div>

                {/* 검색 */}
                <div className="relative px-4 py-4">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-violet-300/70" />

                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) =>
                        setSearchQuery(e.target.value)
                      }
                      placeholder="곡명, 가수 또는 곡 번호 검색..."
                      className="w-full rounded-xl border border-white/10 bg-black/30 py-3.5 pl-10 pr-3 text-xs text-white outline-none transition-all placeholder:text-slate-600 focus:border-violet-300/50 focus:bg-black/45 focus:shadow-[0_0_22px_rgba(139,92,246,0.12)]"
                    />
                  </div>

                  <p className="mt-2 px-1 text-[9px] text-slate-500">
                    검색 결과 {filteredSongs.length}곡
                  </p>
                </div>

                {/* 곡 목록 */}
                <div className="relative max-h-[680px] flex-1 space-y-2 overflow-y-auto px-4 pb-4">
                  {filteredSongs.length === 0 && (
                    <div className="flex min-h-32 items-center justify-center text-xs text-slate-500">
                      검색 결과가 없습니다.
                    </div>
                  )}

                  {filteredSongs.map((song) => {
                    const isCurrent = selectedSong.id === song.id;
                    const status = getYoutubeStatus(song);

                    return (
                      <button
                        key={song.id}
                        onClick={() => handleSelectSong(song)}
                        className={`group w-full rounded-xl border p-3.5 text-left transition-all duration-200 ${
                          isCurrent
                            ? "border-violet-300/50 bg-gradient-to-r from-indigo-400/20 via-violet-400/15 to-fuchsia-400/10 shadow-[0_0_28px_rgba(139,92,246,0.13)]"
                            : "border-white/[0.07] bg-white/[0.025] hover:border-violet-300/25 hover:bg-white/[0.06]"
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <div
                            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${
                              isCurrent
                                ? "border-violet-200/30 bg-gradient-to-br from-indigo-400/30 to-fuchsia-400/20 text-violet-100 shadow-[0_0_18px_rgba(167,139,250,0.15)]"
                                : "border-white/[0.07] bg-white/[0.04] text-slate-500"
                            }`}
                          >
                            {isCurrent ? (
                              <Music className="h-4 w-4" />
                            ) : (
                              <span className="text-xs font-mono">♪</span>
                            )}
                          </div>

                          <div className="min-w-0 flex-1">
                            <span
                              className={`block truncate text-xs font-bold ${
                                isCurrent
                                  ? "text-white"
                                  : "text-slate-200"
                              }`}
                            >
                              {song.title}
                            </span>

                            <p className="mt-1 truncate text-[11px] text-slate-400">
                              {song.singer}
                            </p>

                            {song.songNumber && (
                              <p className="mt-1 text-[10px] text-violet-300/80">
                                {song.songNumberSource} {song.songNumber}
                              </p>
                            )}
                          </div>

                          <div className="shrink-0">
                            {status === "anthem" && (
                              <span className="rounded-md border border-violet-300/25 bg-violet-400/10 px-2 py-1 text-[9px] text-violet-200">
                                전용 MP4
                              </span>
                            )}

                            {status === "untested" && (
                              <span className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[9px] text-slate-500">
                                미검증
                              </span>
                            )}

                            {status === "testing" && (
                              <span className="flex items-center gap-1 rounded-md border border-violet-300/25 bg-violet-400/10 px-2 py-1 text-[9px] text-violet-200">
                                <Loader2 className="h-3 w-3 animate-spin" />
                                테스트 중
                              </span>
                            )}

                            {status === "success" && (
                              <span className="flex items-center gap-1 rounded-md border border-emerald-300/20 bg-emerald-400/10 px-2 py-1 text-[9px] text-emerald-300">
                                <CheckCircle2 className="h-3 w-3" />
                                정상
                              </span>
                            )}

                            {status === "failed" && (
                              <span className="flex items-center gap-1 rounded-md border border-rose-300/20 bg-rose-400/10 px-2 py-1 text-[9px] text-rose-300">
                                <AlertTriangle className="h-3 w-3" />
                                실패
                              </span>
                            )}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* 목록 하단 안내 */}
                <div className="relative border-t border-white/10 bg-black/25 px-5 py-4">
                  <p className="text-[10px] leading-relaxed text-slate-400">
                    일반 곡은 실제 유튜브 영상이 재생되면 정상으로 표시됩니다.
                    모든 후보 영상이 실패하면 내장 반주로 전환되며,
                    해당 곡은 실패로 기록됩니다.
                    교가는 별도의 학교 자체 제작 MP4 영상을 사용합니다.
                  </p>
                </div>
              </aside>
            </div>
          </div>
        </div>
      )}

      {/* 점수 모달 */}

      {showScoreModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4 backdrop-blur-xl">
          <div className="relative w-full max-w-md overflow-hidden rounded-3xl border border-violet-300/35 bg-gradient-to-br from-[#202039] via-[#111321] to-[#171127] p-7 text-center shadow-[0_0_100px_rgba(139,92,246,0.22)]">
            <div className="pointer-events-none absolute -top-24 left-1/2 h-56 w-56 -translate-x-1/2 rounded-full bg-violet-500/25 blur-[75px]" />
            <div className="pointer-events-none absolute -bottom-24 right-0 h-48 w-48 rounded-full bg-fuchsia-500/15 blur-[75px]" />

            <div className="relative space-y-6">
              <div>
                <div className="mb-2 text-[10px] font-black tracking-[0.3em] text-violet-300">
                  KARAOKE SCORE
                </div>

                <h3 className="text-xl font-black text-white">
                  {selectedSong.title}
                </h3>

                <p className="mt-1 text-xs text-slate-400">
                  {selectedSong.singer}
                </p>
              </div>

              <div className="mx-auto flex h-40 w-40 flex-col items-center justify-center rounded-full border border-violet-200/50 bg-gradient-to-br from-indigo-400/25 via-violet-500/20 to-fuchsia-400/20 shadow-[0_0_55px_rgba(139,92,246,0.2)]">
                <div className="text-5xl font-black tracking-tight text-white">
                  {animatedScore}
                </div>

                <div className="mt-1 text-xs font-bold tracking-widest text-violet-200">
                  POINTS
                </div>
              </div>

              {finalScore && (
                <div className="space-y-2">
                  <p className="text-lg font-black text-violet-200">
                    {finalScore.rank}
                  </p>

                  <p className="text-xs text-slate-300">
                    {finalScore.comment}
                  </p>
                </div>
              )}

              {isCalculatingScore && (
                <p className="text-xs text-slate-400">
                  점수를 계산하고 있습니다...
                </p>
              )}

              {!isCalculatingScore && recordStatus === "saving" && (
                <p className="text-xs text-violet-300">
                  점수 기록을 저장하고 있습니다.
                </p>
              )}

              {!isCalculatingScore && recordStatus === "saved" && (
                <p className="text-xs text-emerald-300">
                  점수가 정상적으로 기록되었습니다.
                </p>
              )}

              {!isCalculatingScore && recordStatus === "failed" && (
                <p className="text-xs text-rose-300">
                  점수 기록에 실패했습니다.
                </p>
              )}

              {!isCalculatingScore && recordStatus === "excluded" && (
                <p className="text-xs text-slate-400">
                  가상보컬 점수는 기록에서 제외됩니다.
                </p>
              )}

              <button
                onClick={() => setShowScoreModal(false)}
                className="w-full rounded-xl border border-violet-200/35 bg-gradient-to-r from-indigo-500/25 to-violet-500/25 px-5 py-3 text-xs font-bold text-violet-100 transition-all hover:from-indigo-500/35 hover:to-fuchsia-500/30"
              >
                확인
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------
// 내장 반주 안내 화면
// ----------------------------------------------------------------------

function GuideScreen({
  song,
  isPlaying,
  headline,
  onStart,
  canStart = true,
}: any) {
  return (
    <div className="relative flex h-full flex-col justify-between overflow-hidden bg-gradient-to-br from-[#111323] via-[#201936] to-[#090A12] p-6 sm:p-9">
      <div className="pointer-events-none absolute -right-20 -top-20 h-72 w-72 rounded-full bg-fuchsia-500/15 blur-[85px]" />
      <div className="pointer-events-none absolute -bottom-20 -left-20 h-72 w-72 rounded-full bg-indigo-500/20 blur-[85px]" />
      <div className="pointer-events-none absolute left-1/3 top-1/4 h-40 w-40 rounded-full bg-blue-400/10 blur-[65px]" />

      <div className="relative flex items-center gap-2 text-[10px] font-bold tracking-[0.2em] text-violet-200/90">
        <span className="h-2 w-2 rounded-full bg-violet-300 shadow-[0_0_12px_rgba(196,181,253,0.9)]" />
        {headline}
      </div>

      <div className="relative my-auto space-y-5 text-center">
        <div className="mx-auto flex h-24 w-24 items-center justify-center rounded-[2rem] border border-violet-200/30 bg-gradient-to-br from-indigo-400/20 to-fuchsia-400/20 shadow-[0_0_45px_rgba(139,92,246,0.2)]">
          <Music className="h-10 w-10 text-violet-100" />
        </div>

        <div>
          <h4 className="text-2xl font-black text-white sm:text-3xl">
            {song.title}
          </h4>

          <p className="mt-2 text-sm text-slate-300">
            {song.singer}
          </p>
        </div>

        {!isPlaying && (
          <button
            onClick={onStart}
            disabled={!canStart}
            className="mt-3 inline-flex items-center gap-2 rounded-xl border border-violet-200/35 bg-gradient-to-r from-indigo-500/30 to-fuchsia-500/25 px-7 py-3.5 text-xs font-bold text-white shadow-[0_8px_30px_rgba(139,92,246,0.2)] transition-all hover:from-indigo-500/40 hover:to-fuchsia-500/35 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Play className="h-4 w-4" />
            반주 시작하기
          </button>
        )}
      </div>
    </div>
  );
}

function isVideoFile(url: string): boolean {
  return /\.(mp4|webm)$/i.test(url);
}
