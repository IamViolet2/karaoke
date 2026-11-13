
/**
 * 마이크 실시간 음정/음량 분석 + 노래방 채점 모듈 (Web Audio API)
 *
 * 채점 기준
 * - 실제 발성이 없으면 0점
 * - 실제 발성이 확인되면 15~100점
 * - 중도 종료 시점까지 누적된 데이터로 채점
 * - 음정 35점 / 박자·지속성 30점 / 성량 20점 / 표현력 15점
 *
 * 주의:
 * 현재 모듈은 반주 멜로디를 기준으로 음정을 비교하지 않는다.
 * 가장 가까운 반음에서 벗어난 정도를 기준으로 음정 안정성을 평가한다.
 */

export interface AudioAnalysisResult {
  volume: number;
  pitch: number;
  note: string;
  cents: number;
}

export interface ScoreBreakdown {
  pitch: number;
  timing: number;
  volume: number;
  expression: number;
}

export interface FinalScore {
  score: number;
  comment: string;
  rank: string;
  breakdown: ScoreBreakdown;
  sangSomething: boolean;
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const DEFAULT_VOICE_THRESHOLD = 12;
const NOISE_MARGIN = 8;
const BASELINE_DURATION_MS = 1500;

// 실제 노래로 인정하기 위한 최소 발성 누적 시간
const MINIMUM_VOICED_DURATION_MS = 500;

// 발성이 잠깐 끊겨도 같은 구간으로 인정할 최대 간격
const MAX_VOICED_GAP_MS = 120;

export class KaraokeAudioScorer {
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private micStream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private animFrameId: number | null = null;
  private onDataCallback: ((data: AudioAnalysisResult) => void) | null = null;

  // 채점 누적 통계
  private sampleCount = 0;
  private voicedFrames = 0;
  private volumeSum = 0;
  private voicedVolumeSum = 0;
  private centsAbsSum = 0;
  private semitoneMin = Infinity;
  private semitoneMax = -Infinity;

  // 음정 변화 통계
  private directionChanges = 0;
  private lastPitch = 0;
  private lastDirection = 0;

  // 시간 통계
  private startedAt = 0;
  private lastSampleAt = 0;
  private lastVoicedAt = 0;
  private voicedDurationMs = 0;

  // 주변 소음 및 발성 임계값
  private voiceThreshold = DEFAULT_VOICE_THRESHOLD;
  private baselineNoise = 0;
  private isMeasuringBaseline = false;
  private baselineSamples: number[] = [];

  private paused = false;

  /* ── 마이크 ─────────────────────────────────────────────── */

  async startMicrophone(
    onData: (data: AudioAnalysisResult) => void
  ): Promise<boolean> {
    this.resetScore();
    this.onDataCallback = onData;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });

      this.micStream = stream;

      const Ctor =
        window.AudioContext ||
        (window as unknown as {
          webkitAudioContext: typeof AudioContext;
        }).webkitAudioContext;

      this.audioCtx = new Ctor();

      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.6;

      this.source = this.audioCtx.createMediaStreamSource(stream);
      this.source.connect(this.analyser);

      this.analyzeLoop();

