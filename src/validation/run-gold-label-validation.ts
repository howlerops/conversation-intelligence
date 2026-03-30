import { z } from 'zod';
import { CanonicalAnalysisEngine } from '../rlm/engine';
import { analyzeConversation } from '../pipeline/analyze-conversation';
import { TenantPackDraft } from '../contracts/tenant-pack';
import { TranscriptInputDraft } from '../contracts/transcript';
import { TenantAdminSentimentScoring } from '../contracts/admin-config';
import { GoldLabelRecord } from './gold-label-toolkit';
import {
  generateHybridGoldLabelDataset,
  HybridGoldLabelOptions,
} from './synthetic-gold-label-generator';
import {
  evaluateKeyMoments,
  KeyMomentEvalResult,
  ExpectedKeyMoment,
} from './key-moment-evaluation';
import { SentimentPolarity } from '../contracts/roles';
import { deriveTranscriptStats } from './transcript-stats';

// ---------------------------------------------------------------------------
// Per-record validation result
// ---------------------------------------------------------------------------

export const goldLabelValidationRecordResultSchema = z.object({
  recordId: z.string().min(1),
  engagementType: z.string().min(1),
  sourceDataset: z.string().optional(),
  isPublicData: z.boolean(),
  transcriptTurnCount: z.number().int().min(0),

  analystScore100: z.number().int().min(0).max(100),
  analystScore5: z.number().int().min(1).max(5),
  analystPolarity: z.string().min(1),

  modelScore100: z.number().int().min(0).max(100).optional(),
  modelScore5: z.number().int().min(1).max(5).optional(),
  modelPolarity: z.string().optional(),

  deltaScore100: z.number().int().min(0).optional(),
  deltaScore5: z.number().int().min(0).optional(),
  polarityMatch: z.boolean().optional(),

  keyMomentPrecision: z.number().min(0).max(1).optional(),
  keyMomentRecall: z.number().min(0).max(1).optional(),
  keyMomentF1: z.number().min(0).max(1).optional(),
  evidenceFidelityRate: z.number().min(0).max(1).optional(),
  expectedKeyMomentCount: z.number().int().min(0),
  detectedKeyMomentCount: z.number().int().min(0).optional(),

  reviewState: z.string().optional(),
  expectedReviewState: z.string().optional(),
  reviewStateMatch: z.boolean().optional(),

  durationMs: z.number().int().min(0),
  status: z.enum(['COMPLETED', 'SKIPPED', 'ERROR']),
  errorMessage: z.string().optional(),
});

export type GoldLabelValidationRecordResult = z.infer<typeof goldLabelValidationRecordResultSchema>;

// ---------------------------------------------------------------------------
// Diagnostic — inferred systemic issue
// ---------------------------------------------------------------------------

export const goldLabelValidationDiagnosticSchema = z.object({
  severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  category: z.string().min(1),
  description: z.string().min(1),
  affectedRecordCount: z.number().int().min(0),
  metric: z.string().optional(),
  metricValue: z.number().optional(),
});

export type GoldLabelValidationDiagnostic = z.infer<typeof goldLabelValidationDiagnosticSchema>;

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const engagementTypeSummarySchema = z.object({
  total: z.number().int().min(0),
  completed: z.number().int().min(0),
  averageDeltaScore100: z.number().min(0).optional(),
  withinFivePointsRate: z.number().min(0).max(1).optional(),
  polarityMatchRate: z.number().min(0).max(1).optional(),
});

export const goldLabelValidationSummarySchema = z.object({
  generatedAt: z.string().min(1),
  totalRecords: z.number().int().min(0),
  publicRecords: z.number().int().min(0),
  syntheticRecords: z.number().int().min(0),
  completed: z.number().int().min(0),
  skipped: z.number().int().min(0),
  errors: z.number().int().min(0),

  averageDeltaScore100: z.number().min(0).optional(),
  averageDeltaScore5: z.number().min(0).optional(),
  withinFivePointsRate: z.number().min(0).max(1).optional(),
  exactScore5MatchRate: z.number().min(0).max(1).optional(),
  polarityMatchRate: z.number().min(0).max(1).optional(),

  keyMomentMacroPrecision: z.number().min(0).max(1).optional(),
  keyMomentMacroRecall: z.number().min(0).max(1).optional(),
  keyMomentMacroF1: z.number().min(0).max(1).optional(),
  averageEvidenceFidelity: z.number().min(0).max(1).optional(),

  byEngagementType: z.record(z.string(), engagementTypeSummarySchema),
  worstRecords: z.array(z.object({
    recordId: z.string().min(1),
    engagementType: z.string().min(1),
    deltaScore100: z.number().optional(),
    reason: z.string().min(1),
  })).max(10),
  diagnostics: z.array(goldLabelValidationDiagnosticSchema),
});

