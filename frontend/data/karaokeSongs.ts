
/**
 * 학교 노래방 부스 — 선곡 목록
 *
 * 교가:
 *   학교에서 직접 제작한 전용 MP4 영상을 사용한다.
 *
 * 일반곡:
 *   실제 부스에서 유튜브 송출이 확인된 곡은 성공 영상을 첫 번째 후보로 배치한다.
 *   신규 추가곡은 확보한 유튜브 후보를 등록 순서대로 시도한다.
 *   모든 유튜브 후보가 실패하면 내장 신스 반주로 전환한다.
 *
 * 실제 유튜브 송출 테스트에 실패한 곡은 목록에서 삭제한다.
 */

import {
  SCHOOL_ANTHEM_BPM,
  SCHOOL_ANTHEM_DURATION_SEC,
} from "@/data/schoolAnthem.generated";

/** 이 곡을 어떤 권리로 재생하는가 */
export type MediaLicense =
  | "youtube-embed"
  | "school-licensed"
  | "self-produced"
  | "cc-or-public-domain"
  | "synth-fallback";

export interface KaraokeSong {
  id: string;
  title: string;
  singer: string;
  genre: string;
  tag: string;
  year: number;
  pickReason: string;

  /** 노래방 곡 번호 */
  songNumber?: string;

  /** 곡 번호 출처 */
  songNumberSource?: "KY" | "TJ";

  /** 유튜브 영상 ID: 첫 번째 후보부터 순서대로 시도 */
  youtubeCandidates: string[];
  youtubeSearchQuery: string;

  /** 로컬 미디어 파일 확장자 */
  localMediaExt: "mp3" | "m4a" | "wav" | "ogg" | "mp4" | "webm" | null;

  license: MediaLicense;

  /** 임시 내장 반주 시스템에서 사용하는 설정 */
  mr: {
    bpm: number;
    style: "rock" | "dance" | "acoustic" | "ballad";
    progression: "I-V-vi-IV" | "vi-IV-I-V" | "I-vi-IV-V" | "i-VI-III-VII";
    tonic: number;
  };

  approxDurationSec: number;
}

/** 교가 */
export const SCHOOL_ANTHEM_ID = "school-anthem";
export const SCHOOL_ANTHEM_TITLE = "교가";

export function isSchoolAnthem(song: Pick<KaraokeSong, "id">): boolean {
  return song.id === SCHOOL_ANTHEM_ID;
}

/**
 * 신규 곡 입력 타입
 *
 * 반복되는 기본 반주 설정과 라이선스 정보를 공통 처리한다.
 * 개별 곡의 번호와 유튜브 후보는 각 곡에 별도로 등록한다.
 */
type NewSongInput = {
  id: string;
  title: string;
  singer: string;
  genre: string;
  tag?: string;
  year: number;
  pickReason: string;
  songNumber?: string;
  songNumberSource?: "KY" | "TJ";
  youtubeCandidates?: string[];
  youtubeSearchQuery: string;
  bpm?: number;
  style?: KaraokeSong["mr"]["style"];
  progression?: KaraokeSong["mr"]["progression"];
  tonic?: number;
  approxDurationSec?: number;
};

/** 신규 곡 기본 설정 생성 */
function createNewSong(song: NewSongInput): KaraokeSong {
  const inferredStyle: KaraokeSong["mr"]["style"] =
    song.genre.includes("발라드")
      ? "ballad"
      : song.genre.includes("댄스") || song.genre.includes("팝")
        ? "dance"
        : song.genre.includes("록") || song.genre.includes("인디")
          ? "rock"
          : "acoustic";

  return {
    id: song.id,
    title: song.title,
    singer: song.singer,
    genre: song.genre,
    tag: song.tag ?? "신규 추가곡",
    year: song.year,
    pickReason: song.pickReason,

    ...(song.songNumber
      ? {
          songNumber: song.songNumber,
          songNumberSource: song.songNumberSource,
        }
      : {}),

    youtubeCandidates: song.youtubeCandidates ?? [],
    youtubeSearchQuery: song.youtubeSearchQuery,
    localMediaExt: null,
    license: "youtube-embed",

    mr: {
      bpm: song.bpm ?? 120,
      style: song.style ?? inferredStyle,
      progression: song.progression ?? "I-V-vi-IV",
      tonic: song.tonic ?? 293.66,
    },

    approxDurationSec: song.approxDurationSec ?? 220,
  };
}

/**
 * 실제 유튜브 영상 송출이 확인된 곡만 기존 목록에 유지한다.
 * 교가는 별도 제작한 로컬 MP4 영상을 사용한다.
 *
 * 기존 곡은 실제 부스 송출 성공 영상을 첫 번째 후보로 배치한다.
 * 신규 추가곡은 확보한 유튜브 후보를 등록 순서대로 시도한다.
 */
