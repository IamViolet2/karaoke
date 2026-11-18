
"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Camera,
  Video,
  VideoOff,
  RefreshCw,
  ShieldCheck,
  AlertTriangle,
  Activity,
  Clock3,
  Wifi,
  WifiOff,
} from "lucide-react";
import { apiUrl } from "@/utils/apiConfig";

type VisionStatus = {
  connected: boolean;
  last_received_at: number | null;
  frame_age_ms: number | null;
  raw: {
    frame_id: number | null;
    captured_at: number | null;
  };
  processed: {
    frame_id: number | null;
    captured_at: number | null;
    inference_ms: number | null;
  };
};

type ConnectionStatus = "checking" | "connected" | "disconnected" | "error";
type StreamTab = "raw" | "processed";

const EMPTY_STATUS: VisionStatus = {
  connected: false,
  last_received_at: null,
  frame_age_ms: null,
  raw: { frame_id: null, captured_at: null },
  processed: {
    frame_id: null,
    captured_at: null,
    inference_ms: null,
  },
};

export function CctvPanel() {
  const [visionStatus, setVisionStatus] =
    useState<VisionStatus>(EMPTY_STATUS);

  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("checking");

  const [activeTab, setActiveTab] = useState<StreamTab>("raw");
  const [errorMessage, setErrorMessage] = useState("");
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [streamRefresh, setStreamRefresh] = useState(0);

  // 중복 요청 방지 및 요청 취소 관리
  const requestInProgressRef = useRef(false);
  const currentControllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);

  // -------------------------------------------------------
  // Vision 상태 조회
  // -------------------------------------------------------

  const fetchVisionStatus = useCallback(async (force = false) => {
    if (!mountedRef.current) return;

    // 이미 조회 중이면 중복 요청 방지
    if (requestInProgressRef.current) {
      if (!force) return;

      // 수동 새로고침이면 기존 요청 취소
      currentControllerRef.current?.abort();
    }

    const controller = new AbortController();

    currentControllerRef.current = controller;
    requestInProgressRef.current = true;

    try {
      const response = await fetch(
        apiUrl("/api/v1/vision/stream/status"),
        {
          method: "GET",
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
        }
      );

      if (!response.ok) {
        throw new Error(
          `Vision 상태 조회 실패: HTTP ${response.status}`
        );
      }

      const result = await response.json();

      if (!result?.data) {
        throw new Error("Vision 상태 데이터가 없습니다.");
      }

      // 요청이 취소되었거나 컴포넌트가 사라졌으면 상태 변경하지 않음
      if (controller.signal.aborted || !mountedRef.current) return;

      const data = result.data;

      const nextStatus: VisionStatus = {
        connected: data.connected ?? false,
        last_received_at: data.last_received_at ?? null,
        frame_age_ms: data.frame_age_ms ?? null,
        raw: {
          frame_id: data.raw?.frame_id ?? null,
          captured_at: data.raw?.captured_at ?? null,
        },
        processed: {
          frame_id: data.processed?.frame_id ?? null,
          captured_at: data.processed?.captured_at ?? null,
          inference_ms: data.processed?.inference_ms ?? null,
        },
      };

      setVisionStatus(nextStatus);

      setConnectionStatus(
        nextStatus.connected ? "connected" : "disconnected"
      );

      setLastUpdated(Date.now());
      setErrorMessage("");
    } catch (error) {
      if (
        controller.signal.aborted ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        return;
      }

      if (!mountedRef.current) return;

      console.error("[Vision] 상태 조회 오류:", error);

      // 일시적인 API 조회 실패만으로 기존 영상 연결 상태를 끊지 않음
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Vision 상태를 조회하지 못했습니다."
      );

      // 아직 한 번도 정상 연결되지 않은 경우에만 오류 상태 표시
      setConnectionStatus((previous) =>
        previous === "connected" || previous === "disconnected"
          ? previous
          : "error"
      );
    } finally {
      // 현재 요청이 자신이 관리하는 요청일 때만 잠금 해제
      if (currentControllerRef.current === controller) {
        currentControllerRef.current = null;
        requestInProgressRef.current = false;
      }
    }
  }, []);

  // -------------------------------------------------------
  // 1초마다 상태 갱신
  // -------------------------------------------------------

  useEffect(() => {
    mountedRef.current = true;

    fetchVisionStatus();

    const interval = window.setInterval(() => {
      fetchVisionStatus();
    }, 1000);

    return () => {
      mountedRef.current = false;
      currentControllerRef.current?.abort();
      currentControllerRef.current = null;
      requestInProgressRef.current = false;
      window.clearInterval(interval);
    };
  }, [fetchVisionStatus]);

  // -------------------------------------------------------
  // 영상 새로고침
  // -------------------------------------------------------

  const refreshStreams = useCallback(() => {
    setStreamRefresh((previous) => previous + 1);
    fetchVisionStatus(true);
  }, [fetchVisionStatus]);

  // -------------------------------------------------------
  // 표시 데이터
  // -------------------------------------------------------

  const isConnected = connectionStatus === "connected";

  const rawFrameId = visionStatus.raw.frame_id;
  const processedFrameId = visionStatus.processed.frame_id;

  const frameDifference =
    rawFrameId !== null && processedFrameId !== null
      ? Math.abs(rawFrameId - processedFrameId)
      : null;

  const inferenceMs = visionStatus.processed.inference_ms;
  const frameAgeMs = visionStatus.frame_age_ms;

  const captureAgeMs =
    visionStatus.raw.captured_at !== null
      ? Math.max(
          0,
          Date.now() - visionStatus.raw.captured_at * 1000
        )
      : null;

  const statusLabel =
    connectionStatus === "connected"
      ? "실시간 연결"
      : connectionStatus === "checking"
      ? "상태 확인 중"
      : connectionStatus === "error"
      ? "연결 오류"
      : "연결 끊김";

  const statusColor =
    connectionStatus === "connected"
      ? "bg-emerald-500/10 text-emerald-600"
      : connectionStatus === "checking"
      ? "bg-blue-500/10 text-blue-600"
      : "bg-red-500/10 text-red-600";

  const statusDot =
    connectionStatus === "connected"
      ? "bg-emerald-500 animate-pulse"
      : connectionStatus === "checking"
      ? "bg-blue-500 animate-pulse"
      : "bg-red-500";

  // -------------------------------------------------------
  // 영상 패널
  // -------------------------------------------------------

  const streamUrl = apiUrl(
    `/api/v1/vision/stream/${activeTab}`
  );

  const activeFrameId =
    activeTab === "raw" ? rawFrameId : processedFrameId;

  const activeTitle =
    activeTab === "raw" ? "원본 영상" : "AI 처리 영상";

  const activeDescription =
    activeTab === "raw"
      ? "AI 처리 전 카메라 영상"
      : "사람 감지 결과 및 분석 정보가 표시된 영상";

  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-raised shadow-sm">
      {/* 헤더 */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-500/10 text-blue-600">
            <Camera className="h-5 w-5" />
          </div>

          <div>
            <h2 className="font-bold text-ink">
              Vision 실시간 모니터링
            </h2>
            <p className="text-xs text-ink-3">
              원본 카메라 및 AI 영상 분석 모니터링
            </p>
          </div>
        </div>

        <div
          className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-bold ${statusColor}`}
        >
          <span className={`h-2 w-2 rounded-full ${statusDot}`} />
          {statusLabel}
        </div>
      </div>

      <div className="space-y-4 p-4 sm:p-5">
        {/* 오류 메시지 */}
        {errorMessage && (
          <div className="flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/5 p-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
            <p className="text-sm text-red-500">{errorMessage}</p>
          </div>
        )}

        {/* 영상 탭 */}
        <div className="overflow-hidden rounded-xl border border-line bg-black">
          <div className="flex items-center justify-between gap-3 border-b border-line bg-raised p-2">
            <div className="flex flex-1 gap-2">
              <button
                type="button"
                onClick={() => setActiveTab("raw")}
                className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-3 text-sm font-bold transition-colors ${
                  activeTab === "raw"
                    ? "bg-blue-600 text-white shadow-sm"
                    : "text-ink-2 hover:bg-line"
                }`}
              >
                <Camera className="h-4 w-4" />
                원본 영상
              </button>

              <button
                type="button"
                onClick={() => setActiveTab("processed")}
                className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-3 text-sm font-bold transition-colors ${
                  activeTab === "processed"
                    ? "bg-blue-600 text-white shadow-sm"
                    : "text-ink-2 hover:bg-line"
                }`}
              >
                <Activity className="h-4 w-4" />
                AI 처리 영상
              </button>
            </div>

            <div className="hidden items-center gap-1.5 px-2 text-xs font-semibold text-emerald-500 sm:flex">
              {isConnected ? (
                <>
                  <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                  LIVE
                </>
              ) : (
                <>
                  <span className="h-2 w-2 rounded-full bg-red-500" />
                  OFFLINE
                </>
              )}
            </div>
          </div>

          {/* 현재 선택한 영상 */}
          <div className="border-b border-white/10 bg-raised px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-bold text-ink">
                  {activeTitle}
                </h3>
                <p className="mt-0.5 text-xs text-ink-3">
                  {activeDescription}
                </p>
              </div>

              <span
                className={`rounded-full px-2.5 py-1 text-xs font-bold ${
                  isConnected
                    ? "bg-emerald-500/10 text-emerald-500"
                    : "bg-red-500/10 text-red-500"
                }`}
              >
                {isConnected ? "실시간 수신 중" : "연결 대기"}
              </span>
            </div>
          </div>

          <div className="relative aspect-video w-full bg-black">
            {isConnected ? (
              <img
                key={`${activeTab}-${streamRefresh}`}
                src={streamUrl}
                crossOrigin="use-credentials"
                alt={activeTitle}
                className="h-full w-full object-contain"
                onError={() => {
                  setErrorMessage(
                    `${activeTitle} 스트림을 불러오지 못했습니다.`
                  );
                }}
              />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4 text-center">
                <VideoOff className="h-10 w-10 text-gray-500" />
                <div>
                  <p className="text-sm font-semibold text-white">
                    영상 수신 대기 중
                  </p>
                  <p className="mt-1 text-xs text-gray-400">
                    Vision 연결 후 영상이 표시됩니다.
                  </p>
                </div>
              </div>
            )}

            {isConnected && (
              <div className="absolute bottom-3 left-3 flex items-center gap-2 rounded-lg bg-black/70 px-3 py-2 text-xs font-medium text-white">
                <ShieldCheck className="h-4 w-4 text-emerald-400" />
                Frame #{activeFrameId ?? "-"}
              </div>
            )}
          </div>
        </div>

        {/* 분석 정보 */}
        <div>
          <div className="mb-3 flex items-center gap-2">
            <Activity className="h-4 w-4 text-blue-500" />
            <h3 className="text-sm font-bold text-ink">
              실시간 분석 정보
            </h3>
          </div>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="rounded-xl border border-line bg-base p-3">
              <p className="text-xs text-ink-3">AI 추론 시간</p>
              <p className="mt-1 text-xl font-bold tabular-nums text-ink">
                {inferenceMs !== null
                  ? `${inferenceMs.toFixed(1)} ms`
                  : "-"}
              </p>
            </div>

            <div className="rounded-xl border border-line bg-base p-3">
              <p className="text-xs text-ink-3">
                마지막 프레임 수신 후
              </p>
              <p className="mt-1 text-xl font-bold tabular-nums text-ink">
                {frameAgeMs !== null
                  ? `${frameAgeMs.toFixed(0)} ms`
                  : "-"}
              </p>
            </div>

            <div className="rounded-xl border border-line bg-base p-3">
              <p className="text-xs text-ink-3">
                촬영 후 경과 시간
              </p>
              <p className="mt-1 text-xl font-bold tabular-nums text-ink">
                {captureAgeMs !== null
                  ? `${captureAgeMs.toFixed(0)} ms`
                  : "-"}
              </p>
            </div>

            <div className="rounded-xl border border-line bg-base p-3">
              <p className="text-xs text-ink-3">
                프레임 번호 차이
              </p>
              <p className="mt-1 text-xl font-bold tabular-nums text-ink">
                {frameDifference !== null ? frameDifference : "-"}
              </p>
            </div>
          </div>
        </div>

        {/* 프레임 정보 */}
        <div className="rounded-xl border border-line bg-base p-4">
          <div className="mb-3 flex items-center gap-2">
            <Video className="h-4 w-4 text-blue-500" />
            <h3 className="text-sm font-bold text-ink">
              프레임 수신 정보
            </h3>
          </div>

          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-xs text-ink-3">원본 프레임</p>
              <p className="mt-1 font-semibold tabular-nums text-ink">
                {rawFrameId !== null ? `#${rawFrameId}` : "대기 중"}
              </p>
            </div>

            <div>
              <p className="text-xs text-ink-3">AI 처리 프레임</p>
              <p className="mt-1 font-semibold tabular-nums text-ink">
                {processedFrameId !== null
                  ? `#${processedFrameId}`
                  : "대기 중"}
              </p>
            </div>
          </div>

          <div className="mt-3 border-t border-line pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-3">
              <span className="flex items-center gap-1.5">
                <Clock3 className="h-3.5 w-3.5" />
                마지막 상태 갱신
              </span>

              <span>
                {lastUpdated
                  ? new Date(lastUpdated).toLocaleTimeString("ko-KR")
                  : "아직 갱신되지 않음"}
              </span>
            </div>
          </div>
        </div>

        {/* 하단 버튼 */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-ink-3">
            {isConnected ? (
              <>
                <Wifi className="h-4 w-4 text-emerald-500" />
                Vision 서버에서 영상 데이터를 수신하고 있습니다.
              </>
            ) : (
              <>
                <WifiOff className="h-4 w-4 text-red-500" />
                Vision 서버 연결 상태를 확인해 주세요.
              </>
            )}
          </div>

          <button
            type="button"
            onClick={refreshStreams}
            className="flex items-center gap-2 rounded-lg border border-line px-4 py-2 text-sm font-bold text-ink-2 transition-colors hover:bg-line"
          >
            <RefreshCw className="h-4 w-4" />
            영상 새로고침
          </button>
        </div>
      </div>
    </section>
  );
}