export type GoldLabelValidationSummary = z.infer<typeof goldLabelValidationSummarySchema>;

export interface GoldLabelValidationResult {
  summary: GoldLabelValidationSummary;
  records: GoldLabelValidationRecordResult[];
}

// ---------------------------------------------------------------------------
// Runner options
// ---------------------------------------------------------------------------

export interface GoldLabelValidationOptions {
  engine: CanonicalAnalysisEngine;
  tenantPack: TenantPackDraft;
  pipelineSuitePaths?: string[];
  sentimentScoringConfig?: TenantAdminSentimentScoring;
  concurrency?: number;
  perRecordTimeoutMs?: number;
  hybridOptions?: HybridGoldLabelOptions;
  cwd?: string;
}

// ---------------------------------------------------------------------------
// Main validation function
// ---------------------------------------------------------------------------

export async function runGoldLabelValidation(
  options: GoldLabelValidationOptions,
): Promise<GoldLabelValidationResult> {
  const cwd = options.cwd ?? process.cwd();
  const hybrid = generateHybridGoldLabelDataset(
    { ...options.hybridOptions, pipelineSuitePaths: options.pipelineSuitePaths },
    cwd,
  );

  const results: GoldLabelValidationRecordResult[] = [];

  for (const record of hybrid.records) {
    const transcript = hybrid.transcriptsByRecordId.get(record.recordId);
    const isPublic = hybrid.publicRecords.some((p) => p.recordId === record.recordId);

    if (!transcript) {
      results.push(goldLabelValidationRecordResultSchema.parse({
        recordId: record.recordId,
        engagementType: record.engagementType,
        sourceDataset: record.sourceDataset,
        isPublicData: isPublic,
        transcriptTurnCount: 0,
        analystScore100: record.sentiment.score100,
        analystScore5: record.sentiment.score5,
        analystPolarity: record.sentiment.polarity,
        expectedKeyMomentCount: record.expectedKeyMoments.length,
        durationMs: 0,
        status: 'SKIPPED',
        errorMessage: 'No transcript available for this record.',
      }));
      continue;
    }

    const startedAt = Date.now();
    try {
      const analysis = await analyzeConversation(transcript, options.tenantPack, {
        engine: options.engine,
        now: new Date(),
        sentimentScoringConfig: options.sentimentScoringConfig,
      });

      const modelSentiment = analysis.overallEndUserSentiment;
      const modelScore100 = modelSentiment?.score?.score100;
      const modelScore5 = modelSentiment?.score?.score5;
      const modelPolarity = modelSentiment?.polarity;

      const deltaScore100 = modelScore100 !== undefined ? Math.abs(modelScore100 - record.sentiment.score100) : undefined;
      const deltaScore5 = modelScore5 !== undefined ? Math.abs(modelScore5 - record.sentiment.score5) : undefined;
      const polarityMatch = modelPolarity !== undefined ? modelPolarity === record.sentiment.polarity : undefined;

      // Only evaluate against event types the tenant pack actually supports — otherwise
      // we'd penalise recall for events the model cannot legally emit.
      const supportedTypes = new Set<string>(options.tenantPack.supportedCanonicalEventTypes ?? []);
      const evaluableExpected = supportedTypes.size > 0
        ? record.expectedKeyMoments.filter((km) => supportedTypes.has(km.type))
        : record.expectedKeyMoments;

      let kmEval: KeyMomentEvalResult | undefined;
      if (evaluableExpected.length > 0 || analysis.canonicalKeyMoments.length > 0) {
        kmEval = evaluateKeyMoments(
          record.recordId,
          analysis,
          evaluableExpected,
          { turns: transcript.turns as Array<{ turnId: string; text: string }> },
        );
      }

      const stats = deriveTranscriptStats({ turns: transcript.turns as Array<{ turnId: string; speakerId: string; text: string; metadata: Record<string, unknown> }> });

      results.push(goldLabelValidationRecordResultSchema.parse({
        recordId: record.recordId,
        engagementType: record.engagementType,
        sourceDataset: record.sourceDataset,
        isPublicData: isPublic,
        transcriptTurnCount: stats.transcriptTurnCount,
        analystScore100: record.sentiment.score100,
        analystScore5: record.sentiment.score5,
        analystPolarity: record.sentiment.polarity,
        modelScore100,
        modelScore5,
        modelPolarity,
        deltaScore100,
        deltaScore5,
        polarityMatch,
        keyMomentPrecision: kmEval?.precision,
        keyMomentRecall: kmEval?.recall,
        keyMomentF1: kmEval?.f1,
        evidenceFidelityRate: kmEval?.evidenceFidelityRate,
        expectedKeyMomentCount: evaluableExpected.length,
        detectedKeyMomentCount: analysis.canonicalKeyMoments.length,
        reviewState: analysis.review.state,
        expectedReviewState: record.expectedReviewState,
        reviewStateMatch: record.expectedReviewState ? analysis.review.state === record.expectedReviewState : undefined,
        durationMs: Date.now() - startedAt,
        status: 'COMPLETED',
      }));
    } catch (error) {
      results.push(goldLabelValidationRecordResultSchema.parse({
        recordId: record.recordId,
        engagementType: record.engagementType,
        sourceDataset: record.sourceDataset,
        isPublicData: isPublic,
        transcriptTurnCount: (transcript.turns ?? []).length,
        analystScore100: record.sentiment.score100,
        analystScore5: record.sentiment.score5,
        analystPolarity: record.sentiment.polarity,
        expectedKeyMomentCount: record.expectedKeyMoments.length,
        durationMs: Date.now() - startedAt,
        status: 'ERROR',
        errorMessage: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  return {
    summary: buildSummary(results, hybrid.publicRecords.length, hybrid.syntheticRecords.length),
    records: results,
  };
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

function buildSummary(
  results: GoldLabelValidationRecordResult[],
  publicCount: number,
  syntheticCount: number,
): GoldLabelValidationSummary {
  const completed = results.filter((r) => r.status === 'COMPLETED');
  const compared = completed.filter((r) => r.deltaScore100 !== undefined);

  const avgDelta100 = compared.length > 0
    ? Number((compared.reduce((s, r) => s + (r.deltaScore100 ?? 0), 0) / compared.length).toFixed(2))
    : undefined;
  const avgDelta5 = compared.length > 0
    ? Number((compared.reduce((s, r) => s + (r.deltaScore5 ?? 0), 0) / compared.length).toFixed(2))
    : undefined;
  const within5 = compared.length > 0
    ? Number((compared.filter((r) => (r.deltaScore100 ?? 100) <= 5).length / compared.length).toFixed(4))
    : undefined;
  const exact5 = compared.length > 0
    ? Number((compared.filter((r) => r.deltaScore5 === 0).length / compared.length).toFixed(4))
    : undefined;
  const polarityMatches = completed.filter((r) => r.polarityMatch !== undefined);
  const polarityRate = polarityMatches.length > 0
    ? Number((polarityMatches.filter((r) => r.polarityMatch).length / polarityMatches.length).toFixed(4))
    : undefined;

  const withKm = completed.filter((r) => r.keyMomentF1 !== undefined);
  const kmPrecision = withKm.length > 0
    ? Number((withKm.reduce((s, r) => s + (r.keyMomentPrecision ?? 0), 0) / withKm.length).toFixed(4))
    : undefined;
  const kmRecall = withKm.length > 0
    ? Number((withKm.reduce((s, r) => s + (r.keyMomentRecall ?? 0), 0) / withKm.length).toFixed(4))
    : undefined;
  const kmF1 = kmPrecision !== undefined && kmRecall !== undefined && (kmPrecision + kmRecall) > 0
    ? Number(((2 * kmPrecision * kmRecall) / (kmPrecision + kmRecall)).toFixed(4))
    : undefined;
  const evFidelity = withKm.length > 0
    ? Number((withKm.reduce((s, r) => s + (r.evidenceFidelityRate ?? 1), 0) / withKm.length).toFixed(4))
    : undefined;

  const byEngType: Record<string, { total: number; completed: number; deltas: number[]; polarityMatches: number; polarityTotal: number }> = {};
  for (const r of results) {
    const e = byEngType[r.engagementType] ?? { total: 0, completed: 0, deltas: [], polarityMatches: 0, polarityTotal: 0 };
    e.total++;
    if (r.status === 'COMPLETED') {
      e.completed++;
      if (r.deltaScore100 !== undefined) e.deltas.push(r.deltaScore100);
      if (r.polarityMatch !== undefined) {
        e.polarityTotal++;
        if (r.polarityMatch) e.polarityMatches++;
      }
    }
    byEngType[r.engagementType] = e;
  }

  const byEngagementType: Record<string, z.infer<typeof engagementTypeSummarySchema>> = {};
  for (const [type, e] of Object.entries(byEngType)) {
    byEngagementType[type] = {
      total: e.total,
      completed: e.completed,
      averageDeltaScore100: e.deltas.length > 0 ? Number((e.deltas.reduce((a, b) => a + b, 0) / e.deltas.length).toFixed(2)) : undefined,
      withinFivePointsRate: e.deltas.length > 0 ? Number((e.deltas.filter((d) => d <= 5).length / e.deltas.length).toFixed(4)) : undefined,
      polarityMatchRate: e.polarityTotal > 0 ? Number((e.polarityMatches / e.polarityTotal).toFixed(4)) : undefined,
    };
  }

  const worstRecords = [...compared]
    .sort((a, b) => (b.deltaScore100 ?? 0) - (a.deltaScore100 ?? 0))
    .slice(0, 10)
    .map((r) => ({
      recordId: r.recordId,
      engagementType: r.engagementType,
      deltaScore100: r.deltaScore100,
      reason: r.polarityMatch === false
        ? `Polarity mismatch: model=${r.modelPolarity}, analyst=${r.analystPolarity}`
        : `Score delta: ${r.deltaScore100} points`,
    }));

  const diagnostics = diagnoseValidationResults(results, byEngagementType);

  return goldLabelValidationSummarySchema.parse({
    generatedAt: new Date().toISOString(),
    totalRecords: results.length,
    publicRecords: publicCount,
    syntheticRecords: syntheticCount,
    completed: completed.length,
    skipped: results.filter((r) => r.status === 'SKIPPED').length,
    errors: results.filter((r) => r.status === 'ERROR').length,
    averageDeltaScore100: avgDelta100,
    averageDeltaScore5: avgDelta5,
    withinFivePointsRate: within5,
    exactScore5MatchRate: exact5,
    polarityMatchRate: polarityRate,
    keyMomentMacroPrecision: kmPrecision,
    keyMomentMacroRecall: kmRecall,
    keyMomentMacroF1: kmF1,
    averageEvidenceFidelity: evFidelity,
    byEngagementType,
    worstRecords,
    diagnostics,
  });
}

// ---------------------------------------------------------------------------
// Diagnostic inference
// ---------------------------------------------------------------------------

function diagnoseValidationResults(
  results: GoldLabelValidationRecordResult[],
  byEngType: Record<string, { averageDeltaScore100?: number; withinFivePointsRate?: number; polarityMatchRate?: number }>,
): GoldLabelValidationDiagnostic[] {
  const diagnostics: GoldLabelValidationDiagnostic[] = [];
  const completed = results.filter((r) => r.status === 'COMPLETED');

  const polarityMismatches = completed.filter((r) => r.polarityMatch === false);
  if (polarityMismatches.length > 0) {
    const negToNeutral = polarityMismatches.filter(
      (r) => r.modelPolarity === 'NEGATIVE' && r.analystPolarity === 'NEUTRAL',
    );
    if (negToNeutral.length >= 2 || (completed.length > 0 && negToNeutral.length / completed.length > 0.15)) {
      diagnostics.push({
        severity: 'HIGH',
        category: 'Sarcasm detection gap',
        description: 'Model predicts NEGATIVE when analysts label NEUTRAL — likely misreading sarcastic or dry tone as genuine negativity.',
        affectedRecordCount: negToNeutral.length,
        metric: 'negative_to_neutral_rate',
        metricValue: Number((negToNeutral.length / Math.max(1, polarityMismatches.length)).toFixed(2)),
      });
    }

    const neutralToNeg = polarityMismatches.filter(
      (r) => r.modelPolarity === 'NEUTRAL' && (r.analystPolarity === 'NEGATIVE' || r.analystPolarity === 'VERY_NEGATIVE'),
    );
    if (neutralToNeg.length >= 2) {
      diagnostics.push({
        severity: 'HIGH',
        category: 'Understated frustration',
        description: 'Model predicts NEUTRAL when analysts label NEGATIVE — missing polite but dissatisfied language patterns.',
        affectedRecordCount: neutralToNeg.length,
      });
    }
  }

  const engTypes = Object.entries(byEngType);
  if (engTypes.length >= 2) {
    const sorted = engTypes.filter(([, v]) => v.averageDeltaScore100 !== undefined).sort((a, b) => (a[1].averageDeltaScore100 ?? 0) - (b[1].averageDeltaScore100 ?? 0));
    if (sorted.length >= 2) {
      const best = sorted[0];
      const worst = sorted[sorted.length - 1];
      const gap = (worst[1].averageDeltaScore100 ?? 0) - (best[1].averageDeltaScore100 ?? 0);
      if (gap > 3) {
        diagnostics.push({
          severity: 'MEDIUM',
          category: `${worst[0]} performance gap`,
          description: `${worst[0]} has ${gap.toFixed(1)}pt higher average delta than ${best[0]} — may indicate engagement-type-specific calibration needed.`,
          affectedRecordCount: completed.filter((r) => r.engagementType === worst[0]).length,
          metric: 'engagement_type_delta_gap',
          metricValue: Number(gap.toFixed(2)),
        });
      }
    }
  }

  const withKm = completed.filter((r) => r.keyMomentRecall !== undefined);
  if (withKm.length > 0) {
    const avgRecall = withKm.reduce((s, r) => s + (r.keyMomentRecall ?? 0), 0) / withKm.length;
    if (avgRecall < 0.5) {
      diagnostics.push({
        severity: 'HIGH',
        category: 'Key moment detection gap',
        description: `Key moment recall is ${(avgRecall * 100).toFixed(0)}% — model is missing more than half of expected key moments.`,
        affectedRecordCount: withKm.filter((r) => (r.keyMomentRecall ?? 0) < 0.5).length,
        metric: 'key_moment_macro_recall',
        metricValue: Number(avgRecall.toFixed(4)),
      });
    }
    const avgFidelity = withKm.reduce((s, r) => s + (r.evidenceFidelityRate ?? 1), 0) / withKm.length;
    if (avgFidelity < 0.9) {
      diagnostics.push({
        severity: 'MEDIUM',
        category: 'Evidence extraction hallucination',
        description: `Evidence fidelity is ${(avgFidelity * 100).toFixed(0)}% — some evidence quotes don't match transcript text.`,
        affectedRecordCount: withKm.filter((r) => (r.evidenceFidelityRate ?? 1) < 0.9).length,
        metric: 'evidence_fidelity_rate',
        metricValue: Number(avgFidelity.toFixed(4)),
      });
    }
  }

  const shortRecords = completed.filter((r) => r.transcriptTurnCount <= 3);
  const longRecords = completed.filter((r) => r.transcriptTurnCount > 3);
  if (shortRecords.length >= 3 && longRecords.length >= 3) {
    const shortAvgDelta = shortRecords.filter((r) => r.deltaScore100 !== undefined).reduce((s, r) => s + (r.deltaScore100 ?? 0), 0) / shortRecords.length;
    const longAvgDelta = longRecords.filter((r) => r.deltaScore100 !== undefined).reduce((s, r) => s + (r.deltaScore100 ?? 0), 0) / longRecords.length;
    if (shortAvgDelta > longAvgDelta + 3) {
      diagnostics.push({
        severity: 'MEDIUM',
        category: 'Short transcript accuracy gap',
        description: `Short transcripts (≤3 turns) have ${(shortAvgDelta - longAvgDelta).toFixed(1)}pt higher delta — insufficient context degrades accuracy.`,
        affectedRecordCount: shortRecords.length,
        metric: 'short_vs_long_delta_gap',
        metricValue: Number((shortAvgDelta - longAvgDelta).toFixed(2)),
      });
    }
  }

  const errorRate = results.filter((r) => r.status === 'ERROR').length / Math.max(1, results.length);
  if (errorRate > 0.05) {
    diagnostics.push({
      severity: 'HIGH',
      category: 'Pipeline error rate',
      description: `${(errorRate * 100).toFixed(1)}% of records failed with errors — investigate pipeline stability.`,
      affectedRecordCount: results.filter((r) => r.status === 'ERROR').length,
      metric: 'error_rate',
      metricValue: Number(errorRate.toFixed(4)),
    });
  }

  return diagnostics.sort((a, b) => {
    const severityOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    return severityOrder[a.severity] - severityOrder[b.severity];
  });
}

// ---------------------------------------------------------------------------
// Format human-readable report
// ---------------------------------------------------------------------------

export function formatValidationReport(summary: GoldLabelValidationSummary): string {
  const lines: string[] = [
    '═══════════════════════════════════════════════════════════',
    '  GOLD-LABEL VALIDATION REPORT',
    '═══════════════════════════════════════════════════════════',
    '',
    `  Records: ${summary.totalRecords} total (${summary.publicRecords} public, ${summary.syntheticRecords} synthetic)`,
    `  Completed: ${summary.completed} | Skipped: ${summary.skipped} | Errors: ${summary.errors}`,
    '',
    '  SENTIMENT ACCURACY',
    `    Average Delta Score100: ${summary.averageDeltaScore100?.toFixed(2) ?? 'N/A'}`,
    `    Within 5 Points Rate:  ${summary.withinFivePointsRate !== undefined ? (summary.withinFivePointsRate * 100).toFixed(1) + '%' : 'N/A'}`,
    `    Exact Score5 Match:    ${summary.exactScore5MatchRate !== undefined ? (summary.exactScore5MatchRate * 100).toFixed(1) + '%' : 'N/A'}`,
    `    Polarity Match Rate:   ${summary.polarityMatchRate !== undefined ? (summary.polarityMatchRate * 100).toFixed(1) + '%' : 'N/A'}`,
    '',
    '  KEY MOMENT DETECTION',
    `    Macro Precision: ${summary.keyMomentMacroPrecision !== undefined ? (summary.keyMomentMacroPrecision * 100).toFixed(1) + '%' : 'N/A'}`,
    `    Macro Recall:    ${summary.keyMomentMacroRecall !== undefined ? (summary.keyMomentMacroRecall * 100).toFixed(1) + '%' : 'N/A'}`,
    `    Macro F1:        ${summary.keyMomentMacroF1 !== undefined ? (summary.keyMomentMacroF1 * 100).toFixed(1) + '%' : 'N/A'}`,
    `    Evidence Fidelity: ${summary.averageEvidenceFidelity !== undefined ? (summary.averageEvidenceFidelity * 100).toFixed(1) + '%' : 'N/A'}`,
    '',
    '  BY ENGAGEMENT TYPE',
  ];

  for (const [type, data] of Object.entries(summary.byEngagementType)) {
    lines.push(`    ${type}: ${data.completed}/${data.total} completed, avgDelta=${data.averageDeltaScore100?.toFixed(1) ?? '-'}, within5=${data.withinFivePointsRate !== undefined ? (data.withinFivePointsRate * 100).toFixed(0) + '%' : '-'}, polarity=${data.polarityMatchRate !== undefined ? (data.polarityMatchRate * 100).toFixed(0) + '%' : '-'}`);
  }

  if (summary.diagnostics.length > 0) {
    lines.push('');
    lines.push('  DIAGNOSTICS');
    for (const d of summary.diagnostics) {
      lines.push(`    [${d.severity}] ${d.category}: ${d.description}`);
    }
  }

  if (summary.worstRecords.length > 0) {
    lines.push('');
    lines.push('  WORST PERFORMING RECORDS');
    for (const w of summary.worstRecords.slice(0, 5)) {
      lines.push(`    ${w.recordId} (${w.engagementType}): delta=${w.deltaScore100 ?? '?'} — ${w.reason}`);
    }
  }

  lines.push('');
  lines.push('═══════════════════════════════════════════════════════════');
  return lines.join('\n');
}
