
"use client";

import React, { useMemo, useState, useSyncExternalStore } from "react";
import {
  Calendar,
  Clock,
  User,
  Users,
  Building,
  KeyRound,
  AlertCircle,
  CheckCircle2,
  Copy,
  ArrowRight,
  Trash2,
} from "lucide-react";
import { Reservation } from "@/types";
import { apiUrl } from "@/utils/apiConfig";
import { localDateString } from "@/utils/localDate";
import {
  subscribeVoucher,
  getVoucherSnapshot,
  getVoucherServerSnapshot,
  saveVoucher,
  clearVoucher,
  isExpired,
} from "@/utils/voucherStore";

interface ReservationSectionProps {
  reservations: Reservation[];
  onReservationCreated: () => void;
  /**
   * 선생님이 학생 대신 키패드에 PIN을 넣는 동작 (`/admin` 예약 목록의 [대신 입력]).
   * 학생이 비밀번호를 잃어버렸거나 시연할 때 쓴다. 키패드와 같은 API를 부른다.
   * 관리자 화면에서만 내려온다.
   */
  onRemoteEntry?: (pin: string) => Promise<{ success: boolean; message?: string }>;
  /**
   * 화면마다 필요한 부분이 다르다 (부록G §3-3).
   *   form  `/`      관람객은 신청만 한다
   *   list  `/admin` 선생님은 현황 확인이 일이다
   *   both  (기본)   예전처럼 둘 다
   */
  sections?: "both" | "form" | "list";
}