export const KARAOKE_SONGS: KaraokeSong[] = [
  {
    id: SCHOOL_ANTHEM_ID,
    title: SCHOOL_ANTHEM_TITLE,
    singer: "인천전자마이스터고 (작사 이인수)",
    genre: "교가",
    tag: "교가",
    year: 2026,
    pickReason:
      "축제 교가 부르기 대회 곡. 전주의 ●●●● 가 꺼지면 시작하고, 가사가 노랗게 채워지는 대로 부르면 됩니다. 점수는 '교가 순위'에 따로 올라갑니다.",
    // 교가: 학교 자체 제작 영상이므로 노래방 번호 없음
    youtubeCandidates: [],
    youtubeSearchQuery: "",
    localMediaExt: "mp4",
    license: "self-produced",
    mr: {
      bpm: SCHOOL_ANTHEM_BPM,
      style: "ballad",
      progression: "I-vi-IV-V",
      tonic: 349.23,
    },
    approxDurationSec: SCHOOL_ANTHEM_DURATION_SEC,
  },
  {
    id: "apt",
    title: "APT.",
    singer: "로제 & Bruno Mars",
    genre: "팝 / 록",
    tag: "챈트 떼창 👏",
    year: 2024,
    pickReason:
      "'아파트' 챈트 구간 덕분에 노래를 잘 못해도 다 같이 즐길 수 있어 부스 단체 이용에 가장 잘 맞는다.",
    // 곡 번호 출처: 금영(KY)
    songNumber: "71735",
    songNumberSource: "KY",
    youtubeCandidates: ["mvugZggMJug"],
    youtubeSearchQuery: "TJ노래방 APT 로제 브루노마스",
    localMediaExt: null,
    license: "youtube-embed",
    mr: {
      bpm: 149,
      style: "rock",
      progression: "I-V-vi-IV",
      tonic: 246.94,
    },
    approxDurationSec: 170,
  },
  {
    id: "404-new-era",
    title: "404 (New Era)",
    singer: "KiiiKiii (키키)",
    genre: "댄스 / 팝",
    tag: "2026 상반기 1위 🏆",
    year: 2026,
    pickReason:
      "2026년 발매곡 중 주목받은 K-POP 곡으로, 학생들의 최신 아이돌 음악 선곡을 고려해 선정했다.",
    // 곡 번호 출처: TJ 노래방(TJ)
    songNumber: "51613",
    songNumberSource: "TJ",
    youtubeCandidates: ["ZM8nBgHqu_M"],
    youtubeSearchQuery: "TJ노래방 404 New Era 키키 KiiiKiii",
    localMediaExt: null,
    license: "youtube-embed",
    mr: {
      bpm: 126,
      style: "dance",
      progression: "vi-IV-I-V",
      tonic: 293.66,
    },
    approxDurationSec: 185,
  },
  {
    id: "bang-bang",
    title: "BANG BANG",
    singer: "IVE (아이브)",
    genre: "댄스 / 팝",
    tag: "아이돌 인기곡",
    year: 2026,
    pickReason:
      "아이브의 댄스곡으로 단체 이용과 최신 K-POP 선곡을 고려해 선정했다.",
    // 곡 번호 출처: 금영(KY)
    songNumber: "50930",
    songNumberSource: "KY",
    youtubeCandidates: ["3DQ0L57grh8"],
    youtubeSearchQuery: "TJ노래방 BANG BANG 아이브 IVE",
    localMediaExt: null,
    license: "youtube-embed",
    mr: {
      bpm: 130,
      style: "dance",
      progression: "i-VI-III-VII",
      tonic: 293.66,
    },
    approxDurationSec: 190,
  },
  {
    id: "rude",
    title: "RUDE!",
    singer: "Hearts2Hearts (하츠투하츠)",
    genre: "하우스 / 댄스",
    tag: "아이돌 인기곡",
    year: 2026,
    pickReason:
      "하츠투하츠의 댄스곡으로 최신 걸그룹 음악 선곡을 고려해 선정했다.",
    // 곡 번호 출처: 금영(KY)
    songNumber: "50962",
    songNumberSource: "KY",
    youtubeCandidates: ["JO54Y4jFaWo"],
    youtubeSearchQuery: "TJ노래방 RUDE 하츠투하츠 Hearts2Hearts",
    localMediaExt: null,
    license: "youtube-embed",
    mr: {
      bpm: 124,
      style: "dance",
      progression: "vi-IV-I-V",
      tonic: 349.23,
    },
    approxDurationSec: 180,
  },

  // ============================================================
  // 기존 K-POP 추가곡
  // ============================================================

  {
    id: "redred",
    title: "REDRED",
    singer: "CORTIS (코르티스)",
    genre: "힙합 / 댄스",
    tag: "신규 추가곡",
    year: 2026,
    pickReason:
      "CORTIS의 곡으로 최신 보이그룹 음악 선곡을 고려해 추가했다.",
    // 곡 번호 출처: TJ 노래방(TJ)
    songNumber: "52157",
    songNumberSource: "TJ",
    youtubeCandidates: [
      "UZ1vy2anLeI", // 부스 송출 성공
      "XfQSJ8XB_Rc",
      "x0onK7WRdvM",
    ],
    youtubeSearchQuery: "TJ 금영 노래방 REDRED CORTIS 코르티스",
    localMediaExt: null,
    license: "youtube-embed",
    mr: {
      bpm: 120,
      style: "dance",
      progression: "vi-IV-I-V",
      tonic: 293.66,
    },
    approxDurationSec: 180,
  },
  {
    id: "drowning",
    title: "Drowning",
    singer: "WOODZ (조승연)",
    genre: "록 / 발라드",
    tag: "신규 추가곡",
    year: 2023,
    pickReason:
      "발매 이후에도 꾸준히 사랑받는 곡으로, 노래방에서 부르기 좋은 록 발라드 선곡으로 추가했다.",
    // 곡 번호 출처: TJ 노래방(TJ)
    songNumber: "83945",
    songNumberSource: "TJ",
    youtubeCandidates: [
      "qD6_cq5hGU0", // 부스 송출 성공
      "BPr-NdAkmgY",
    ],
    youtubeSearchQuery: "TJ 금영 노래방 Drowning WOODZ 조승연",
    localMediaExt: null,
    license: "youtube-embed",
    mr: {
      bpm: 120,
      style: "rock",
      progression: "vi-IV-I-V",
      tonic: 246.94,
    },
    approxDurationSec: 220,
  },
  {
    id: "cheonsangyeon",
    title: "천상연",
    singer: "이창섭",
    genre: "발라드",
    tag: "신규 추가곡",
    year: 2024,
    pickReason:
      "이창섭의 감성 발라드로 학생들의 발라드 선곡을 고려해 추가했다.",
    // 곡 번호 출처: TJ 노래방(TJ)
    songNumber: "86059",
    songNumberSource: "TJ",
    youtubeCandidates: [
      "FqsE6u9Gtes", // 부스 송출 성공
      "k9QvUzisLEI",
      "ybm4JqD8yTU",
      "-XBOQG-GsGE",
    ],
    youtubeSearchQuery: "TJ 금영 노래방 천상연 이창섭",
    localMediaExt: null,
    license: "youtube-embed",
    mr: {
      bpm: 72,
      style: "ballad",
      progression: "I-vi-IV-V",
      tonic: 246.94,
    },
    approxDurationSec: 230,
  },
  {
    id: "oneulman-i-love-you",
    title: "오늘만 I LOVE YOU",
    singer: "BOYNEXTDOOR (보이넥스트도어)",
    genre: "팝 / 록",
    tag: "신규 추가곡",
    year: 2025,
    pickReason:
      "보이넥스트도어의 대중적인 곡으로 학생들의 아이돌 음악 선곡을 고려해 추가했다.",
    // 곡 번호 출처: TJ 노래방(TJ)
    songNumber: "44411",
    songNumberSource: "TJ",
    youtubeCandidates: ["mZm8sb4yVWA"], // 부스 송출 성공
    youtubeSearchQuery: "TJ 금영 노래방 오늘만 I LOVE YOU BOYNEXTDOOR",
    localMediaExt: null,
    license: "youtube-embed",
    mr: {
      bpm: 118,
      style: "rock",
      progression: "I-V-vi-IV",
      tonic: 293.66,
    },
    approxDurationSec: 190,
  },
  {
    id: "love-attack",
    title: "LOVE ATTACK",
    singer: "RESCENE (리센느)",
    genre: "댄스 / 팝",
    tag: "신규 추가곡",
    year: 2024,
    pickReason:
      "리센느의 밝은 분위기의 댄스곡으로 걸그룹 선곡을 다양화하기 위해 추가했다.",
    // 곡 번호 출처: 금영(KY) — 사용자 제공 번호
    songNumber: "71566",
    songNumberSource: "KY",
    youtubeCandidates: [
      "DHqXh3nmaoQ", // 부스 송출 성공
      "ehUgAY6KcSw",
      "Hp6VNKQzHLI",
    ],
    youtubeSearchQuery: "TJ 금영 노래방 LOVE ATTACK RESCENE 리센느",
    localMediaExt: null,
    license: "youtube-embed",
    mr: {
      bpm: 126,
      style: "dance",
      progression: "vi-IV-I-V",
      tonic: 329.63,
    },
    approxDurationSec: 180,
  },
  {
    id: "naneun-bandibul",
    title: "나는 반딧불",
    singer: "황가람",
    genre: "발라드",
    tag: "신규 추가곡",
    year: 2024,
    pickReason:
      "대중적으로 알려진 감성 발라드로 함께 부르기 좋은 곡을 추가했다.",
    // 곡 번호 출처: 금영(KY)
    songNumber: "55791",
    songNumberSource: "KY",
    youtubeCandidates: [
      "Xm8v6-RrAkA", // 부스 송출 성공
      "1Iglj0kqoQM",
      "kgQioMZdlsI",
      "vF_IfKW8HIM",
      "olohrVFNykQ",
    ],
    youtubeSearchQuery: "TJ 금영 노래방 나는 반딧불 황가람",
    localMediaExt: null,
    license: "youtube-embed",
    mr: {
      bpm: 78,
      style: "ballad",
      progression: "I-vi-IV-V",
      tonic: 293.66,
    },
    approxDurationSec: 230,
  },
  {
    id: "morsinayo",
    title: "모르시나요",
    singer: "조째즈",
    genre: "발라드",
    tag: "신규 추가곡",
    year: 2025,
    pickReason:
      "최근 주목받은 발라드 곡으로 학생들의 발라드 선곡을 다양화하기 위해 추가했다.",
    // 곡 번호 출처: TJ 노래방(TJ)
    songNumber: "44491",
    songNumberSource: "TJ",
    youtubeCandidates: [
      "qgcn1AmsgWk", // 부스 송출 성공
      "bFzi2pwH-t0",
      "WTw_l9eoU8U",
      "FGfS4ZqhrrI",
      "fI2SnCv9oWA",
    ],
    youtubeSearchQuery: "TJ 금영 노래방 모르시나요 조째즈",
    localMediaExt: null,
    license: "youtube-embed",
    mr: {
      bpm: 76,
      style: "ballad",
      progression: "I-vi-IV-V",
      tonic: 246.94,
    },
    approxDurationSec: 230,
  },
  {
    id: "ipchun",
    title: "입춘",
    singer: "한로로",
    genre: "인디 / 록",
    tag: "신규 추가곡",
    year: 2022,
    pickReason:
      "한로로의 대표적인 인디 록 곡으로 다양한 장르의 선곡을 위해 추가했다.",
    // 곡 번호 출처: TJ 노래방(TJ)
    songNumber: "85215",
    songNumberSource: "TJ",
    youtubeCandidates: [
      "RWwVa_wLJnc", // 부스 송출 성공
      "72CLda2iLQk",
      "4mGxAa5Z3Qw",
      "7tKf6AwULTU",
      "CoUGyrTLBlo",
      "EVwPqejAXbA",
    ],
    youtubeSearchQuery: "TJ 금영 노래방 입춘 한로로",
    localMediaExt: null,
    license: "youtube-embed",
    mr: {
      bpm: 110,
      style: "rock",
      progression: "I-V-vi-IV",
      tonic: 293.66,
    },
    approxDurationSec: 220,
  },

  // ============================================================
  // 기존 J-POP 추가곡
  // ============================================================

  {
    id: "king-gnu-hakujitsu",
    title: "백일 (白日)",
    singer: "King Gnu",
    genre: "J-POP / 록",
    tag: "J-POP",
    year: 2019,
    pickReason:
      "King Gnu의 대표곡으로 일본 록 음악 선곡을 다양화하기 위해 추가했다.",
    // 곡 번호 출처: TJ 노래방(TJ)
    songNumber: "68031",
    songNumberSource: "TJ",
    youtubeCandidates: ["wdZHRxfb_TE"], // 사용자 제공 일반 노래방 영상
    youtubeSearchQuery: "King Gnu 白日 노래방 カラオケ",
    localMediaExt: null,
    license: "youtube-embed",
    mr: {
      bpm: 93,
      style: "rock",
      progression: "vi-IV-I-V",
      tonic: 246.94,
    },
    approxDurationSec: 275,
  },
  {
    id: "king-gnu-hikoutei",
    title: "비행정 (飛行艇)",
    singer: "King Gnu",
    genre: "J-POP / 록",
    tag: "J-POP",
    year: 2019,
    pickReason:
      "강한 밴드 사운드와 에너지가 특징인 King Gnu의 록 곡으로 추가했다.",
    // 곡 번호 출처: TJ 노래방(TJ)
    songNumber: "68135",
    songNumberSource: "TJ",
    youtubeCandidates: ["trSX4z2ViNU"], // 사용자 제공 일반 노래방 영상
    youtubeSearchQuery: "King Gnu 飛行艇 노래방 カラオケ",
    localMediaExt: null,
    license: "youtube-embed",
    mr: {
      bpm: 135,
      style: "rock",
      progression: "i-VI-III-VII",
      tonic: 293.66,
    },
    approxDurationSec: 245,
  },
  {
    id: "king-gnu-specialz",
    title: "SPECIALZ",
    singer: "King Gnu",
    genre: "J-POP / 록",
    tag: "J-POP",
    year: 2023,
    pickReason:
      "애니메이션 주제가로 알려진 King Gnu의 대표적인 곡으로 J-POP 선곡에 추가했다.",
    // 곡 번호 출처: 금영(KY)
    songNumber: "75838",
    songNumberSource: "KY",
    youtubeCandidates: [
      "RYswJ9mQnV0", // 사용자 제공 영상 1
      "7pW3fBVRXtI", // 사용자 제공 영상 2
      "PcmAkkpF4_M", // 사용자 제공 영상 3
    ],
    youtubeSearchQuery: "King Gnu SPECIALZ 노래방 カラオケ",
    localMediaExt: null,
    license: "youtube-embed",
    mr: {
      bpm: 138,
      style: "rock",
      progression: "i-VI-III-VII",
      tonic: 293.66,
    },
    approxDurationSec: 245,
  },
  {
    id: "king-gnu-aizo",
    title: "AIZO",
    singer: "King Gnu",
    genre: "J-POP / 록",
    tag: "J-POP",
    year: 2026,
    pickReason:
      "King Gnu의 최신곡으로 최신 일본 음악 선곡을 고려해 추가했다.",
    // 곡 번호 출처: TJ 노래방(TJ)
    songNumber: "52501",
    songNumberSource: "TJ",
    youtubeCandidates: [
      "Dm64tHh6hcU", // 사용자 제공 일반 노래방 영상
      "vkoFByV1-yY", // Mick Music 일반 노래방 영상 후보
    ],
    youtubeSearchQuery: "King Gnu AIZO 노래방 カラオケ",
    localMediaExt: null,
    license: "youtube-embed",
    mr: {
      bpm: 140,
      style: "rock",
      progression: "i-VI-III-VII",
      tonic: 329.63,
    },
    approxDurationSec: 230,
  },
  {
    id: "vaundy-kaiju-no-hanauta",
    title: "괴수의 꽃노래 (怪獣の花唄)",
    singer: "Vaundy",
    genre: "J-POP / 록",
    tag: "J-POP",
    year: 2020,
    pickReason:
      "Vaundy의 대표적인 밴드 사운드 곡으로 일본 대중음악 선곡을 다양화하기 위해 추가했다.",
    // 곡 번호 출처: TJ 노래방(TJ)
    songNumber: "52988",
    songNumberSource: "TJ",
    youtubeCandidates: [
      "P8eFPCZMh1c", // 사용자 제공 일반 노래방 영상
      "-SfzSPVvK8I", // 일반 노래방 영상 후보
    ],
    youtubeSearchQuery: "Vaundy 怪獣の花唄 노래방 カラオケ",
    localMediaExt: null,
    license: "youtube-embed",
    mr: {
      bpm: 150,
      style: "rock",
      progression: "I-V-vi-IV",
      tonic: 293.66,
    },
    approxDurationSec: 235,
  },
  {
    id: "vaundy-fukakouryoku",
    title: "불가행력 (不可幸力)",
    singer: "Vaundy",
    genre: "J-POP / 팝",
    tag: "J-POP",
    year: 2019,
    pickReason:
      "Vaundy 특유의 리듬감과 개성 있는 사운드가 돋보이는 곡으로 추가했다.",
    // 곡 번호 출처: TJ 노래방(TJ)
    songNumber: "52455",
    songNumberSource: "TJ",
    youtubeCandidates: ["LGs8ZnvXkI0"], // 사용자 제공 일반 노래방 영상
    youtubeSearchQuery: "Vaundy 不可幸力 노래방 カラオケ",
    localMediaExt: null,
    license: "youtube-embed",
    mr: {
      bpm: 115,
      style: "dance",
      progression: "vi-IV-I-V",
      tonic: 246.94,
    },
    approxDurationSec: 215,
  },
  {
    id: "vaundy-koi-kaze-ni-nosete",
    title: "사랑 감기에 실려 (恋風邪にのせて)",
    singer: "Vaundy",
    genre: "J-POP / 팝",
    tag: "J-POP",
    year: 2022,
    pickReason:
      "부드러운 분위기의 Vaundy 곡으로 빠른 템포의 록 곡과 다른 분위기의 선곡을 위해 추가했다.",
    // 곡 번호 출처: TJ 노래방(TJ)
    songNumber: "52428",
    songNumberSource: "TJ",
    youtubeCandidates: [
      "OK5UDp371zk", // 사용자 제공 노래방 영상
      "pp9lofnNflQ", // 일반 노래방 영상 후보
    ],
    youtubeSearchQuery: "Vaundy 恋風邪にのせて 노래방 カラオケ",
    localMediaExt: null,
    license: "youtube-embed",
    mr: {
      bpm: 105,
      style: "acoustic",
      progression: "I-V-vi-IV",
      tonic: 293.66,
    },
    approxDurationSec: 240,
  },
  {
    id: "yuuri-betelgeuse",
    title: "베텔기우스 (ベテルギウス)",
    singer: "優里 (Yuuri)",
    genre: "J-POP / 발라드",
    tag: "J-POP",
    year: 2021,
    pickReason:
      "優里의 대표적인 감성 발라드로 일본 발라드 선곡을 추가하기 위해 선정했다.",
    // 곡 번호 출처: TJ 노래방(TJ)
    songNumber: "68553",
    songNumberSource: "TJ",
    youtubeCandidates: ["-9n7mtLM--c"], // 사용자 제공 일반 노래방 영상
    youtubeSearchQuery: "優里 ベテルギウス 노래방 カラオケ",
    localMediaExt: null,
    license: "youtube-embed",
    mr: {
      bpm: 102,
      style: "ballad",
      progression: "I-V-vi-IV",
      tonic: 246.94,
    },
    approxDurationSec: 235,
  },
  {
    id: "kana-boon-silhouette",
    title: "실루엣 (シルエット)",
    singer: "KANA-BOON",
    genre: "J-POP / 록",
    tag: "J-POP",
    year: 2014,
    pickReason:
      "애니메이션 주제가로 잘 알려진 KANA-BOON의 대표적인 록 곡으로 추가했다.",
    // 곡 번호 출처: TJ 노래방(TJ)
    songNumber: "28214",
    songNumberSource: "TJ",
    youtubeCandidates: [
      "TmbDzgH0OQQ", // 부스 송출 성공
      "t7P6cZuXYp8", // 사용자 제공 여자키 노래방 영상
      "ce-F0i_bl14", // 사용자 제공 일반 노래방 영상
      "XUlSt_HXdgU", // 사용자 제공 일반 노래방 영상
    ],
    youtubeSearchQuery: "KANA-BOON シルエット 노래방 カラオケ",
    localMediaExt: null,
    license: "youtube-embed",
    mr: {
      bpm: 183,
      style: "rock",
      progression: "I-V-vi-IV",
      tonic: 293.66,
    },
    approxDurationSec: 245,
  },
  {
    id: "spyair-samurai-heart",
    title: "사무라이 하트 (サムライハート)",
    singer: "SPYAIR",
    genre: "J-POP / 록",
    tag: "J-POP",
    year: 2011,
    pickReason:
      "SPYAIR의 대표적인 애니메이션 주제가로 밴드 음악과 일본 록 선곡을 다양화하기 위해 추가했다.",
    // 곡 번호 출처: TJ 노래방(TJ)
    songNumber: "27527",
    songNumberSource: "TJ",
    youtubeCandidates: ["4B_bFaluUfY"], // 사용자 제공 일반 노래방 영상
    youtubeSearchQuery: "SPYAIR サムライハート 노래방 カラオケ",
    localMediaExt: null,
    license: "youtube-embed",
    mr: {
      bpm: 145,
      style: "rock",
      progression: "I-V-vi-IV",
      tonic: 293.66,
    },
    approxDurationSec: 210,
  },

  // ============================================================
  // 림버스 컴퍼니 — 사라지네 캐릭터별 버전
  // ============================================================

  {
    id: "limbus-gone-gregor",
    title: "사라지네 (그레고르)",
    singer: "그레고르",
    genre: "게임 OST / 발라드",
    tag: "게임 OST",
    year: 2023,
    pickReason:
      "림버스 컴퍼니의 사라지네 캐릭터별 보컬 버전으로, 그레고르 버전을 별도 선곡으로 추가했다.",
    // 곡 번호 출처: 금영(KY)
    songNumber: "75499",
    songNumberSource: "KY",
    youtubeCandidates: ["PR5EJBXFIgc"], // 사용자 제공 영상
    youtubeSearchQuery: "금영 노래방 사라지네 그레고르 림버스 컴퍼니",
    localMediaExt: null,
    license: "youtube-embed",
    mr: {
      bpm: 80,
      style: "ballad",
      progression: "I-vi-IV-V",
      tonic: 246.94,
    },
    approxDurationSec: 230,
  },
  {
    id: "limbus-gone-rodion",
    title: "사라지네 (로쟈)",
    singer: "로쟈",
    genre: "게임 OST / 발라드",
    tag: "게임 OST",
    year: 2023,
    pickReason:
      "림버스 컴퍼니의 사라지네 캐릭터별 보컬 버전으로, 로쟈 버전을 별도 선곡으로 추가했다.",
    // 곡 번호 출처: 금영(KY)
    songNumber: "75509",
    songNumberSource: "KY",
    youtubeCandidates: ["PIVixy4AsNI"], // 사용자 제공 영상
    youtubeSearchQuery: "금영 노래방 사라지네 로쟈 림버스 컴퍼니",
    localMediaExt: null,
    license: "youtube-embed",
    mr: {
      bpm: 80,
      style: "ballad",
      progression: "I-vi-IV-V",
      tonic: 246.94,
    },
    approxDurationSec: 230,
  },
  {
    id: "limbus-gone-sinclair",
    title: "사라지네 (싱클레어)",
    singer: "싱클레어",
    genre: "게임 OST / 발라드",
    tag: "게임 OST",
    year: 2023,
    pickReason:
      "림버스 컴퍼니의 사라지네 캐릭터별 보컬 버전으로, 싱클레어 버전을 별도 선곡으로 추가했다.",
    // 곡 번호 출처: 금영(KY)
    songNumber: "75500",
    songNumberSource: "KY",
    youtubeCandidates: ["MKYdZJkxO1U"], // 사용자 제공 영상
    youtubeSearchQuery: "금영 노래방 사라지네 싱클레어 림버스 컴퍼니",
    localMediaExt: null,
    license: "youtube-embed",
    mr: {
      bpm: 80,
      style: "ballad",
      progression: "I-vi-IV-V",
      tonic: 246.94,
    },
    approxDurationSec: 230,
  },
  {
    id: "limbus-gone-yi-sang",
    title: "사라지네 (이상)",
    singer: "이상",
    genre: "게임 OST / 발라드",
    tag: "게임 OST",
    year: 2023,
    pickReason:
      "림버스 컴퍼니의 사라지네 캐릭터별 보컬 버전으로, 이상 버전을 별도 선곡으로 추가했다.",
    // 곡 번호 출처: 금영(KY)
    songNumber: "75501",
    songNumberSource: "KY",
    youtubeCandidates: ["KuGMCVCEyMc"], // 사용자 제공 영상
    youtubeSearchQuery: "금영 노래방 사라지네 이상 림버스 컴퍼니",
    localMediaExt: null,
    license: "youtube-embed",
    mr: {
      bpm: 80,
      style: "ballad",
      progression: "I-vi-IV-V",
      tonic: 246.94,
    },
    approxDurationSec: 230,
  },
  {
    id: "limbus-gone-ishmael",
    title: "사라지네 (이스마엘)",
    singer: "이스마엘",
    genre: "게임 OST / 발라드",
    tag: "게임 OST",
    year: 2023,
    pickReason:
      "림버스 컴퍼니의 사라지네 캐릭터별 보컬 버전으로, 이스마엘 버전을 별도 선곡으로 추가했다.",
    // 곡 번호 출처: 금영(KY)
    songNumber: "75502",
    songNumberSource: "KY",
    youtubeCandidates: ["KPgTAG0bmLo"], // 사용자 제공 영상
    youtubeSearchQuery: "금영 노래방 사라지네 이스마엘 림버스 컴퍼니",
    localMediaExt: null,
    license: "youtube-embed",
    mr: {
      bpm: 80,
      style: "ballad",
      progression: "I-vi-IV-V",
      tonic: 246.94,
    },
    approxDurationSec: 230,
  },
  {
    id: "limbus-gone-heathcliff",
    title: "사라지네 (히스클리프)",
    singer: "히스클리프",
    genre: "게임 OST / 발라드",
    tag: "게임 OST",
    year: 2023,
    pickReason:
      "림버스 컴퍼니의 사라지네 캐릭터별 보컬 버전으로, 히스클리프 버전을 별도 선곡으로 추가했다.",
    // 곡 번호 출처: 금영(KY)
    songNumber: "74885",
    songNumberSource: "KY",
    youtubeCandidates: ["KAzq3Gcx0Sc"], // 사용자 제공 영상
    youtubeSearchQuery: "금영 노래방 사라지네 히스클리프 림버스 컴퍼니",
    localMediaExt: null,
    license: "youtube-embed",
    mr: {
      bpm: 80,
      style: "ballad",
      progression: "I-vi-IV-V",
      tonic: 246.94,
    },
    approxDurationSec: 230,
  },
  {
    id: "limbus-gone-don-quixote",
    title: "사라지네 (돈키호테)",
    singer: "돈키호테",
    genre: "게임 OST / 발라드",
    tag: "게임 OST",
    year: 2023,
    pickReason:
      "림버스 컴퍼니의 사라지네 캐릭터별 보컬 버전으로, 돈키호테 버전을 별도 선곡으로 추가했다.",
    // 곡 번호 출처: 금영(KY)
    songNumber: "74884",
    songNumberSource: "KY",
    youtubeCandidates: ["y_lXmiGAidM"], // 사용자 제공 영상
    youtubeSearchQuery: "금영 노래방 사라지네 돈키호테 림버스 컴퍼니",
    localMediaExt: null,
    license: "youtube-embed",
    mr: {
      bpm: 80,
      style: "ballad",
      progression: "I-vi-IV-V",
      tonic: 246.94,
    },
    approxDurationSec: 230,
  },
  {
    id: "limbus-gone-hong-lu",
    title: "사라지네 (홍루)",
    singer: "홍루",
    genre: "게임 OST / 발라드",
    tag: "게임 OST",
    year: 2023,
    pickReason:
      "림버스 컴퍼니의 사라지네 캐릭터별 보컬 버전으로, 홍루 버전을 별도 선곡으로 추가했다.",
    // 곡 번호 출처: 금영(KY)
    songNumber: "50192",
    songNumberSource: "KY",
    youtubeCandidates: ["0NgNWYTLM14"], // 사용자 제공 영상
    youtubeSearchQuery: "금영 노래방 사라지네 홍루 림버스 컴퍼니",
    localMediaExt: null,
    license: "youtube-embed",
    mr: {
      bpm: 80,
      style: "ballad",
      progression: "I-vi-IV-V",
      tonic: 246.94,
    },
    approxDurationSec: 230,
  },

  // ============================================================
  // 디지몬 어드벤처 OST
  // ============================================================

  {
    id: "digimon-butterfly",
    title: "Butter-Fly",
    singer: "전영호",
    genre: "애니메이션 OST / 록",
    tag: "애니메이션 OST",
    year: 1999,
    pickReason:
      "디지몬 어드벤처의 대표 주제가로, 세대를 아우르는 애니메이션 OST 선곡을 위해 추가했다.",
    // 곡 번호 출처: 금영(KY)
    songNumber: "51714",
    songNumberSource: "KY",
    youtubeCandidates: [
      "GWewp1QplR0", // 사용자 제공 새 노래방 영상 후보
    ],
    youtubeSearchQuery: "전영호 Butter-Fly 디지몬 노래방",
    localMediaExt: null,
    license: "youtube-embed",
    mr: {
      bpm: 165,
      style: "rock",
      progression: "I-V-vi-IV",
      tonic: 293.66,
    },
    approxDurationSec: 245,
  },

  // ============================================================
  // 신규 추가곡 30곡
  // ============================================================

  // ------------------------------------------------------------
  // K-POP / 국내 음악
  // ------------------------------------------------------------

  ...[
    createNewSong({
      id: "geon-aniya-pt1",
      title: "걘 아니야 Pt.1",
      singer: "이영지",
      genre: "힙합",
      year: 2021,
      pickReason: "국내 힙합 선곡을 다양화하기 위해 추가했다.",
      youtubeSearchQuery: "걘 아니야 Pt.1 노래방",
      style: "dance",
    }),
    createNewSong({
      id: "geon-aniya-pt2",
      title: "걘 아니야 Pt.2",
      singer: "이영지",
      genre: "힙합",
      year: 2021,
      pickReason: "Pt.1과 함께 선곡할 수 있도록 후속 곡을 추가했다.",
      youtubeSearchQuery: "걘 아니야 Pt.2 노래방",
      style: "dance",
    }),
    createNewSong({
      id: "taeyeon-to-x",
      title: "To. X",
      singer: "태연",
      genre: "발라드 / R&B",
      year: 2023,
      pickReason: "태연의 대표적인 감성 팝 곡으로 추가했다.",
      songNumber: "85413",
      songNumberSource: "TJ",
      youtubeSearchQuery: "태연 To. X 노래방",
      style: "ballad",
    }),
    createNewSong({
      id: "taeyeon-i",
      title: "I",
      singer: "태연",
      genre: "팝 / 록",
      year: 2015,
      pickReason: "태연의 대표 솔로곡으로 다양한 세대의 선곡을 고려해 추가했다.",
      youtubeSearchQuery: "태연 I 노래방",
      style: "rock",
    }),
    createNewSong({
      id: "ii-honeychurros",
      title: "ii (아이아이)",
      singer: "허니츄러스",
      genre: "팝",
      year: 2024,
      pickReason: "인터넷 음악과 버추얼 아티스트 음악 선곡을 다양화하기 위해 추가했다.",
      songNumber: "84096",
      songNumberSource: "TJ",
      youtubeCandidates: ["PnLzYigLYu8"],
      youtubeSearchQuery: "허니츄러스 ii 아이아이 노래방",
    }),
    createNewSong({
      id: "yena-catch-catch",
      title: "캐치캐치",
      singer: "최예나",
      genre: "댄스 / 팝",
      year: 2024,
      pickReason: "밝고 경쾌한 분위기의 아이돌 곡으로 추가했다.",
      songNumber: "51028",
      songNumberSource: "KY",
      youtubeCandidates: ["NOiyDlWl534"],
      youtubeSearchQuery: "최예나 캐치캐치 노래방",
    }),
    createNewSong({
      id: "yena-nemonemo",
      title: "네모네모",
      singer: "최예나",
      genre: "댄스 / 팝",
      year: 2024,
      pickReason: "최예나의 대중적인 댄스곡으로 선곡 폭을 넓히기 위해 추가했다.",
      songNumber: "71633",
      songNumberSource: "KY",
      youtubeCandidates: ["MPp8hbuZwW0"],
      youtubeSearchQuery: "최예나 네모네모 노래방",
    }),
    createNewSong({
      id: "ovan-entrance-difference",
      title: "입장차이",
      singer: "오반",
      genre: "힙합 / 발라드",
      year: 2021,
      pickReason: "오반의 감성적인 힙합 곡으로 추가했다.",
      // 곡 번호 출처: 금영(KY) — 사용자 제공 번호
      songNumber: "80600",
      songNumberSource: "KY",
      youtubeSearchQuery: "오반 입장차이 노래방",
      style: "ballad",
    }),
    createNewSong({
      id: "hahyeonsang-lighthouse",
      title: "등대",
      singer: "하현상",
      genre: "인디 / 발라드",
      year: 2021,
      pickReason: "하현상의 대표적인 감성 곡으로 추가했다.",
      songNumber: "99496",
      songNumberSource: "KY",
      youtubeSearchQuery: "하현상 등대 노래방",
      style: "ballad",
    }),
    createNewSong({
      id: "bewhy-transcend",
      title: "초월",
      singer: "비와이",
      genre: "힙합",
      year: 2022,
      pickReason: "국내 힙합 장르의 선곡을 다양화하기 위해 추가했다.",
      songNumber: "24028",
      songNumberSource: "TJ",
      youtubeSearchQuery: "비와이 초월 노래방",
      style: "dance",
    }),
    createNewSong({
      id: "wing-dopamine",
      title: "Dopamine",
      singer: "WING",
      genre: "댄스 / 팝",
      year: 2025,
      pickReason: "WING의 곡으로 다양한 국내 음악 선곡을 위해 추가했다.",
      // 곡 번호 출처: 금영(KY) — 사용자 제공 번호
      songNumber: "56304",
      songNumberSource: "KY",
      youtubeCandidates: ["OuQtwZtyi3k", "ygyEi8jYpdU"],
      youtubeSearchQuery: "WING Dopamine 노래방",
    }),
    createNewSong({
      id: "thornapple-blue-spring",
      title: "시퍼런 봄",
      singer: "쏜애플",
      genre: "인디 / 록",
      year: 2014,
      pickReason: "쏜애플 특유의 밴드 사운드를 즐길 수 있는 인디 록 곡으로 추가했다.",
      songNumber: "29898",
      songNumberSource: "KY",
      youtubeSearchQuery: "쏜애플 시퍼런 봄 노래방",
      style: "rock",
    }),
    createNewSong({
      id: "thornapple-antarctica",
      title: "남극",
      singer: "쏜애플",
      genre: "인디 / 록",
      year: 2016,
      pickReason: "쏜애플의 대표곡 중 하나로 인디 록 선곡을 보강하기 위해 추가했다.",
      songNumber: "75553",
      songNumberSource: "KY",
      youtubeSearchQuery: "쏜애플 남극 노래방",
      style: "rock",
    }),
    createNewSong({
      id: "thornapple-decline",
      title: "쇠퇴론",
      singer: "쏜애플",
      genre: "인디 / 록",
      year: 2014,
      pickReason: "쏜애플의 음악을 추가해 국내 인디 밴드 선곡을 다양화했다.",
      songNumber: "70831",
      songNumberSource: "TJ",
      youtubeSearchQuery: "쏜애플 쇠퇴론 노래방",
      style: "rock",
    }),
    createNewSong({
      id: "thornapple-acacia",
      title: "아카시아",
      singer: "쏜애플",
      genre: "인디 / 록",
      year: 2016,
      pickReason: "쏜애플의 인디 록 곡으로 밴드 음악 선곡을 보강했다.",
      songNumber: "70924",
      songNumberSource: "TJ",
      youtubeSearchQuery: "쏜애플 아카시아 노래방",
      style: "rock",
    }),
    createNewSong({
      id: "silica-gel-no-pain",
      title: "NO PAIN",
      singer: "실리카겔",
      genre: "인디 / 록",
      year: 2022,
      pickReason: "실리카겔의 대표곡으로 국내 인디 밴드 선곡을 다양화하기 위해 추가했다.",
      // 곡 번호 출처: 금영(KY) — 사용자 제공 번호
      songNumber: "97108",
      songNumberSource: "KY",
      youtubeSearchQuery: "실리카겔 NO PAIN 노래방",
      style: "rock",
    }),
    createNewSong({
      id: "touched-highlight",
      title: "Highlight",
      singer: "터치드",
      genre: "인디 / 록",
      year: 2023,
      pickReason: "터치드의 밴드 사운드를 즐길 수 있는 곡으로 추가했다.",
      // 곡 번호 출처: TJ 노래방(TJ) — 사용자 제공 번호
      songNumber: "84905",
      songNumberSource: "TJ",
      youtubeSearchQuery: "터치드 Highlight 노래방",
      style: "rock",
    }),
    createNewSong({
      id: "touched-love-is-dangerous",
      title: "Love is dangerous",
      singer: "터치드",
      genre: "인디 / 록",
      year: 2024,
      pickReason: "터치드의 곡으로 밴드 음악 선곡을 보강하기 위해 추가했다.",
      // 곡 번호 출처: TJ 노래방 — 사용자 제공 번호, 곡명 일치 여부 재확인 필요
      songNumber: "50398",
      songNumberSource: "TJ",
      youtubeCandidates: ["Jbu6-gZfApk"],
      youtubeSearchQuery: "터치드 Love is dangerous 노래방",
      style: "rock",
    }),
  ],

  // ------------------------------------------------------------
  // J-POP / 보컬로이드
  // ------------------------------------------------------------

  ...[
    createNewSong({
      id: "orangestar-night-sky-patrol",
      title: "내일의 밤하늘 초계반",
      singer: "Orangestar",
      genre: "J-POP / 보컬로이드",
      tag: "J-POP",
      year: 2014,
      pickReason: "보컬로이드와 일본 음악을 즐기는 이용자를 위해 추가했다.",
      songNumber: "44091",
      songNumberSource: "KY",
      youtubeCandidates: ["l9eKWIURgXs"],
      youtubeSearchQuery: "Orangestar 내일의 밤하늘 초계반 노래방",
      style: "rock",
    }),
    createNewSong({
      id: "atsuki-mesmerizer",
      title: "메스머라이저",
      singer: "사츠키 feat. 하츠네 미쿠, 카사네 테토",
      genre: "보컬로이드 / J-POP",
      tag: "보컬로이드",
      year: 2024,
      pickReason: "최근 보컬로이드 음악의 인기를 반영해 추가했다.",
      songNumber: "57747",
      songNumberSource: "KY",
      youtubeSearchQuery: "メズマライザー 노래방 カラオケ",
      style: "dance",
    }),
    createNewSong({
      id: "nekobolo-jishoumushoku",
      title: "자상무색",
      singer: "네코볼로 feat. 하츠네 미쿠",
      genre: "보컬로이드 / 발라드",
      tag: "보컬로이드",
      year: 2012,
      pickReason: "오래 사랑받는 보컬로이드 곡으로 선곡 폭을 넓히기 위해 추가했다.",
      songNumber: "44010",
      songNumberSource: "KY",
      youtubeSearchQuery: "自傷無色 노래방 カラオケ",
      style: "ballad",
    }),
  ],

  // ------------------------------------------------------------
  // 버추얼 아티스트
  // ------------------------------------------------------------

  ...[
    createNewSong({
      id: "airi-kanna-final",
      title: "최종화",
      singer: "아이리 칸나",
      genre: "버추얼 아티스트 / 발라드",
      tag: "버추얼",
      year: 2024,
      pickReason: "버추얼 아티스트 음악 선곡을 다양화하기 위해 추가했다.",
      songNumber: "80603",
      songNumberSource: "KY",
      youtubeSearchQuery: "아이리 칸나 최종화 노래방",
      style: "ballad",
    }),
    createNewSong({
      id: "neneko-mashiro-spring-dream",
      title: "봄꿈",
      singer: "네네코 마시로",
      genre: "버추얼 아티스트 / 발라드",
      tag: "버추얼",
      year: 2024,
      pickReason: "버추얼 아티스트의 감성적인 곡으로 선곡을 보강했다.",
      songNumber: "71052",
      songNumberSource: "TJ",
      youtubeSearchQuery: "네네코 마시로 봄꿈 노래방",
      style: "ballad",
    }),
    createNewSong({
      id: "ayatsuno-yuni-how-to-be-mine",
      title: "내꺼 하는 법",
      singer: "아야츠노 유니",
      genre: "버추얼 아티스트 / 팝",
      tag: "버추얼",
      year: 2023,
      pickReason: "밝은 분위기의 버추얼 아티스트 곡으로 추가했다.",
      songNumber: "99555",
      songNumberSource: "KY",
      youtubeSearchQuery: "아야츠노 유니 내꺼 하는 법 노래방",
    }),
    createNewSong({
      id: "aokumo-rin-maid-my-way",
      title: "Maid My Way",
      singer: "아오쿠모 린",
      genre: "버추얼 아티스트 / 팝",
      tag: "버추얼",
      year: 2024,
      pickReason: "버추얼 아티스트 음악 선곡을 확장하기 위해 추가했다.",
      songNumber: "51798",
      songNumberSource: "KY",
      youtubeSearchQuery: "아오쿠모 린 Maid My Way 노래방",
    }),
  ],

  // ------------------------------------------------------------
  // 국내 힙합
  // ------------------------------------------------------------

  ...[
    createNewSong({
      id: "dynamic-duo-guilty",
      title: "죽일 놈",
      singer: "다이나믹 듀오",
      genre: "힙합",
      year: 2009,
      pickReason: "세대를 아우르는 국내 힙합 대표곡으로 추가했다.",
      songNumber: "84559",
      songNumberSource: "KY",
      youtubeSearchQuery: "다이나믹 듀오 죽일 놈 노래방",
      style: "dance",
    }),
  ],

  // ------------------------------------------------------------
  // Mrs. GREEN APPLE
  // ------------------------------------------------------------

  ...[
    createNewSong({
      id: "mrs-green-apple-nanarai",
      title: "나라는 것",
      singer: "Mrs. GREEN APPLE",
      genre: "J-POP / 록",
      tag: "J-POP",
      year: 2016,
      pickReason: "Mrs. GREEN APPLE의 초기 대표곡으로 일본 밴드 음악 선곡을 보강했다.",
      songNumber: "44894",
      songNumberSource: "KY",
      youtubeSearchQuery: "Mrs GREEN APPLE 나라는 것 노래방",
      style: "rock",
    }),
    createNewSong({
      id: "mrs-green-apple-inferno",
      title: "Inferno",
      singer: "Mrs. GREEN APPLE",
      genre: "J-POP / 록",
      tag: "J-POP",
      year: 2019,
      pickReason: "애니메이션 주제가로 잘 알려진 대표적인 일본 록 곡으로 추가했다.",
      songNumber: "44455",
      songNumberSource: "KY",
      youtubeSearchQuery: "Mrs GREEN APPLE Inferno 노래방",
      style: "rock",
    }),
    createNewSong({
      id: "mrs-green-apple-lilac",
      title: "라일락",
      singer: "Mrs. GREEN APPLE",
      genre: "J-POP / 록",
      tag: "J-POP",
      year: 2024,
      pickReason: "최근 큰 인기를 얻은 Mrs. GREEN APPLE의 대표곡으로 추가했다.",
      songNumber: "75996",
      songNumberSource: "KY",
      youtubeSearchQuery: "Mrs GREEN APPLE ライラック 노래방",
      style: "rock",
    }),
    createNewSong({
      id: "mrs-green-apple-dance-hall",
      title: "Dance Hall",
      singer: "Mrs. GREEN APPLE",
      genre: "J-POP / 팝",
      tag: "J-POP",
      year: 2022,
      pickReason: "밝고 경쾌한 일본 팝 곡으로 선곡 분위기를 다양화하기 위해 추가했다.",
      songNumber: "44808",
      songNumberSource: "KY",
      youtubeSearchQuery: "Mrs GREEN APPLE Dance Hall 노래방",
    }),
  ],
];

/** 이 곡의 기본 후보 중 첫 번째 */
export function firstCandidate(song: KaraokeSong): string | null {
  return song.youtubeCandidates[0] ?? null;
}

/** id로 곡 찾기 */
export function findSongById(id: string): KaraokeSong | undefined {
  return KARAOKE_SONGS.find((s) => s.id === id);
}

/** 로컬 미디어 파일 경로 */
export function localMediaPath(song: KaraokeSong): string | null {
  return song.localMediaExt
    ? `/media/karaoke/${song.id}.${song.localMediaExt}`
    : null;
}

/** 유튜브 검색 결과 페이지 URL */
export function youtubeSearchUrl(song: KaraokeSong): string {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(
    song.youtubeSearchQuery,
  )}`;
}
