import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { z } from 'zod';
import { sentimentPolaritySchema } from '../contracts/roles';
import { supportCanonicalEventTypeSchema } from '../contracts/tenant-pack';
import { ExpectedKeyMoment, expectedKeyMomentSchema } from './key-moment-evaluation';

// ---------------------------------------------------------------------------
// Gold-label record — a fully reviewed benchmark sample.
// ---------------------------------------------------------------------------

export const goldLabelRecordSchema = z.object({
  recordId: z.string().min(1),
  tenantId: z.string().min(1),
  useCase: z.string().min(1),
  engagementType: z.enum(['CALL', 'EMAIL', 'TICKET', 'CHAT']),
  sourceDataset: z.string().min(1).optional(),
  reviewedBy: z.string().min(1),
  reviewedAt: z.string().min(1),
  status: z.enum(['ACCEPTED', 'CORRECTED', 'REJECTED']),
  sentiment: z.object({
    score100: z.number().int().min(0).max(100),
    score5: z.number().int().min(1).max(5),
    polarity: sentimentPolaritySchema,
    correctionApplied: z.boolean(),
    note: z.string().optional(),
  }),
  expectedKeyMoments: z.array(expectedKeyMomentSchema).default([]),
  expectedReviewState: z.enum(['VERIFIED', 'NEEDS_REVIEW', 'UNCERTAIN']).optional(),
  transcriptHash: z.string().min(1).optional(),
});

export type GoldLabelRecord = z.infer<typeof goldLabelRecordSchema>;

// ---------------------------------------------------------------------------
// Gold-label dataset — a collection of reviewed records.
// ---------------------------------------------------------------------------

export const goldLabelDatasetSummarySchema = z.object({
  totalRecords: z.number().int().min(0),
  accepted: z.number().int().min(0),
  corrected: z.number().int().min(0),
  rejected: z.number().int().min(0),
  byEngagementType: z.record(z.string(), z.number().int().min(0)),
  byReviewer: z.record(z.string(), z.number().int().min(0)),
  coverageGaps: z.array(z.string()),
  statisticallySignificant: z.boolean(),
});

export type GoldLabelDatasetSummary = z.infer<typeof goldLabelDatasetSummarySchema>;

// ---------------------------------------------------------------------------
// Inter-annotator agreement — Cohen's kappa for sentiment labels.
// ---------------------------------------------------------------------------

export const interAnnotatorAgreementSchema = z.object({
  annotatorA: z.string().min(1),
  annotatorB: z.string().min(1),
  recordCount: z.number().int().min(0),
  rawAgreement: z.number().min(0).max(1),
  cohensKappa: z.number().min(-1).max(1),
  interpretation: z.enum(['poor', 'slight', 'fair', 'moderate', 'substantial', 'almost_perfect']),
});

export type InterAnnotatorAgreement = z.infer<typeof interAnnotatorAgreementSchema>;

// ---------------------------------------------------------------------------
// Load gold-label dataset from JSONL file.
// ---------------------------------------------------------------------------

export async function loadGoldLabelDataset(path: string): Promise<GoldLabelRecord[]> {
  if (!existsSync(path)) return [];
  const raw = await readFile(path, 'utf8');
  return raw.trim().split('\n')
    .filter(Boolean)
    .map((line) => goldLabelRecordSchema.parse(JSON.parse(line)));
}

// ---------------------------------------------------------------------------
// Save gold-label dataset to JSONL file.
// ---------------------------------------------------------------------------