      return true;
    } catch (err) {
      console.warn("마이크를 사용할 수 없습니다:", err);
      return false;
    }
  }

  stopMicrophone() {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }

    if (this.micStream) {
      this.micStream.getTracks().forEach((track) => track.stop());
      this.micStream = null;
    }

    if (this.audioCtx) {
      void this.audioCtx.close();
      this.audioCtx = null;
    }

    this.source = null;
    this.analyser = null;
  }

  get isRunning() {
    return this.animFrameId !== null;
  }

  get threshold() {
    return {
      voice: this.voiceThreshold,
      baseline: this.baselineNoise,
    };
  }

  /* ── 일시정지 / 재개 ───────────────────────────────────── */

  pauseAnalysis() {
    this.paused = true;

    if (this.audioCtx?.state === "running") {
      void this.audioCtx.suspend();
    }
  }

  resumeAnalysis() {
    this.paused = false;

    if (this.audioCtx?.state === "suspended") {
      void this.audioCtx.resume();
    }
  }

  /* ── 주변 소음 측정 ───────────────────────────────────── */

  async measureBaseline(
    durationMs = BASELINE_DURATION_MS
  ): Promise<{ baseline: number; threshold: number }> {
    if (!this.isRunning) {
      return {
        baseline: 0,
        threshold: this.voiceThreshold,
      };
    }

    this.baselineSamples = [];
    this.isMeasuringBaseline = true;

    await new Promise((resolve) => setTimeout(resolve, durationMs));

    this.isMeasuringBaseline = false;

    const samples = this.baselineSamples;
    this.baselineSamples = [];

    if (samples.length === 0) {
      return {
        baseline: 0,
        threshold: this.voiceThreshold,
      };
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const p80 =
      sorted[Math.floor(sorted.length * 0.8)] ??
      sorted[sorted.length - 1];

    this.baselineNoise = Math.round(p80);

    this.voiceThreshold = Math.max(
      DEFAULT_VOICE_THRESHOLD,
      this.baselineNoise + NOISE_MARGIN
    );

    return {
      baseline: this.baselineNoise,
      threshold: this.voiceThreshold,
    };
  }

  /* ── 분석 루프 ─────────────────────────────────────────── */

  private analyzeLoop = () => {
    if (!this.analyser) return;

    const size = this.analyser.fftSize;
    const timeData = new Float32Array(size);

    this.analyser.getFloatTimeDomainData(timeData);

    // RMS 음량 계산
    let sum = 0;

    for (let i = 0; i < size; i++) {
      sum += timeData[i] * timeData[i];
    }

    const rms = Math.sqrt(sum / size);
    const volume = Math.min(100, Math.round(rms * 400));

    // 주변 소음 측정 중
    if (this.isMeasuringBaseline) {
      this.baselineSamples.push(volume);

      this.onDataCallback?.({
        volume,
        pitch: 0,
        note: "-",
        cents: 0,
      });

      this.animFrameId = requestAnimationFrame(this.analyzeLoop);
      return;
    }

    // 일시정지 중에는 채점 통계를 쌓지 않는다
    if (this.paused) {
      this.onDataCallback?.({
        volume,
        pitch: 0,
        note: "-",
        cents: 0,
      });

      this.animFrameId = requestAnimationFrame(this.analyzeLoop);
      return;
    }

    const pitch = this.detectPitch(
      timeData,
      this.audioCtx?.sampleRate ?? 44100
    );

    let cents = 0;
    let note = "-";

    if (pitch > 0) {
      const midi = 69 + 12 * Math.log2(pitch / 440);
      const nearest = Math.round(midi);

      cents = Math.round((midi - nearest) * 100);
      note = NOTE_NAMES[((nearest % 12) + 12) % 12];
    }

    this.markSample();
    this.volumeSum += volume;

    const voiced =
      volume > this.voiceThreshold &&
      pitch > 70 &&
      pitch < 1400;

    if (voiced) {
      const now = Date.now();

      this.voicedFrames++;
      this.voicedVolumeSum += volume;
      this.centsAbsSum += Math.abs(cents);

      // 실제 발성 시간 누적
      if (
        this.lastVoicedAt > 0 &&
        now - this.lastVoicedAt <= MAX_VOICED_GAP_MS
      ) {
        this.voicedDurationMs += now - this.lastVoicedAt;
      }

      this.lastVoicedAt = now;

      // 사용 음역 기록
      const midi = 69 + 12 * Math.log2(pitch / 440);

      this.semitoneMin = Math.min(this.semitoneMin, midi);
      this.semitoneMax = Math.max(this.semitoneMax, midi);

      // 음정 방향 변화 기록
      // 아주 작은 주파수 흔들림은 방향 변화로 인정하지 않는다.
      if (this.lastPitch > 0) {
        const previousMidi =
          69 + 12 * Math.log2(this.lastPitch / 440);

        const semitoneDifference = midi - previousMidi;
        const centsDifference = semitoneDifference * 100;

        const direction =
          Math.abs(centsDifference) < 25
            ? 0
            : centsDifference > 0
              ? 1
              : -1;

        if (
          direction !== 0 &&
          this.lastDirection !== 0 &&
          direction !== this.lastDirection
        ) {
          this.directionChanges++;
        }

        if (direction !== 0) {
          this.lastDirection = direction;
        }
      }

      this.lastPitch = pitch;
    } else {
      // 발성이 끊기면 다음 발성과의 방향 변화가 연결되지 않도록 한다.
      if (
        this.lastVoicedAt > 0 &&
        Date.now() - this.lastVoicedAt > MAX_VOICED_GAP_MS
      ) {
        this.lastPitch = 0;
        this.lastDirection = 0;
      }
    }

    this.onDataCallback?.({
      volume,
      pitch,
      note,
      cents,
    });

    this.animFrameId = requestAnimationFrame(this.analyzeLoop);
  };

  /* ── 피치 검출 ─────────────────────────────────────────── */

  private detectPitch(
    buffer: Float32Array,
    sampleRate: number
  ): number {
    const SIZE = buffer.length;

    let rms = 0;

    for (let i = 0; i < SIZE; i++) {
      rms += buffer[i] * buffer[i];
    }

    rms = Math.sqrt(rms / SIZE);

    if (rms < 0.015) return 0;

    const minLag = Math.floor(sampleRate / 1400);
    const maxLag = Math.min(
      Math.floor(sampleRate / 70),
      Math.floor(SIZE / 2)
    );

    let bestLag = -1;
    let bestCorr = 0;
    let prevCorr = 0;

    const corr = new Float32Array(maxLag + 2);

    for (let lag = minLag; lag <= maxLag; lag++) {
      let c = 0;
      let normA = 0;
      let normB = 0;

      for (let i = 0; i < SIZE - lag; i++) {
        c += buffer[i] * buffer[i + lag];
        normA += buffer[i] * buffer[i];
        normB += buffer[i + lag] * buffer[i + lag];
      }

      const norm = Math.sqrt(normA * normB);
      const value = norm > 0 ? c / norm : 0;

      corr[lag] = value;

      if (value > 0.9 && value < prevCorr && bestLag === -1) {
        bestLag = lag - 1;
        bestCorr = prevCorr;
        break;
      }

      if (value > bestCorr) {
        bestCorr = value;
        bestLag = lag;
      }

      prevCorr = value;
    }

    if (bestLag <= minLag || bestCorr < 0.55) {
      return 0;
    }

    const y0 = corr[bestLag - 1] ?? bestCorr;
    const y1 = corr[bestLag];
    const y2 = corr[bestLag + 1] ?? bestCorr;

    const denom = 2 * (2 * y1 - y0 - y2);
    const shift = denom !== 0 ? (y2 - y0) / denom : 0;

    const refined =
      bestLag + Math.max(-1, Math.min(1, shift));

    const freq = sampleRate / refined;

    return freq > 70 && freq < 1400
      ? Math.round(freq)
      : 0;
  }

  /* ── 채점 통계 ─────────────────────────────────────────── */

  private markSample() {
    const now = Date.now();

    if (this.startedAt === 0) {
      this.startedAt = now;
    }

    this.lastSampleAt = now;
    this.sampleCount++;
  }

  private get elapsedSec(): number {
    if (this.startedAt === 0) return 0;

    return Math.max(
      0,
      (this.lastSampleAt - this.startedAt) / 1000
    );
  }

  resetScore() {
    // 주변 소음 임계값은 곡이 바뀌어도 유지한다.
    this.paused = false;

    this.startedAt = 0;
    this.lastSampleAt = 0;
    this.lastVoicedAt = 0;
    this.voicedDurationMs = 0;

    this.sampleCount = 0;
    this.voicedFrames = 0;

    this.volumeSum = 0;
    this.voicedVolumeSum = 0;
    this.centsAbsSum = 0;

    this.semitoneMin = Infinity;
    this.semitoneMax = -Infinity;

    this.directionChanges = 0;
    this.lastPitch = 0;
    this.lastDirection = 0;
  }

  /* ── 가상보컬 ─────────────────────────────────────────── */

  feedSimulatedFrame(volume: number, pitch: number) {
    this.markSample();

    this.volumeSum += volume;

    if (volume > this.voiceThreshold && pitch > 70) {
      this.voicedFrames++;
      this.voicedVolumeSum += volume;

      // 기존 가상보컬 입력 동작 유지
      this.centsAbsSum += 8 + Math.random() * 14;

      const midi = 69 + 12 * Math.log2(pitch / 440);

      this.semitoneMin = Math.min(this.semitoneMin, midi);
      this.semitoneMax = Math.max(this.semitoneMax, midi);

      if (Math.random() < 0.35) {
        this.directionChanges++;
      }
    }
  }

  /* ── 최종 점수 계산 ───────────────────────────────────── */

  calculateFinalScore(): FinalScore {
    const frames = this.sampleCount;

    const voicedRatio =
      frames > 0
        ? this.voicedFrames / frames
        : 0;

    const voicedSec = this.voicedDurationMs / 1000;

    // 실제 발성이 일정 시간 이상 확인되지 않으면 0점
    const sangSomething =
      voicedSec >= MINIMUM_VOICED_DURATION_MS / 1000 &&
      this.voicedFrames >= 8;

    if (!sangSomething) {
      return {
        score: 0,
        comment:
          "노랫소리가 감지되지 않았습니다. 마이크에 대고 노래를 불러 주세요!",
        rank: "-",
        breakdown: {
          pitch: 0,
          timing: 0,
          volume: 0,
          expression: 0,
        },
        sangSomething: false,
      };
    }

    // ① 음정 정확도 (35점)
    // 가장 가까운 반음에서 벗어난 평균 cents를 평가한다.
    const avgCents =
      this.voicedFrames > 0
        ? this.centsAbsSum / this.voicedFrames
        : 50;

    const pitchScore = Math.round(
      35 * Math.max(0, 1 - avgCents / 50)
    );

    // ② 박자·지속성 (30점)
    // 노래에는 간주와 쉼표가 있으므로 발성 비율 약 35%부터 만점에 도달한다.
    const timingScore = Math.round(
      30 * Math.min(1, voicedRatio / 0.35)
    );

    // ③ 성량 (20점)
    // 무조건 큰 소리보다 적정한 성량을 가장 높게 평가한다.
    const avgVoicedVol =
      this.voicedFrames > 0
        ? this.voicedVolumeSum / this.voicedFrames
        : 0;

    let volumeScore = 0;

    if (avgVoicedVol < 15) {
      volumeScore = (avgVoicedVol / 15) * 8;
    } else if (avgVoicedVol < 35) {
      volumeScore =
        8 + ((avgVoicedVol - 15) / 20) * 8;
    } else if (avgVoicedVol <= 55) {
      volumeScore =
        16 + ((avgVoicedVol - 35) / 20) * 4;
    } else if (avgVoicedVol <= 70) {
      volumeScore = 20;
    } else {
      volumeScore = Math.max(
        12,
        20 - ((avgVoicedVol - 70) / 30) * 8
      );
    }

    volumeScore = Math.round(
      Math.max(0, Math.min(20, volumeScore))
    );

    // ④ 표현력 (15점)
    // 음역 활용 9점 + 의미 있는 음정 방향 변화 6점
    const range =
      Number.isFinite(this.semitoneMin) &&
      Number.isFinite(this.semitoneMax)
        ? this.semitoneMax - this.semitoneMin
        : 0;

    const rangeScore =
      Math.min(1, range / 12) * 9;

    // 단순한 작은 흔들림은 위에서 제외했으며,
    // 방향 변화 횟수를 발성 시간으로 나눠 과도한 점수를 방지한다.
    const vibratoRate =
      this.directionChanges / Math.max(1, voicedSec);

    const vibratoScore =
      Math.min(1, vibratoRate / 4) * 6;

    const expressionScore = Math.round(
      Math.max(0, Math.min(15, rangeScore + vibratoScore))
    );

    const raw =
      pitchScore +
      timingScore +
      volumeScore +
      expressionScore;

    // 실제로 노래를 불렀다면 최소 15점, 최대 100점
    const score = Math.max(
      15,
      Math.min(100, Math.round(raw))
    );

    let comment = "좋은 무대였어요! 조금씩 더 연습해 봐요!";
    let rank = "C";

    if (score >= 97) {
      comment = "전교 1등 가수! 정말 완벽한 무대였습니다!";
      rank = "SSS";
    } else if (score >= 93) {
      comment = "음정과 가창력이 아주 뛰어납니다!";
      rank = "SS";
    } else if (score >= 88) {
      comment = "훌륭한 가창력! 관객을 사로잡았습니다!";
      rank = "S";
    } else if (score >= 82) {
      comment = "안정적인 무대였습니다! 정말 잘 불렀어요!";
      rank = "A+";
    } else if (score >= 74) {
      comment = "즐겁게 잘 불렀어요! 조금 더 연습해 봐요!";
      rank = "A";
    } else if (score >= 60) {
      comment = "노래를 잘 마쳤어요! 음정과 박자를 더 연습해 봐요!";
      rank = "B";
    }

    return {
      score,
      comment,
      rank,
      breakdown: {
        pitch: pitchScore,
        timing: timingScore,
        volume: volumeScore,
        expression: expressionScore,
      },
      sangSomething: true,
    };
  }

  /* ── 효과음 ─────────────────────────────────────────────── */

  private static withCtx(
    run: (ctx: AudioContext) => number
  ) {
    try {
      const Ctor =
        window.AudioContext ||
        (window as unknown as {
          webkitAudioContext: typeof AudioContext;
        }).webkitAudioContext;

      const ctx = new Ctor();
      const lifetimeMs = run(ctx);

      setTimeout(() => void ctx.close(), lifetimeMs);
    } catch {
      // 오디오를 사용할 수 없는 환경에서는 건너뛴다.
    }
  }

  static playFanfareSound() {
    KaraokeAudioScorer.withCtx((ctx) => {
      const notes = [
        { freq: 523.25, time: 0.0, dur: 0.15 },
        { freq: 659.25, time: 0.15, dur: 0.15 },
        { freq: 783.99, time: 0.3, dur: 0.15 },
        { freq: 1046.5, time: 0.45, dur: 0.35 },
        { freq: 783.99, time: 0.8, dur: 0.15 },
        { freq: 1046.5, time: 0.95, dur: 0.7 },
      ];

      notes.forEach(({ freq, time, dur }) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = "triangle";
        osc.frequency.setValueAtTime(
          freq,
          ctx.currentTime + time
        );

        gain.gain.setValueAtTime(
          0.0001,
          ctx.currentTime + time
        );

        gain.gain.exponentialRampToValueAtTime(
          0.2,
          ctx.currentTime + time + 0.01
        );

        gain.gain.exponentialRampToValueAtTime(
          0.0001,
          ctx.currentTime + time + dur
        );

        osc.connect(gain).connect(ctx.destination);

        osc.start(ctx.currentTime + time);
        osc.stop(ctx.currentTime + time + dur);
      });

      return 2200;
    });
  }

  static playDrumrollSound() {
    KaraokeAudioScorer.withCtx((ctx) => {
      for (let i = 0; i < 20; i++) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = "sine";

        const t = ctx.currentTime + i * 0.055;

        osc.frequency.setValueAtTime(
          130 + Math.random() * 50,
          t
        );

        gain.gain.setValueAtTime(0.13, t);

        gain.gain.exponentialRampToValueAtTime(
          0.001,
          t + 0.05
        );

        osc.connect(gain).connect(ctx.destination);

        osc.start(t);
        osc.stop(t + 0.05);
      }

      return 1600;
    });
  }
}
