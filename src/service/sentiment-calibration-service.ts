import {
  CalibrationAnalysisResult,
  CalibrationConvergenceResult,
  CalibrationOffsetRecommendation,
  ConfusionPair,
  DriftDetectionResult,
  calibrationAnalysisResultSchema,
  calibrationConvergenceResultSchema,
  calibrationOffsetRecommendationSchema,
  driftDetectionResultSchema,
} from '../contracts/calibration';
import { SentimentPolarity } from '../contracts/roles';
import { CalibrationSampleRecord } from '../contracts/sentiment-persistence';
import { SentimentStore } from '../store/sentiment-store';
import {
  RuntimeObservability,
  noopRuntimeObservability,
} from '../observability/runtime-observability';

export interface CalibrationAnalysisOptions {
  useCase?: string;
  engagementType?: string;
  windowDays?: number;
}

export interface DriftDetectionOptions {
  baselineDays?: number;
  recentDays?: number;
}

export interface CalibrationOffsetOptions {
  useCase?: string;
  engagementType?: string;
}

export interface ConvergenceTrackingOptions {
  windowDays?: number;
  totalDays?: number;
  minimumSamplesPerWindow?: number;
}

const POLARITY_ORDER: SentimentPolarity[] = [
  'VERY_NEGATIVE', 'NEGATIVE', 'NEUTRAL', 'POSITIVE', 'VERY_POSITIVE',
];

export class SentimentCalibrationService {
  constructor(
    private readonly sentimentStore: SentimentStore,
    private readonly observability: RuntimeObservability = noopRuntimeObservability,
  ) {}

  async analyzeCalibration(
    tenantId: string,
    options: CalibrationAnalysisOptions = {},
  ): Promise<CalibrationAnalysisResult> {
    const span = this.observability.startSpan('sentiment_calibration.analyze');
    const windowDays = options.windowDays ?? 90;
    const sinceDate = new Date(Date.now() - windowDays * 86400_000).toISOString();

    const samples = await this.sentimentStore.listCalibrationSamples({
      tenantId,
      useCase: options.useCase,
      engagementType: options.engagementType,
      sinceDate,
    });

    if (samples.length === 0) {
      span.end('ok', { sample_size: 0 });
      return calibrationAnalysisResultSchema.parse({
        tenantId,
        sampleSize: 0,
        avgSignedDelta: 0,
        avgAbsoluteDelta: 0,
        confusionPairs: [],
        rootCauses: [],
      });
    }

    const avgSignedDelta = samples.reduce((sum, s) => sum + s.deltaScore100, 0) / samples.length;
    const avgAbsoluteDelta = samples.reduce((sum, s) => sum + Math.abs(s.deltaScore100), 0) / samples.length;

    const confusionPairs = this.buildConfusionPairs(samples);
    const rootCauses = this.inferRootCauses(confusionPairs, avgSignedDelta);

    const byEngagementType = this.groupByEngagementType(samples);

    span.end('ok', {
      sample_size: samples.length,
      avg_absolute_delta: avgAbsoluteDelta,
      root_cause_count: rootCauses.length,
    });

    return calibrationAnalysisResultSchema.parse({
      tenantId,
      sampleSize: samples.length,
      avgSignedDelta: Math.round(avgSignedDelta * 100) / 100,
      avgAbsoluteDelta: Math.round(avgAbsoluteDelta * 100) / 100,
      confusionPairs,
      rootCauses,
      byEngagementType: Object.keys(byEngagementType).length > 0 ? byEngagementType : undefined,
    });
  }

