
/**
 * 노래방 재생 소스 결정 로직
 *
 * 우선순위
 *   1) 로컬 미디어 파일 (public/media/karaoke/<id>.<ext>)
 *   2) 유튜브 영상
 *      ① 관리자가 등록한 영상
 *      ② 곡의 기본 후보 목록 순서대로
 *   3) 내장 신스 자동 반주
 *
 * 후보 목록을 여러 개 유지하는 이유:
 *   영상 하나가 삭제되거나 임베드가 차단되어도
 *   다음 후보 영상으로 넘어갈 수 있도록 한다.
 *
 * 관리자 등록본:
 *   서버에 저장하여 부스, 관리자 등 모든 기기에서 공유한다.
 *
 * 재생 성공 영상:
 *   추후 재생 성공한 영상을 서버에 영구 저장하고
 *   다음 재생 시 우선적으로 시도하는 기능으로 확장할 수 있다.
 */

import { KaraokeSong, localMediaPath } from "@/data/karaokeSongs";
import { apiUrl } from "@/utils/apiConfig";
import { adminFetch } from "@/utils/adminSession";

export type PlaybackSource = "local" | "youtube" | "synth";

export interface ResolvedMedia {
  source: PlaybackSource;

  /** source === "local"일 때의 파일 경로 */
  localUrl?: string;

  /** source === "youtube"일 때의 영상 ID */
  youtubeId?: string;

  /** 시도 목록에서 몇 번째 영상을 사용하는지 */
  attemptIndex?: number;

  /** 화면에 표시할 재생 상태 설명 */
  reason: string;
}

/* ── 관리자 등록 영상 ─────────────────────────────────────────── */

type VideoIdMap = Record<string, string>;

let overrides: VideoIdMap = {};
let overridesLoaded = false;
let inflight: Promise<VideoIdMap> | null = null;

/**
 * 서버에서 관리자 등록 영상을 불러온다.
 *
 * - 최초 호출 시 서버에 요청한다.
 * - 이미 불러왔다면 캐시를 반환한다.
 * - 요청에 실패하면 다음 호출에서 다시 시도한다.
 * - 서버 연결에 실패해도 기본 후보 영상으로 재생할 수 있다.
 */
export async function loadVideoOverrides(): Promise<VideoIdMap> {
  if (overridesLoaded) return overrides;

  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const res = await fetch(apiUrl("/api/song-videos"));

      if (res.ok) {
        const json = await res.json();

        overrides = (json?.data as VideoIdMap) ?? {};
        overridesLoaded = true;
      }
    } catch {
      // 서버 연결 실패 시 기본 후보 영상으로 재생한다.
      // overridesLoaded를 true로 변경하지 않아 다음 호출에서 재시도한다.
    } finally {
      inflight = null;
    }

    return overrides;
  })();

  return inflight;
}

/**
 * 현재 캐시에 등록된 관리자 영상 ID를 반환한다.
 *
 * 등록된 영상이 없으면 null을 반환한다.
 */
export function getRegisteredVideoId(songId: string): string | null {
  return overrides[songId] ?? null;
}

/**
 * 관리자가 특정 곡의 유튜브 영상을 등록한다.
 *
 * 서버에 저장되므로 다른 기기에서도 동일한 영상이 적용된다.
 */
