
"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Camera,
  CameraOff,
  RefreshCw,
  ShieldCheck,
  AlertTriangle,
} from "lucide-react";

type CameraStatus =
  | "idle"
  | "requesting"
  | "connected"
  | "error";

export function CctvPanel() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [status, setStatus] = useState<CameraStatus>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [cameraName, setCameraName] = useState("웹캠");

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setStatus("idle");
  }, []);

  const startCamera = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setErrorMessage(
        "이 브라우저에서는 카메라 기능을 사용할 수 없습니다. HTTPS 또는 localhost 환경인지 확인해 주세요."
      );
      setStatus("error");
      return;
    }

    stopCamera();
    setStatus("requesting");
    setErrorMessage("");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 },
        },
        audio: false,
      });

      streamRef.current = stream;

      const video = videoRef.current;

      if (!video) {
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        setStatus("idle");
        return;
      }

      video.srcObject = stream;

      const track = stream.getVideoTracks()[0];
      setCameraName(track?.label || "웹캠");

      track?.addEventListener(
        "ended",
        () => {
          if (streamRef.current === stream) {
            streamRef.current = null;
            setStatus("error");
            setErrorMessage("카메라 연결이 종료되었습니다.");
          }
        },
        { once: true }
      );

      await video.play();

      setStatus("connected");
    } catch (error) {
      console.error("CCTV 카메라 연결 실패:", error);

      const err = error as DOMException;

      if (err.name === "NotAllowedError") {
        setErrorMessage(
          "카메라 접근 권한이 거부되었습니다. 브라우저 설정에서 카메라 권한을 허용해 주세요."
        );
      } else if (
        err.name === "NotFoundError" ||
        err.name === "DevicesNotFoundError"
      ) {
        setErrorMessage("연결된 웹캠을 찾을 수 없습니다.");
      } else if (
        err.name === "NotReadableError" ||
        err.name === "TrackStartError"
      ) {
        setErrorMessage(
          "카메라를 사용할 수 없습니다. 다른 프로그램이 웹캠을 사용 중인지 확인해 주세요."
        );
      } else {
        setErrorMessage(
          err.message || "카메라 연결 중 알 수 없는 오류가 발생했습니다."
        );
      }

      stopCamera();
      setStatus("error");
    }
  }, [stopCamera]);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, []);

  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-raised shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-500/10 text-blue-600">
            <Camera className="h-5 w-5" />
          </div>

          <div>
            <h2 className="font-bold text-ink">실시간 CCTV</h2>
            <p className="text-xs text-ink-3">
              메인 PC 연결 웹캠 모니터링
            </p>
          </div>
        </div>

        <div
          className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-bold ${
            status === "connected"
              ? "bg-emerald-500/10 text-emerald-600"
              : status === "requesting"
              ? "bg-blue-500/10 text-blue-600"
              : status === "error"
              ? "bg-red-500/10 text-red-600"
              : "bg-gray-500/10 text-gray-500"
          }`}
        >
          <span
            className={`h-2 w-2 rounded-full ${
              status === "connected"
                ? "bg-emerald-500 animate-pulse"
                : status === "requesting"
                ? "bg-blue-500 animate-pulse"
                : status === "error"
                ? "bg-red-500"
                : "bg-gray-400"
            }`}
          />

          {status === "connected"
            ? "실시간 연결"
            : status === "requesting"
            ? "연결 중"
            : status === "error"
            ? "연결 오류"
            : "대기 중"}
        </div>
      </div>

      <div className="p-4 sm:p-5">
        <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-black">
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className={`h-full w-full object-contain ${
              status === "connected" ? "block" : "hidden"
            }`}
          />

          {status !== "connected" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-5 text-center">
              {status === "error" ? (
                <AlertTriangle className="h-10 w-10 text-red-400" />
              ) : status === "requesting" ? (
                <RefreshCw className="h-10 w-10 animate-spin text-blue-400" />
              ) : (
                <CameraOff className="h-10 w-10 text-gray-500" />
              )}

              <div>
                <p className="font-semibold text-white">
                  {status === "requesting"
                    ? "웹캠 연결 중..."
                    : status === "error"
                    ? "CCTV 연결에 실패했습니다."
                    : "CCTV가 꺼져 있습니다."}
                </p>

                {errorMessage && (
                  <p className="mt-2 max-w-lg text-sm text-red-300">
                    {errorMessage}
                  </p>
                )}

                {status === "idle" && (
                  <p className="mt-2 text-sm text-gray-400">
                    CCTV 시작 버튼을 눌러 영상을 확인하세요.
                  </p>
                )}
              </div>
            </div>
          )}

          {status === "connected" && (
            <div className="absolute bottom-3 left-3 flex items-center gap-2 rounded-lg bg-black/65 px-3 py-2 text-xs font-medium text-white">
              <ShieldCheck className="h-4 w-4 text-emerald-400" />
              {cameraName}
            </div>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-ink-3">
            {status === "connected"
              ? "카메라 영상이 관리자 화면에 표시되고 있습니다."
              : "관리자 인증 상태에서 카메라를 직접 시작할 수 있습니다."}
          </div>

          <div className="flex items-center gap-2">
            {status === "connected" ? (
              <button
                type="button"
                onClick={stopCamera}
                className="flex items-center gap-2 rounded-lg border border-line px-4 py-2 text-sm font-bold text-ink-2 transition-colors hover:bg-line"
              >
                <CameraOff className="h-4 w-4" />
                CCTV 종료
              </button>
            ) : (
              <button
                type="button"
                onClick={startCamera}
                disabled={status === "requesting"}
                className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {status === "requesting" ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <Camera className="h-4 w-4" />
                )}

                {status === "requesting"
                  ? "연결 중..."
                  : status === "error"
                  ? "다시 연결"
                  : "CCTV 시작"}
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