  async detectDrift(
    tenantId: string,
    options: DriftDetectionOptions = {},
  ): Promise<DriftDetectionResult> {
    const span = this.observability.startSpan('sentiment_calibration.detect_drift');
    const baselineDays = options.baselineDays ?? 90;
    const recentDays = options.recentDays ?? 14;

    const sparkline = await this.sentimentStore.getSentimentTrend(tenantId, 'day', baselineDays);

    const baselineAnalyses = await this.sentimentStore.listSentimentAnalyses({
      tenantId,
      limit: 500,
    });

    const now = Date.now();
    const recentCutoff = new Date(now - recentDays * 86400_000).toISOString();
    const baselineCutoff = new Date(now - baselineDays * 86400_000).toISOString();

    const baseline = baselineAnalyses.filter(
      (a) => a.analyzedAt >= baselineCutoff && a.analyzedAt < recentCutoff,
    );
    const recent = baselineAnalyses.filter(
      (a) => a.analyzedAt >= recentCutoff,
    );

    const baselineAvg = baseline.length > 0
      ? baseline.reduce((sum, a) => sum + a.score100, 0) / baseline.length
      : 50;
    const recentAvg = recent.length > 0
      ? recent.reduce((sum, a) => sum + a.score100, 0) / recent.length
      : 50;

    const drift = recentAvg - baselineAvg;
    const driftSignificant = Math.abs(drift) >= 5 && baseline.length >= 10 && recent.length >= 5;

    const trendDirection = drift > 3 ? 'improving' as const
      : drift < -3 ? 'declining' as const
      : 'stable' as const;

    span.end('ok', {
      drift: Math.round(drift * 100) / 100,
      significant: driftSignificant,
      direction: trendDirection,
    });

    return driftDetectionResultSchema.parse({
      tenantId,
      baselineAvgScore100: Math.round(baselineAvg * 100) / 100,
      recentAvgScore100: Math.round(recentAvg * 100) / 100,
      drift: Math.round(drift * 100) / 100,
      driftSignificant,
      trendDirection,
      baselineSampleSize: baseline.length,
      recentSampleSize: recent.length,
      sparkline,
    });
  }

  async recommendCalibrationOffset(
    tenantId: string,
    options: CalibrationOffsetOptions = {},
  ): Promise<CalibrationOffsetRecommendation> {
    const span = this.observability.startSpan('sentiment_calibration.recommend_offset');

    const samples = await this.sentimentStore.listCalibrationSamples({
      tenantId,
      useCase: options.useCase,
      engagementType: options.engagementType,
    });

    if (samples.length === 0) {
      span.end('ok', { sample_size: 0 });
      return calibrationOffsetRecommendationSchema.parse({
        tenantId,
        recommendedScore100Offset: 0,
        sampleSize: 0,
        confidence: 'low',
      });
    }

    const avgDelta = samples.reduce((sum, s) => sum + s.deltaScore100, 0) / samples.length;
    const recommended = Math.round(Math.max(-20, Math.min(20, avgDelta)));
    const confidence = samples.length >= 50 ? 'high' as const
      : samples.length >= 20 ? 'medium' as const
      : 'low' as const;

    const byEngagementType = this.buildEngagementTypeOffsets(samples);

    span.end('ok', {
      sample_size: samples.length,
      recommended_offset: recommended,
      confidence,
    });

    return calibrationOffsetRecommendationSchema.parse({
      tenantId,
      recommendedScore100Offset: recommended,
      sampleSize: samples.length,
      confidence,
      byEngagementType: Object.keys(byEngagementType).length > 0 ? byEngagementType : undefined,
    });
  }