export function ReservationSection({
  reservations,
  onReservationCreated,
  onRemoteEntry,
  sections = "both",
}: ReservationSectionProps) {
  const showForm = sections !== "list";
  const showList = sections !== "form";

  // Form State
  const [grade, setGrade] = useState<number>(2);
  const [department, setDepartment] = useState<string>("전자제어과");
  const [studentName, setStudentName] = useState<string>("");
  const [userCount, setUserCount] = useState<number>(4);
  const [reservationDate, setReservationDate] = useState<string>("");
  const [timeSlot, setTimeSlot] = useState<"lunch" | "dinner">("lunch");

  // Status & Voucher State
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  // 발급된 PIN은 컴포넌트 상태가 아니라 보관소에 둔다.
  const voucherRaw = useSyncExternalStore(
    subscribeVoucher,
    getVoucherSnapshot,
    getVoucherServerSnapshot
  );

  const issuedVoucher = useMemo<Reservation | null>(() => {
    if (!voucherRaw) return null;
    try {
      const parsed = JSON.parse(voucherRaw) as Reservation;
      return isExpired(parsed) ? null : parsed;
    } catch {
      return null;
    }
  }, [voucherRaw]);

  const [copied, setCopied] = useState<boolean>(false);

  // [대신 입력] 결과
  const [remoteNotice, setRemoteNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [remoteBusyId, setRemoteBusyId] = useState<number | null>(null);

  const handleRemoteEntry = async (r: Reservation) => {
    if (!onRemoteEntry || !r.pin_code) return;

    const ok = window.confirm(
      `${r.student_name} 학생 대신 비밀번호를 입력합니다.\n` +
        "지금이 그 예약 시간이면 부스 문이 열리고 노래방 전원이 켜집니다."
    );

    if (!ok) return;

    setRemoteBusyId(r.id);

    try {
      const result = await onRemoteEntry(r.pin_code);

      setRemoteNotice({
        ok: result.success,
        text: result.message ?? (result.success ? "인증되었습니다." : "인증하지 못했습니다."),
      });
    } catch {
      setRemoteNotice({
        ok: false,
        text: "원격 인증 중 오류가 발생했습니다.",
      });
    } finally {
      setRemoteBusyId(null);
    }
  };

  // 오늘 날짜를 기준으로 과거 날짜만 선택할 수 없도록 한다.
  const todayStr = localDateString(0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    // 과거 날짜 예약만 차단한다. 당일 예약은 허용한다.
    if (!reservationDate || reservationDate < todayStr) {
      setErrorMessage("과거 날짜는 예약할 수 없습니다. 오늘 이후의 날짜를 선택해 주세요.");
      return;
    }

    if (!studentName.trim()) {
      setErrorMessage("신청자 이름을 입력해 주세요.");
      return;
    }

    setIsSubmitting(true);

    try {
      const res = await fetch(apiUrl("/api/reservations"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grade: Number(grade),
          department,
          student_name: studentName.trim(),
          user_count: Number(userCount),
          reservation_date: reservationDate,
          time_slot: timeSlot,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setErrorMessage(data?.error?.message || "예약 신청 중 오류가 발생했습니다.");
        return;
      }

      saveVoucher(data.data);
      setStudentName("");
      onReservationCreated();
    } catch {
      setErrorMessage("서버와 통신할 수 없습니다. 백엔드 구동 상태를 확인하세요.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const copyPin = (pin: string) => {
    navigator.clipboard.writeText(pin);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-8">
      {/*
        내 예약권 — 관람객 화면에서 가장 중요한 물건이다.
        예약을 마치고 부스 앞까지 가는 동안 필요한 건 4자리 숫자 하나뿐이므로,
        그 숫자를 화면에서 가장 큰 요소로 두고 나머지는 전부 뒤로 물린다.
        관리자 화면(list 전용)에서는 띄우지 않는다.
      */}
      {showForm && issuedVoucher && (
        <div className="rounded-2xl bg-surface border border-free/40 overflow-hidden shadow-sm">
          <div className="px-5 py-2.5 bg-free-soft border-b border-free/25 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-free shrink-0" />
            <span className="text-xs font-bold text-free">
              예약 완료 · 입장 비밀번호가 발급되었습니다
            </span>
          </div>

          <div className="p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center gap-5">
            <div className="min-w-0 flex-1">
              <p className="text-xs text-ink-3">
                {issuedVoucher.student_name} · {issuedVoucher.user_count}명
              </p>
              <p className="text-base font-bold text-ink mt-0.5">
                {String(issuedVoucher.reservation_date).slice(0, 10)}{" "}
                {issuedVoucher.time_slot === "lunch" ? "점심 타임" : "저녁 타임"}
              </p>
              <p className="text-xs text-ink-3 mt-0.5">
                {issuedVoucher.time_slot === "lunch" ? "12:30 ~ 13:20" : "17:30 ~ 18:30"}
              </p>
            </div>

            <div className="shrink-0 text-center sm:text-right">
              <span className="block text-[11px] font-semibold tracking-wider uppercase text-ink-3">
                입장 비밀번호
              </span>
              <span className="block font-mono tnum text-5xl sm:text-6xl font-extrabold tracking-[0.18em] text-ink leading-none mt-1">
                {issuedVoucher.pin_code ?? "----"}
              </span>
            </div>
          </div>

          <div className="px-5 sm:px-6 pb-5 space-y-3">
            <p className="text-sm text-ink-2 flex items-start gap-2">
              <ArrowRight className="w-4 h-4 shrink-0 mt-0.5 text-free" />
              <span>
                이용 시간(시작 10분 전부터)에{" "}
                <strong className="text-ink">부스 앞 키패드</strong>로 이 네 자리를 누르면 문이 열립니다.
                <strong className="text-ink"> 한 번만 쓸 수 있으니</strong> 다른 사람에게 알려주지 마세요.
              </span>
            </p>

            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => copyPin(issuedVoucher.pin_code ?? "")}
                className="px-3 py-2 rounded-lg bg-raised hover:bg-line-strong border border-line text-ink text-xs font-bold transition-colors cursor-pointer inline-flex items-center gap-1.5"
              >
                {copied ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-free" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
                {copied ? "복사했습니다" : "비밀번호 복사"}
              </button>

              <button
                onClick={clearVoucher}
                className="px-3 py-2 rounded-lg text-ink-3 hover:text-live text-xs font-semibold transition-colors cursor-pointer inline-flex items-center gap-1.5 ml-auto"
                title="이 기기에서 예약권을 지웁니다"
              >
                <Trash2 className="w-3.5 h-3.5" />
                지우기
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 신청 폼과 현황 목록 */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {showForm && (
          <div
            className={`${showList ? "lg:col-span-5" : "lg:col-span-12"} bg-surface/90 border border-line rounded-2xl p-6 shadow-xl space-y-6`}
          >
            <div className="border-b border-line pb-4">
              <h3 className="text-lg font-bold text-ink flex items-center gap-2">
                <Calendar className="w-5 h-5 text-brass" />
                학교 노래방 부스 예약 신청
              </h3>
              <p className="text-xs text-ink-3 mt-1">
                동일 시간대 중복 예약은 방지됩니다.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              {errorMessage && (
                <div className="p-3 rounded-lg bg-live-soft/50 border border-live/50 text-live text-xs flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{errorMessage}</span>
                </div>
              )}

              {/* Grade & Department */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-ink-2 mb-1.5">
                    학년
                  </label>
                  <select
                    value={grade}
                    onChange={(e) => setGrade(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-lg bg-raised border border-line-strong text-ink text-xs focus:ring-2 focus:ring-brass outline-none"
                  >
                    <option value={1}>1학년</option>
                    <option value={2}>2학년</option>
                    <option value={3}>3학년</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-ink-2 mb-1.5 flex items-center gap-1">
                    <Building className="w-3.5 h-3.5 text-ink-3" />
                    학과
                  </label>
                  <select
                    value={department}
                    onChange={(e) => setDepartment(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-raised border border-line-strong text-ink text-xs focus:ring-2 focus:ring-brass outline-none"
                  >
                    <option value="전자제어과">전자제어과</option>
                    <option value="전자회로과">전자회로과</option>
                    <option value="정보통신과">정보통신과</option>
                    <option value="인공지능전자과">인공지능전자과</option>
                  </select>
                </div>
              </div>

              {/* Student Name & User Count */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-ink-2 mb-1.5 flex items-center gap-1">
                    <User className="w-3.5 h-3.5 text-ink-3" />
                    신청자 이름
                  </label>
                  <input
                    type="text"
                    placeholder="예: 김민제"
                    value={studentName}
                    onChange={(e) => setStudentName(e.target.value)}
                    minLength={2}
                    maxLength={50}
                    className="w-full px-3 py-2 rounded-lg bg-raised border border-line-strong text-ink text-xs focus:ring-2 focus:ring-brass outline-none placeholder:text-ink-3"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-ink-2 mb-1.5 flex items-center gap-1">
                    <Users className="w-3.5 h-3.5 text-ink-3" />
                    이용 인원 (최대 10명)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={userCount}
                    onChange={(e) => setUserCount(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-lg bg-raised border border-line-strong text-ink text-xs focus:ring-2 focus:ring-brass outline-none"
                    required
                  />
                </div>
              </div>

              {/* Date Picker */}
              <div>
                <label className="block text-xs font-semibold text-ink-2 mb-1.5 flex items-center justify-between">
                  <span className="flex items-center gap-1">
                    <Calendar className="w-3.5 h-3.5 text-ink-3" />
                    예약 일자 선택
                  </span>
                </label>
                <input
                  type="date"
                  min={todayStr}
                  value={reservationDate}
                  onChange={(e) => setReservationDate(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-raised border border-line-strong text-ink text-xs focus:ring-2 focus:ring-brass outline-none"
                  required
                />
              </div>

              {/* Time Slot Selection */}
              <div>
                <label className="block text-xs font-semibold text-ink-2 mb-1.5 flex items-center gap-1">
                  <Clock className="w-3.5 h-3.5 text-ink-3" />
                  타임슬롯
                </label>

                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setTimeSlot("lunch")}
                    className={`p-3 rounded-xl border text-left transition-all cursor-pointer ${
                      timeSlot === "lunch"
                        ? "bg-brass-soft/60 border-brass text-ink shadow-md"
                        : "bg-raised/40 border-line-strong text-ink-3 hover:text-ink"
                    }`}
                  >
                    <span className="text-xs font-bold block">점심 타임</span>
                    <span className="text-[10px] text-ink-3">
                      12:30 ~ 13:20 (50분)
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setTimeSlot("dinner")}
                    className={`p-3 rounded-xl border text-left transition-all cursor-pointer ${
                      timeSlot === "dinner"
                        ? "bg-brass-soft/60 border-brass text-ink shadow-md"
                        : "bg-raised/40 border-line-strong text-ink-3 hover:text-ink"
                    }`}
                  >
                    <span className="text-xs font-bold block">저녁 타임</span>
                    <span className="text-[10px] text-ink-3">
                      17:30 ~ 18:30 (60분)
                    </span>
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full py-3 rounded-xl bg-brass hover:bg-brass/90 active:bg-brass/80 text-on-accent text-xs font-bold transition-all shadow-lg active:scale-98 cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50 mt-2"
              >
                {isSubmitting ? "예약 처리 중..." : "예약 신청 및 비밀번호 발급"}
              </button>
            </form>
          </div>
        )}

        {showList && (
          <div
            className={`${showForm ? "lg:col-span-7" : "lg:col-span-12"} bg-surface/90 border border-line rounded-2xl p-6 shadow-xl space-y-4`}
          >
            <div className="flex items-center justify-between border-b border-line pb-4">
              <div>
                <h3 className="text-lg font-bold text-ink flex items-center gap-2">
                  <KeyRound className="w-5 h-5 text-free" />
                  노래방 예약 현황 목록
                </h3>
                <p className="text-xs text-ink-3 mt-0.5">
                  등록된 예약 정보와 발급된 4자리 일회성 비밀번호를 확인합니다.
                </p>
              </div>

              <span className="whitespace-nowrap text-xs font-semibold px-2.5 py-1 rounded bg-raised text-ink-2">
                총 {reservations.length}건
              </span>
            </div>

            {remoteNotice && (
              <div
                className={`p-3 rounded-lg border text-xs flex items-start gap-2 ${
                  remoteNotice.ok
                    ? "bg-free-soft/50 border-free/50 text-free"
                    : "bg-live-soft/50 border-live/50 text-live"
                }`}
                role="status"
              >
                {remoteNotice.ok ? (
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                ) : (
                  <AlertCircle className="w-4 h-4 shrink-0" />
                )}

                <span className="flex-1">{remoteNotice.text}</span>

                <button
                  onClick={() => setRemoteNotice(null)}
                  className="text-ink-3 hover:text-ink cursor-pointer"
                  aria-label="닫기"
                >
                  ✕
                </button>
              </div>
            )}

            <div className="overflow-x-auto">
              {reservations.length === 0 ? (
                <div className="py-12 text-center text-ink-3 text-xs">
                  아직 예약이 없습니다. 학생은 예약 화면(/)에서 신청합니다.
                </div>
              ) : (
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-line text-ink-3 text-[11px]">
                      <th className="pb-2 font-medium">예약일 / 타임</th>
                      <th className="pb-2 font-medium">신청자</th>
                      <th className="pb-2 font-medium">인원</th>
                      <th className="pb-2 font-medium">상태</th>
                      <th className="pb-2 font-medium">비밀번호 (OTP)</th>
                      <th className="pb-2 font-medium text-right">원격 인증</th>
                    </tr>
                  </thead>

                  <tbody className="divide-y divide-line/60">
                    {reservations.map((r) => (
                      <tr key={r.id} className="hover:bg-raised/30 transition-colors">
                        <td className="py-3 font-mono text-ink-2">
                          {r.reservation_date}
                          <span className="block text-[10px] text-ink-3">
                            {r.time_slot === "lunch"
                              ? "점심 (12:30~13:20)"
                              : "저녁 (17:30~18:30)"}
                          </span>
                        </td>

                        <td className="py-3">
                          <span className="font-semibold text-ink">
                            {r.student_name}
                          </span>
                          <span className="block text-[10px] text-ink-3">
                            {r.grade}학년 {r.department}
                          </span>
                        </td>

                        <td className="py-3 text-ink-2">{r.user_count}명</td>

                        <td className="py-3">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${
                              r.status === "active"
                                ? "bg-free-soft border-free text-free"
                                : r.status === "completed"
                                  ? "bg-raised border-line-strong text-ink-3"
                                  : r.status === "no_show" || r.status === "cancelled"
                                    ? "bg-live-soft border-live/40 text-live"
                                    : "bg-brass-soft border-brass text-brass"
                            }`}
                          >
                            {r.status === "active"
                              ? "이용 중"
                              : r.status === "completed"
                                ? "이용 완료"
                                : r.status === "no_show"
                                  ? "노쇼 취소"
                                  : r.status === "cancelled"
                                    ? "취소됨"
                                    : "예약됨"}
                          </span>
                        </td>

                        <td className="py-3">
                          <span className="font-mono font-bold text-free bg-canvas px-2 py-1 rounded border border-line">
                            {r.pin_code ?? "••••"}
                          </span>
                        </td>

                        <td className="py-3 text-right">
                          {/* 아직 쓰지 않은 예약만 */}
                          {onRemoteEntry && r.pin_code && r.status === "reserved" && (
                            <button
                              onClick={() => void handleRemoteEntry(r)}
                              disabled={remoteBusyId !== null}
                              title="학생 대신 부스 키패드에 이 비밀번호를 입력합니다"
                              className="px-2.5 py-1 rounded bg-raised hover:bg-line-strong/90 text-ink-2 text-[11px] border border-line-strong transition-colors cursor-pointer disabled:opacity-50"
                            >
                              {remoteBusyId === r.id ? "확인 중…" : "대신 입력"}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
