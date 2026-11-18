
"use client";

import React from "react";
import {
  Mic,
  Lock,
  LockOpen,
  Power,
  CalendarCheck,
  Cpu,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";
import { Device, Reservation } from "@/types";

interface OpsSummaryProps {
  devices: Device[];
  reservations: Reservation[];
  isConnected: boolean;
}

type Tone = "ok" | "busy" | "warn" | "idle";

const TONE: Record<Tone, string> = {
  ok: "bg-free-soft text-free border-free/30",
  busy: "bg-brass-soft text-brass border-brass/30",
  warn: "bg-live-soft text-live border-live/30",
  idle: "bg-raised text-ink-3 border-line",
};

function todayString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function Tile({
  icon: Icon,
  label,
  value,
  note,
  tone,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  note?: string;
  tone: Tone;
}) {
  return (
    <div className="bg-surface border border-line rounded-xl p-4 flex items-start gap-3.5 min-w-0">
      <span className={`w-11 h-11 shrink-0 rounded-lg border flex items-center justify-center ${TONE[tone]}`}>
        <Icon className="w-5 h-5" aria-hidden />
      </span>

      <div className="min-w-0">
        <p className="text-xs font-semibold tracking-wide uppercase text-ink-3 truncate">
          {label}
        </p>

        <p className="text-base font-bold text-ink truncate mt-0.5">
          {value}
        </p>

        {note && (
          <p className="text-xs text-ink-3 truncate mt-1">
            {note}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * 운영 현황 요약 (관리자 화면 맨 위)
 */
export function OpsSummary({
  devices,
  reservations,
  isConnected,
}: OpsSummaryProps) {
  const find = (id: string) => devices.find((d) => d.id === id);
  const relay = find("relay_1");
  const door = find("door_lock_1");

  const inUse = relay?.current_state === "on";
  const unlocked =
    door?.current_state === "unlocked" ||
    door?.current_state === "open";

  const today = todayString();

  const todays = reservations.filter(
    (r) =>
      String(r.reservation_date ?? "").slice(0, 10) === today &&
      (r.status === "reserved" || r.status === "active")
  );

  const pending = devices.filter(
    (d) =>
      d.desired_state != null &&
      d.current_state != null &&
      d.desired_state !== d.current_state
  );

  return (
    <section
      aria-label="운영 현황 요약"
      className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5"
    >
      <Tile
        icon={Mic}
        label="부스"
        value={inUse ? "이용 중" : "비어 있음"}
        note={inUse ? "반주기 전원이 공급되고 있습니다" : "대기 상태"}
        tone={inUse ? "busy" : "ok"}
      />

      <Tile
        icon={unlocked ? LockOpen : Lock}
        label="도어락"
        value={unlocked ? "열림" : "잠김"}
        note={unlocked ? "입장 가능 상태" : "인증 대기"}
        tone={unlocked ? "busy" : "ok"}
      />

      <Tile
        icon={Power}
        label="기기 전원"
        value={relay?.current_state === "on" ? "ON" : "OFF"}
        note="반주기 · 앰프 릴레이"
        tone={relay?.current_state === "on" ? "busy" : "idle"}
      />

      <Tile
        icon={CalendarCheck}
        label="오늘 예약"
        value={`${todays.length}건`}
        note={
          todays.length
            ? todays.map((r) => r.student_name).join(", ")
            : "예약 없음"
        }
        tone={todays.length ? "busy" : "idle"}
      />

      <Tile
        icon={!isConnected ? AlertTriangle : pending.length ? Cpu : CheckCircle2}
        label="실기기 반영"
        value={
          !isConnected
            ? "서버 연결 끊김"
            : pending.length
            ? `${pending.length}건 미반영`
            : "지시대로 동작 중"
        }
        note={
          !isConnected
            ? "백엔드가 켜져 있는지 확인하세요"
            : pending.length
            ? pending.map((d) => `${d.name}: ${d.desired_state}`).join(" · ")
            : "모든 기기가 목표 상태와 일치"
        }
        tone={!isConnected ? "warn" : pending.length ? "warn" : "ok"}
      />
    </section>
  );
}
