"use client";

import React, { useEffect, useState } from "react";
import {
  Mic2,
  Loader2,
  Trophy,
  Crown,
  Flame,
  Clock,
  CalendarCheck,
  School,
} from "lucide-react";
import { ScoreRecord } from "@/types";
import { RemainingClock } from "@/components/booth/SessionStrip";
import { BoothSessionState, endsAtLabel } from "@/hooks/useBoothSession";

interface PopularSong {
  id: string;
  title: string;
  singer: string;
}

interface AttractScreenProps {
  mode: "standby" | "ready";
  keypad?: React.ReactNode;
  session?: BoothSessionState | null;
  topToday: ScoreRecord[];
  topAll: ScoreRecord[];
  anthemTop?: ScoreRecord[];
  popularSongs: PopularSong[];
  nickname: string;
  onNicknameChange: (value: string) => void;
  onEnter: () => void;
  onEnterWithoutMic: () => void;
  isEntering: boolean;
  enterNotice: string | null;
}

const PANELS = [
  { key: "anthem", label: "오늘의 교가 순위", icon: School },
  { key: "today", label: "오늘의 순위", icon: Flame },
  { key: "all", label: "명예의 전당", icon: Crown },
  { key: "songs", label: "인기 애창곡", icon: Trophy },
] as const;

const ROTATE_MS = 8000;