  async trackCalibrationConvergence(
    tenantId: string,
    options: ConvergenceTrackingOptions = {},
  ): Promise<CalibrationConvergenceResult> {
    const span = this.observability.startSpan('sentiment_calibration.track_convergence');
    const windowDays = options.windowDays ?? 14;
    const totalDays = options.totalDays ?? 90;
    const minSamples = options.minimumSamplesPerWindow ?? 5;
    const minimumWindowsRequired = 2;

    const sinceDate = new Date(Date.now() - totalDays * 86400_000).toISOString();
    const samples = await this.sentimentStore.listCalibrationSamples({ tenantId, sinceDate });

    if (samples.length === 0) {
      span.end('ok', { trend: 'insufficient_data', windows: 0 });
      return calibrationConvergenceResultSchema.parse({
        tenantId,
        windows: [],
        trend: 'insufficient_data',
        overallMae: 0,
        latestMae: 0,
        maeChangeRate: 0,
        windowCount: 0,
        minimumWindowsRequired,
      });
    }

    const now = Date.now();
    const windowMs = windowDays * 86400_000;
    const windowCount = Math.ceil(totalDays / windowDays);
    const windows: Array<{ windowStart: string; windowEnd: string; sampleSize: number; mae: number }> = [];

    for (let i = 0; i < windowCount; i++) {
      const windowEnd = new Date(now - i * windowMs);
      const windowStart = new Date(windowEnd.getTime() - windowMs);
      const windowSamples = samples.filter((s) => {
        const t = s.createdAt;
        return t >= windowStart.toISOString() && t < windowEnd.toISOString();
      });

      if (windowSamples.length >= minSamples) {
        const mae = windowSamples.reduce((sum, s) => sum + Math.abs(s.deltaScore100), 0) / windowSamples.length;
        windows.unshift({
          windowStart: windowStart.toISOString(),
          windowEnd: windowEnd.toISOString(),
          sampleSize: windowSamples.length,
          mae: Number(mae.toFixed(2)),
        });
      }
    }

    const overallMae = samples.reduce((sum, s) => sum + Math.abs(s.deltaScore100), 0) / samples.length;
    const latestMae = windows.length > 0 ? windows[windows.length - 1].mae : overallMae;

    let trend: 'converging' | 'oscillating' | 'stable' | 'insufficient_data';
    let maeChangeRate = 0;

    if (windows.length < minimumWindowsRequired) {
      trend = 'insufficient_data';
    } else {
      const deltas: number[] = [];
      for (let i = 1; i < windows.length; i++) {
        deltas.push(windows[i].mae - windows[i - 1].mae);
      }

      const negativeCount = deltas.filter((d) => d < -0.5).length;
      const positiveCount = deltas.filter((d) => d > 0.5).length;
      let signChanges = 0;
      for (let i = 1; i < deltas.length; i++) {
        if ((deltas[i] > 0.5 && deltas[i - 1] < -0.5) || (deltas[i] < -0.5 && deltas[i - 1] > 0.5)) {
          signChanges++;
        }
      }

      maeChangeRate = Number(((windows[windows.length - 1].mae - windows[0].mae) / (windows.length - 1)).toFixed(2));

      if (signChanges >= 2) {
        trend = 'oscillating';
      } else if (negativeCount > positiveCount && negativeCount >= deltas.length / 2) {
        trend = 'converging';
      } else if (positiveCount > negativeCount && positiveCount >= deltas.length / 2) {
        trend = 'oscillating';
      } else {
        trend = 'stable';
      }
    }

    span.end('ok', { trend, windows: windows.length });

    return calibrationConvergenceResultSchema.parse({
      tenantId,
      windows,
      trend,
      overallMae: Number(overallMae.toFixed(2)),
      latestMae: Number(latestMae.toFixed(2)),
      maeChangeRate,
      windowCount: windows.length,
      minimumWindowsRequired,
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private buildConfusionPairs(samples: CalibrationSampleRecord[]): ConfusionPair[] {
    const polarityFromScore = (score100: number): SentimentPolarity => {
      if (score100 <= 15) return 'VERY_NEGATIVE';
      if (score100 <= 35) return 'NEGATIVE';
      if (score100 <= 65) return 'NEUTRAL';
      if (score100 <= 85) return 'POSITIVE';
      return 'VERY_POSITIVE';
    };

    const counts = new Map<string, number>();
    let misclassified = 0;

    for (const s of samples) {
      const predicted = s.modelPolarity;
      const actual = polarityFromScore(s.analystScore100);
      if (predicted !== actual) {
        const key = `${predicted}→${actual}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        misclassified++;
      }
    }

    if (misclassified === 0) return [];

    return Array.from(counts.entries())
      .map(([key, count]) => {
        const [predicted, actual] = key.split('→') as [SentimentPolarity, SentimentPolarity];
        return { predicted, actual, count, percentage: Math.round((count / misclassified) * 10000) / 100 };
      })
      .sort((a, b) => b.count - a.count);
  }

  private inferRootCauses(confusionPairs: ConfusionPair[], avgSignedDelta: number): string[] {
    const causes: string[] = [];

    for (const pair of confusionPairs) {
      const predIdx = POLARITY_ORDER.indexOf(pair.predicted);
      const actIdx = POLARITY_ORDER.indexOf(pair.actual);

      if (pair.predicted === 'NEGATIVE' && pair.actual === 'NEUTRAL' && pair.percentage >= 15) {
        causes.push('Sarcasm detection gap: model reads surface negativity that analysts mark as neutral tone.');
      }
      if (pair.predicted === 'NEUTRAL' && pair.actual === 'POSITIVE' && pair.percentage >= 15) {
        causes.push('Stakeholder baseline not calibrated: model treats satisfied-but-not-effusive language as neutral.');
      }
      if (pair.predicted === 'NEUTRAL' && pair.actual === 'NEGATIVE' && pair.percentage >= 15) {
        causes.push('Understated frustration: model misses polite but dissatisfied language patterns.');
      }
      if (Math.abs(predIdx - actIdx) >= 2 && pair.percentage >= 10) {
        causes.push(`Large polarity gap (${pair.predicted}→${pair.actual}): may indicate segment granularity issue — mixed-sentiment conversations need per-turn analysis.`);
      }
    }

    if (avgSignedDelta > 5) {
      causes.push('Systematic positive bias: model scores consistently higher than analysts.');
    } else if (avgSignedDelta < -5) {
      causes.push('Systematic negative bias: model scores consistently lower than analysts.');
    }

    return [...new Set(causes)];
  }

  private groupByEngagementType(samples: CalibrationSampleRecord[]) {
    const groups = new Map<string, CalibrationSampleRecord[]>();
    for (const s of samples) {
      if (!s.engagementType) continue;
      const list = groups.get(s.engagementType) ?? [];
      list.push(s);
      groups.set(s.engagementType, list);
    }

    const result: Record<string, {
      sampleSize: number;
      avgSignedDelta: number;
      avgAbsoluteDelta: number;
      confusionPairs: ConfusionPair[];
    }> = {};

    for (const [engType, groupSamples] of groups) {
      const avgSigned = groupSamples.reduce((sum, s) => sum + s.deltaScore100, 0) / groupSamples.length;
      const avgAbsolute = groupSamples.reduce((sum, s) => sum + Math.abs(s.deltaScore100), 0) / groupSamples.length;
      result[engType] = {
        sampleSize: groupSamples.length,
        avgSignedDelta: Math.round(avgSigned * 100) / 100,
        avgAbsoluteDelta: Math.round(avgAbsolute * 100) / 100,
        confusionPairs: this.buildConfusionPairs(groupSamples),
      };
    }

    return result;
  }

  private buildEngagementTypeOffsets(samples: CalibrationSampleRecord[]) {
    const groups = new Map<string, CalibrationSampleRecord[]>();
    for (const s of samples) {
      if (!s.engagementType) continue;
      const list = groups.get(s.engagementType) ?? [];
      list.push(s);
      groups.set(s.engagementType, list);
    }

    const result: Record<string, {
      recommendedScore100Offset: number;
      sampleSize: number;
      avgSignedDelta: number;
    }> = {};

    for (const [engType, groupSamples] of groups) {
      const avgDelta = groupSamples.reduce((sum, s) => sum + s.deltaScore100, 0) / groupSamples.length;
      result[engType] = {
        recommendedScore100Offset: Math.round(Math.max(-20, Math.min(20, avgDelta))),
        sampleSize: groupSamples.length,
        avgSignedDelta: Math.round(avgDelta * 100) / 100,
      };
    }

    return result;
  }
}
