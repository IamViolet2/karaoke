"use client";

import React from "react";
import Link from "next/link";
import { Settings } from "lucide-react";

import { AppHeader } from "@/components/layout/AppHeader";
import { BoothStatusCard } from "@/components/booth/BoothStatusCard";
import { ReservationSection } from "@/components/booth/ReservationSection";
import { useBoothData } from "@/hooks/useBoothData";

/**
 * `/` — 학생·관람객 화면
 *
 * 관람객은 부스 상태를 확인하고 예약 신청 및 예약권을 조회한다.
 * 부스 조작은 `/admin`에서 수행한다.
 */
export default function HomePage() {
  const {
    devices,
    reservations,
    isConnected,
    fetchReservations,
  } = useBoothData();

  return (
    <div className="theme-day min-h-screen bg-canvas text-ink">
      <AppHeader
        title="학교 노래방 부스"
        subtitle="예약하고 비밀번호로 입장하세요"
        devices={devices}
        isConnected={isConnected}
      />

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-5 space-y-5">
        {/* 부스 상태 */}
        <BoothStatusCard
          devices={devices}
          reservations={reservations}
          isConnected={isConnected}
        />

        {/* 예약권 및 예약 신청 */}
        <ReservationSection
          reservations={reservations}
          onReservationCreated={fetchReservations}
          sections="form"
        />
      </main>

      <footer className="max-w-3xl mx-auto px-4 sm:px-6 py-8 mt-8 border-t border-line text-center text-xs text-ink-3 space-y-2">
        <p>웹 예약 연동 자동화 학교 노래방 부스 관리 시스템</p>
        <p>백승환(H/W조장) · 조민규(H/W기구) · 김민제(BE/FE) · 박민성(BE/FE)</p>
        <Link
          href="/admin"
          className="inline-flex items-center gap-1.5 mt-1 text-ink-3 hover:text-ink transition-colors"
        >
          <Settings className="w-3 h-3" aria-hidden />
          관리자
        </Link>
      </footer>
    </div>
  );
}