export function AttractScreen({
  mode,
  keypad,
  session = null,
  topToday,
  topAll,
  anthemTop = [],
  popularSongs,
  nickname,
  onNicknameChange,
  onEnter,
  onEnterWithoutMic,
  isEntering,
  enterNotice,
}: AttractScreenProps) {
  const [panelIndex, setPanelIndex] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setPanelIndex((i) => (i + 1) % PANELS.length);
    }, ROTATE_MS);

    return () => clearInterval(id);
  }, [panelIndex]);

  const panel = PANELS[panelIndex];

  const rows: ScoreRecord[] =
    panel.key === "anthem"
      ? anthemTop
      : panel.key === "today"
        ? topToday
        : panel.key === "all"
          ? topAll
          : [];

  const compact = rows.length > 5;

  return (
    <section
      aria-label="노래방 부스 안내"
      className="rounded-2xl bg-surface border border-line overflow-hidden"
    >
      <div className="grid lg:grid-cols-5 lg:min-h-[68vh]">
        {/* 왼쪽: 부스 안내 */}
        <div className="lg:col-span-3 p-7 sm:p-10 flex flex-col justify-center gap-6">
          {mode === "standby" ? (
            <>
              <div>
                <p className="text-xs font-semibold tracking-[0.2em] uppercase text-brass">
                  스마트 학교 노래방 부스
                </p>

                <h2 className="mt-2 text-4xl sm:text-5xl font-extrabold tracking-tight text-ink leading-[1.1]">
                  지금 비어 있습니다
                </h2>

                <p className="mt-4 text-base text-ink-2 leading-relaxed max-w-xl">
                  예약한{" "}
                  <strong className="text-ink">4자리 비밀번호</strong>를
                  키패드에 누르면 문이 열리고 노래방 전원이 켜집니다.
                  예약 시간 10분 전부터 들어갈 수 있습니다.
                </p>
              </div>

              <div className="flex flex-wrap items-start gap-5">
                {keypad}

                <div className="flex items-start gap-3 p-4 rounded-2xl bg-raised border border-line max-w-xs">
                  <CalendarCheck
                    className="w-5 h-5 text-brass shrink-0 mt-0.5"
                    aria-hidden
                  />

                  <p className="text-sm text-ink-2 leading-relaxed">
                    예약은 폰으로{" "}
                    <strong className="text-ink">예약 화면</strong>에서
                    신청하세요.
                  </p>
                </div>
              </div>
            </>
          ) : (
            <>
              <div>
                <p className="text-xs font-semibold tracking-[0.2em] uppercase text-free">
                  인증 완료 · 문이 열렸습니다
                </p>

                <h2 className="mt-2 text-4xl sm:text-5xl font-extrabold tracking-tight text-ink leading-[1.1]">
                  {session?.user_name
                    ? `${session.user_name}님, 환영합니다!`
                    : "환영합니다!"}
                </h2>

                <p className="mt-4 text-base text-ink-2 leading-relaxed max-w-xl">
                  노래방 전원이 켜졌습니다. 아래 버튼을 누르면 마이크를
                  준비하고 노래방을 엽니다.
                </p>

                {endsAtLabel(session) && (
                  <p className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-raised border border-line text-sm text-ink-2">
                    <Clock
                      className="w-4 h-4 text-ink-3"
                      aria-hidden
                    />

                    <strong className="text-ink">
                      {endsAtLabel(session)}
                    </strong>
                    까지 · 남은 시간{" "}
                    <strong className="text-ink">
                      <RemainingClock session={session} />
                    </strong>
                  </p>
                )}
              </div>

              <div className="space-y-3 max-w-md">
                <label
                  htmlFor="attract-nickname"
                  className="block text-sm font-bold text-ink"
                >
                  순위에 올릴 이름
                  <span className="ml-2 font-normal text-ink-3">
                    (바꿔도 됩니다)
                  </span>
                </label>

                <input
                  id="attract-nickname"
                  value={nickname}
                  onChange={(e) =>
                    onNicknameChange(e.target.value.slice(0, 10))
                  }
                  placeholder="별명 (최대 10자)"
                  maxLength={10}
                  className="w-full px-4 py-3 rounded-xl bg-raised border border-line-strong text-ink placeholder-ink-3 outline-none"
                />

                <div className="flex flex-wrap items-center gap-3 pt-1">
                  <button
                    onClick={onEnter}
                    disabled={isEntering}
                    className="px-6 py-3.5 rounded-xl bg-brass hover:bg-brass/90 disabled:opacity-60 disabled:cursor-not-allowed text-on-accent font-extrabold text-base transition-colors cursor-pointer inline-flex items-center gap-2"
                  >
                    {isEntering ? (
                      <>
                        <Loader2
                          className="w-5 h-5 animate-spin"
                          aria-hidden
                        />
                        준비 중…
                      </>
                    ) : (
                      <>
                        <Mic2 className="w-5 h-5" aria-hidden />
                        노래방 시작하기
                      </>
                    )}
                  </button>

                  <button
                    onClick={onEnterWithoutMic}
                    disabled={isEntering}
                    className="text-sm text-ink-3 hover:text-ink underline underline-offset-4 cursor-pointer disabled:opacity-60"
                  >
                    마이크 없이 시작
                  </button>
                </div>

                {enterNotice && (
                  <p className="text-sm text-brass">{enterNotice}</p>
                )}
              </div>
            </>
          )}
        </div>

        {/* 오른쪽: 순환 순위 패널 */}
        <div className="lg:col-span-2 bg-raised border-t lg:border-t-0 lg:border-l border-line p-6 sm:p-8 flex flex-col">
          <div className="flex items-center gap-2 mb-4">
            <panel.icon
              className="w-5 h-5 text-brass shrink-0"
              aria-hidden
            />

            <h3 className="text-lg font-bold text-ink">
              {panel.label}
            </h3>
          </div>

          <div className="flex-1 min-h-[16rem]">
            {panel.key === "songs" ? (
              <ol className="space-y-2.5">
                {popularSongs.slice(0, 5).map((song, i) => (
                  <li
                    key={song.id}
                    className="flex items-center gap-3"
                  >
                    <span className="w-7 h-7 shrink-0 rounded-lg bg-surface border border-line flex items-center justify-center font-mono tnum text-sm font-bold text-ink-3">
                      {i + 1}
                    </span>

                    <span className="min-w-0">
                      <span className="block text-base font-bold text-ink truncate">
                        {song.title}
                      </span>

                      <span className="block text-xs text-ink-3 truncate">
                        {song.singer}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            ) : rows.length === 0 ? (
              <p className="text-sm text-ink-3 leading-relaxed pt-2">
                {panel.key === "anthem"
                  ? "아직 교가 기록이 없습니다. 교가를 불러 1등에 도전하세요! 상품이 있습니다."
                  : panel.key === "today"
                    ? "오늘은 아직 기록이 없습니다. 첫 번째 주인공이 되어 보세요."
                    : "아직 등록된 기록이 없습니다."}
              </p>
            ) : (
              <ol className={compact ? "space-y-1" : "space-y-2.5"}>
                {rows.map((row, i) => (
                  <li
                    key={row.id}
                    className={`flex items-center gap-3 px-3 ${
                      compact ? "py-1" : "py-2.5"
                    } rounded-xl border ${
                      i === 0
                        ? "bg-brass-soft border-brass/35"
                        : "bg-surface border-line"
                    }`}
                  >
                    <span
                      className={`w-7 h-7 shrink-0 rounded-lg flex items-center justify-center font-mono tnum text-sm font-bold ${
                        i === 0
                          ? "bg-brass text-on-accent"
                          : "bg-raised text-ink-3"
                      }`}
                    >
                      {i + 1}
                    </span>

                    <span
                      className={`min-w-0 flex-1 ${
                        compact ? "flex items-baseline gap-2" : ""
                      }`}
                    >
                      <span
                        className={`${
                          compact ? "" : "block "
                        }text-base font-bold text-ink truncate`}
                      >
                        {row.nickname}
                      </span>

                      <span
                        className={`${
                          compact ? "shrink-0 " : "block "
                        }text-xs text-ink-3 truncate`}
                      >
                        {panel.key === "anthem"
                          ? row.rank_label
                            ? `등급 ${row.rank_label}`
                            : "교가"
                          : row.title}
                      </span>
                    </span>

                    <span
                      className={`font-mono tnum ${
                        compact ? "text-xl" : "text-2xl"
                      } font-extrabold text-ink shrink-0`}
                    >
                      {row.score}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>

          <div className="flex items-center justify-center gap-2 pt-5">
            {PANELS.map((p, i) => (
              <button
                key={p.key}
                onClick={() => setPanelIndex(i)}
                aria-label={`${p.label} 보기`}
                aria-current={i === panelIndex}
                className={`h-2 rounded-full transition-all cursor-pointer ${
                  i === panelIndex
                    ? "w-7 bg-brass"
                    : "w-2 bg-line-strong hover:bg-ink-3"
                }`}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}