export async function registerVideoId(
  songId: string,
  videoId: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  const normalizedSongId = songId.trim();
  const normalizedVideoId = videoId.trim();

  if (!normalizedSongId || !normalizedVideoId) {
    return {
      ok: false,
      message: "곡 ID와 영상 ID를 모두 입력해 주세요.",
    };
  }

  try {
    const res = await adminFetch(
      `/api/song-videos/${encodeURIComponent(normalizedSongId)}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          video_id: normalizedVideoId,
        }),
      }
    );

    if (res.status === 401) {
      return {
        ok: false,
        message:
          "영상 등록은 관리자만 할 수 있습니다. 첫 번째 탭에서 관리자 인증을 먼저 해 주세요.",
      };
    }

    if (!res.ok) {
      const json = await res.json().catch(() => null);

      return {
        ok: false,
        message:
          json?.error?.message ?? "영상 등록에 실패했습니다.",
      };
    }

    // 서버 저장 성공 후 현재 기기의 캐시도 갱신한다.
    overrides[normalizedSongId] = normalizedVideoId;

    return { ok: true };
  } catch {
    return {
      ok: false,
      message:
        "백엔드에 연결할 수 없습니다. 서버가 켜져 있는지 확인해 주세요.",
    };
  }
}

/**
 * 관리자 등록 영상을 삭제한다.
 *
 * 삭제에 성공하면 기본 후보 영상 목록으로 돌아간다.
 */
export async function unregisterVideoId(
  songId: string
): Promise<boolean> {
  try {
    const res = await adminFetch(
      `/api/song-videos/${encodeURIComponent(songId)}`,
      {
        method: "DELETE",
      }
    );

    if (res.ok) {
      delete overrides[songId];
      return true;
    }
  } catch {
    // 삭제 실패 시 기존 캐시를 유지한다.
  }

  return false;
}

/* ── 영상 상태 표시 ───────────────────────────────────────────── */

/**
 * 선곡 목록 등에 표시할 영상 상태를 반환한다.
 *
 * 관리자 등록 영상이 있으면 "등록됨",
 * 그렇지 않으면 기본 후보 영상 개수를 표시한다.
 */
export function videoBadge(
  song: KaraokeSong
): {
  label: string;
  title: string;
  registered: boolean;
} {
  if (overrides[song.id]) {
    return {
      label: "등록됨",
      title: "관리자가 직접 지정한 노래방 영상으로 재생합니다.",
      registered: true,
    };
  }

  const count = song.youtubeCandidates.length;

  return {
    label: `후보 ${count}`,
    title:
      count > 0
        ? `기본 후보 영상 ${count}개를 순서대로 시도합니다. 모두 실패하면 내장 반주로 전환합니다.`
        : "등록된 유튜브 영상 후보가 없습니다.",
    registered: false,
  };
}

/* ── 로컬 미디어 파일 확인 ─────────────────────────────────────── */

const localProbeCache = new Map<string, boolean>();

/**
 * public/media/karaoke/에 실제 파일이 존재하는지 확인한다.
 *
 * 파일 경로가 manifest에 등록되어 있어도 실제 파일이 없을 수 있으므로
 * HEAD 요청으로 확인한다.
 */
export async function probeLocalMedia(
  song: KaraokeSong
): Promise<boolean> {
  const path = localMediaPath(song);

  if (!path) return false;

  const cached = localProbeCache.get(path);

  if (cached !== undefined) {
    return cached;
  }

  try {
    const res = await fetch(path, {
      method: "HEAD",
    });

    const contentType = res.headers.get("content-type") ?? "";

    const exists = res.ok && !contentType.includes("text/html");

    localProbeCache.set(path, exists);

    return exists;
  } catch {
    localProbeCache.set(path, false);
    return false;
  }
}

/**
 * 로컬 파일 확인 캐시를 초기화한다.
 *
 * 로컬 미디어 파일을 추가하거나 교체한 뒤
 * 다시 파일 존재 여부를 확인해야 할 때 사용할 수 있다.
 */
export function clearLocalProbeCache(
  songId?: string
): void {
  if (!songId) {
    localProbeCache.clear();
    return;
  }

  const prefix = `/media/karaoke/${songId}.`;

  for (const path of localProbeCache.keys()) {
    if (path.startsWith(prefix)) {
      localProbeCache.delete(path);
    }
  }
}

/* ── 재생 사유 ─────────────────────────────────────────────────── */

function localReason(song: KaraokeSong): string {
  if (song.license === "self-produced") {
    return "학생이 직접 제작한 영상 또는 반주 파일로 재생 중";
  }

  if (song.license === "cc-or-public-domain") {
    return "CC 또는 퍼블릭 도메인 음원으로 재생 중";
  }

  return "학교가 정식 확보한 로컬 미디어 파일로 재생 중";
}

const YT_REASON =
  "유튜브 공식 임베드 플레이어로 스트리밍 중 (복제 없음)";

const SYNTH_REASON =
  "내장 자동 반주 — 원곡이 아닌 장르 스타일 반주입니다";

/* ── 유튜브 후보 목록 ─────────────────────────────────────────── */

/**
 * 이 곡에 시도할 유튜브 영상 ID 목록을 반환한다.
 *
 * 우선순위:
 *   1. 관리자 등록 영상
 *   2. karaokeSongs.ts에 등록된 기본 후보 영상
 *
 * 중복 영상 ID는 한 번만 시도한다.
 */
export function videoAttempts(song: KaraokeSong): string[] {
  const registered = getRegisteredVideoId(song.id);

  const candidates = registered
    ? [registered, ...song.youtubeCandidates]
    : [...song.youtubeCandidates];

  return candidates.filter(
    (videoId, index) =>
      videoId.trim().length > 0 &&
      candidates.indexOf(videoId) === index
  );
}

/* ── 재생 소스 결정 ────────────────────────────────────────────── */

/**
 * 이 곡을 어떤 소스로 재생할지 결정한다.
 *
 * @param song 재생할 곡
 * @param attemptIndex 유튜브 후보 시도 순서 (0부터 시작)
 *
 * 재생 실패 시 호출 측에서 attemptIndex를 1 증가시켜
 * 다시 resolveMedia()를 호출하면 다음 후보로 넘어간다.
 */
export async function resolveMedia(
  song: KaraokeSong,
  attemptIndex = 0
): Promise<ResolvedMedia> {
  // 1. 로컬 파일이 존재하면 가장 먼저 사용한다.
  const path = localMediaPath(song);

  if (path && (await probeLocalMedia(song))) {
    return {
      source: "local",
      localUrl: path,
      reason: localReason(song),
    };
  }

  // 2. 유튜브 영상 후보를 순서대로 확인한다.
  const attempts = videoAttempts(song);

  const videoId = attempts[attemptIndex];

  if (videoId) {
    const registered = getRegisteredVideoId(song.id);

    const isRegistered =
      attemptIndex === 0 && registered === videoId;

    let suffix = "";

    if (isRegistered) {
      suffix = " · 관리자 등록 영상";
    } else if (attempts.length > 1) {
      suffix = ` · 후보 ${attemptIndex + 1}/${attempts.length}`;
    }

    return {
      source: "youtube",
      youtubeId: videoId,
      attemptIndex,
      reason: YT_REASON + suffix,
    };
  }

  // 3. 모든 후보를 소진했으면 내장 신스 반주를 사용한다.
  return {
    source: "synth",
    reason: SYNTH_REASON,
  };
}

/**
 * 현재 후보 재생에 실패했을 때 다음 후보가 남아 있는지 확인한다.
 */
export function hasNextAttempt(
  song: KaraokeSong,
  attemptIndex: number
): boolean {
  return attemptIndex + 1 < videoAttempts(song).length;
}