export async function saveGoldLabelDataset(records: GoldLabelRecord[], path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const lines = records.map((r) => JSON.stringify(r));
  await writeFile(path, lines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// Summarize gold-label dataset for coverage analysis.
// ---------------------------------------------------------------------------

export function summarizeGoldLabelDataset(records: GoldLabelRecord[]): GoldLabelDatasetSummary {
  const byEngagement: Record<string, number> = {};
  const byReviewer: Record<string, number> = {};
  let accepted = 0;
  let corrected = 0;
  let rejected = 0;

  for (const r of records) {
    byEngagement[r.engagementType] = (byEngagement[r.engagementType] ?? 0) + 1;
    byReviewer[r.reviewedBy] = (byReviewer[r.reviewedBy] ?? 0) + 1;
    if (r.status === 'ACCEPTED') accepted++;
    else if (r.status === 'CORRECTED') corrected++;
    else rejected++;
  }

  const gaps: string[] = [];
  const MIN_PER_TYPE = 20;
  for (const type of ['CALL', 'EMAIL', 'TICKET', 'CHAT']) {
    const count = byEngagement[type] ?? 0;
    if (count < MIN_PER_TYPE) {
      gaps.push(`${type}: ${count}/${MIN_PER_TYPE} (need ${MIN_PER_TYPE - count} more)`);
    }
  }

  const usable = accepted + corrected;
  const statisticallySignificant = usable >= 100;

  if (!statisticallySignificant) {
    gaps.push(`Total usable: ${usable}/100 (need ${100 - usable} more for statistical significance)`);
  }

  return goldLabelDatasetSummarySchema.parse({
    totalRecords: records.length,
    accepted,
    corrected,
    rejected,
    byEngagementType: byEngagement,
    byReviewer: byReviewer,
    coverageGaps: gaps,
    statisticallySignificant,
  });
}

// ---------------------------------------------------------------------------
// Measure inter-annotator agreement (Cohen's kappa).
// ---------------------------------------------------------------------------

export function measureInterAnnotatorAgreement(
  annotationsA: Array<{ recordId: string; score5: number }>,
  annotationsB: Array<{ recordId: string; score5: number }>,
  annotatorAName = 'annotatorA',
  annotatorBName = 'annotatorB',
): InterAnnotatorAgreement {
  const bMap = new Map(annotationsB.map((a) => [a.recordId, a.score5]));
  const pairs: Array<[number, number]> = [];

  for (const a of annotationsA) {
    const bScore = bMap.get(a.recordId);
    if (bScore !== undefined) {
      pairs.push([a.score5, bScore]);
    }
  }

  if (pairs.length === 0) {
    return interAnnotatorAgreementSchema.parse({
      annotatorA: annotatorAName,
      annotatorB: annotatorBName,
      recordCount: 0,
      rawAgreement: 0,
      cohensKappa: 0,
      interpretation: 'poor',
    });
  }

  const categories = [1, 2, 3, 4, 5];
  const n = pairs.length;
  const observed = pairs.filter(([a, b]) => a === b).length / n;

  const freqA = new Map<number, number>();
  const freqB = new Map<number, number>();
  for (const [a, b] of pairs) {
    freqA.set(a, (freqA.get(a) ?? 0) + 1);
    freqB.set(b, (freqB.get(b) ?? 0) + 1);
  }

  let expected = 0;
  for (const cat of categories) {
    expected += ((freqA.get(cat) ?? 0) / n) * ((freqB.get(cat) ?? 0) / n);
  }

  const kappa = expected === 1 ? 1 : (observed - expected) / (1 - expected);

  const interpretation = kappa < 0 ? 'poor' as const
    : kappa < 0.20 ? 'slight' as const
    : kappa < 0.40 ? 'fair' as const
    : kappa < 0.60 ? 'moderate' as const
    : kappa < 0.80 ? 'substantial' as const
    : 'almost_perfect' as const;

  return interAnnotatorAgreementSchema.parse({
    annotatorA: annotatorAName,
    annotatorB: annotatorBName,
    recordCount: pairs.length,
    rawAgreement: Number(observed.toFixed(4)),
    cohensKappa: Number(kappa.toFixed(4)),
    interpretation,
  });
}

// ---------------------------------------------------------------------------
// Flag low-confidence annotations — multi-trial variance is high.
// ---------------------------------------------------------------------------

export function flagLowConfidenceAnnotations(
  annotations: Array<{ recordId: string; trials: Array<{ score100: number }> }>,
  varianceThreshold = 100,
): Array<{ recordId: string; variance: number; mean: number; min: number; max: number }> {
  const flagged: Array<{ recordId: string; variance: number; mean: number; min: number; max: number }> = [];

  for (const ann of annotations) {
    if (ann.trials.length < 2) continue;
    const scores = ann.trials.map((t) => t.score100);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / scores.length;
    if (variance >= varianceThreshold) {
      flagged.push({
        recordId: ann.recordId,
        variance: Number(variance.toFixed(2)),
        mean: Number(mean.toFixed(2)),
        min: Math.min(...scores),
        max: Math.max(...scores),
      });
    }
  }

  return flagged.sort((a, b) => b.variance - a.variance);
}
