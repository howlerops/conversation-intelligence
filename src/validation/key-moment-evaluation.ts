import { z } from 'zod';
import { ConversationAnalysis } from '../contracts/analysis';
import { SupportCanonicalEventType } from '../contracts/tenant-pack';

// ---------------------------------------------------------------------------
// Expected key moments — what the gold-label dataset says should be detected.
// ---------------------------------------------------------------------------

export const expectedKeyMomentSchema = z.object({
  type: z.string().min(1),
  startTurnId: z.string().min(1).optional(),
  endTurnId: z.string().min(1).optional(),
  businessImpact: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
});

export type ExpectedKeyMoment = z.infer<typeof expectedKeyMomentSchema>;

// ---------------------------------------------------------------------------
// Per-record key moment evaluation result.
// ---------------------------------------------------------------------------

export const keyMomentEvalResultSchema = z.object({
  recordId: z.string().min(1),
  expectedCount: z.number().int().min(0),
  detectedCount: z.number().int().min(0),
  truePositives: z.number().int().min(0),
  falsePositives: z.number().int().min(0),
  falseNegatives: z.number().int().min(0),
  precision: z.number().min(0).max(1),
  recall: z.number().min(0).max(1),
  f1: z.number().min(0).max(1),
  evidenceFidelityRate: z.number().min(0).max(1),
  matchDetails: z.array(z.object({
    expectedType: z.string().min(1),
    detectedType: z.string().min(1).optional(),
    matched: z.boolean(),
  })),
});

export type KeyMomentEvalResult = z.infer<typeof keyMomentEvalResultSchema>;

// ---------------------------------------------------------------------------
// Aggregated key moment evaluation summary.
// ---------------------------------------------------------------------------

export const keyMomentEvalSummarySchema = z.object({
  totalRecords: z.number().int().min(0),
  recordsWithExpected: z.number().int().min(0),
  totalExpected: z.number().int().min(0),
  totalDetected: z.number().int().min(0),
  totalTruePositives: z.number().int().min(0),
  totalFalsePositives: z.number().int().min(0),
  totalFalseNegatives: z.number().int().min(0),
  macroPrecision: z.number().min(0).max(1),
  macroRecall: z.number().min(0).max(1),
  macroF1: z.number().min(0).max(1),
  averageEvidenceFidelity: z.number().min(0).max(1),
  byEventType: z.record(z.string(), z.object({
    expected: z.number().int().min(0),
    detected: z.number().int().min(0),
    truePositives: z.number().int().min(0),
    precision: z.number().min(0).max(1),
    recall: z.number().min(0).max(1),
  })),
});

export type KeyMomentEvalSummary = z.infer<typeof keyMomentEvalSummarySchema>;

// ---------------------------------------------------------------------------
// Evaluate key moments for a single analysis result.
// ---------------------------------------------------------------------------

export function evaluateKeyMoments(
  recordId: string,
  analysis: ConversationAnalysis,
  expected: ExpectedKeyMoment[],
  transcript: { turns: Array<{ turnId: string; text: string }> },
): KeyMomentEvalResult {
  const detected = analysis.canonicalKeyMoments;
  const turnTextMap = new Map(transcript.turns.map((t) => [t.turnId, t.text]));

  const matchedExpected = new Set<number>();
  const matchedDetected = new Set<number>();
  const matchDetails: KeyMomentEvalResult['matchDetails'] = [];

  for (let ei = 0; ei < expected.length; ei++) {
    const exp = expected[ei];
    let found = false;

    for (let di = 0; di < detected.length; di++) {
      if (matchedDetected.has(di)) continue;
      if (detected[di].type === exp.type) {
        matchedExpected.add(ei);
        matchedDetected.add(di);
        found = true;
        matchDetails.push({ expectedType: exp.type, detectedType: detected[di].type, matched: true });
        break;
      }
    }

    if (!found) {
      matchDetails.push({ expectedType: exp.type, matched: false });
    }
  }

  const tp = matchedExpected.size;
  const fp = detected.length - matchedDetected.size;
  const fn = expected.length - matchedExpected.size;
  const precision = detected.length === 0 ? (expected.length === 0 ? 1 : 0) : tp / detected.length;
  const recall = expected.length === 0 ? 1 : tp / expected.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  let validEvidence = 0;
  let totalEvidence = 0;
  for (const km of detected) {
    for (const ref of km.evidence) {
      totalEvidence++;
      const quotePrefix = ref.quote.toLowerCase().slice(0, 20);
      // First: check the claimed turnId (strict match)
      const turnText = turnTextMap.get(ref.turnId);
      if (turnText && turnText.toLowerCase().includes(quotePrefix)) {
        validEvidence++;
        continue;
      }
      // Fallback: model may have produced a correct verbatim quote but wrong turnId —
      // scan all turns and count as valid if the quote appears anywhere in the transcript
      let foundInTranscript = false;
      for (const text of turnTextMap.values()) {
        if (text.toLowerCase().includes(quotePrefix)) {
          foundInTranscript = true;
          break;
        }
      }
      if (foundInTranscript) validEvidence++;
    }
  }
  const evidenceFidelityRate = totalEvidence === 0 ? 1 : validEvidence / totalEvidence;

  return keyMomentEvalResultSchema.parse({
    recordId,
    expectedCount: expected.length,
    detectedCount: detected.length,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    precision: Number(precision.toFixed(4)),
    recall: Number(recall.toFixed(4)),
    f1: Number(f1.toFixed(4)),
    evidenceFidelityRate: Number(evidenceFidelityRate.toFixed(4)),
    matchDetails,
  });
}

// ---------------------------------------------------------------------------
// Aggregate key moment evaluation results.
// ---------------------------------------------------------------------------

export function summarizeKeyMomentEvals(results: KeyMomentEvalResult[]): KeyMomentEvalSummary {
  const withExpected = results.filter((r) => r.expectedCount > 0);
  const byType = new Map<string, { expected: number; detected: number; truePositives: number }>();

  let totalExpected = 0;
  let totalDetected = 0;
  let totalTP = 0;
  let totalFP = 0;
  let totalFN = 0;

  for (const r of results) {
    totalExpected += r.expectedCount;
    totalDetected += r.detectedCount;
    totalTP += r.truePositives;
    totalFP += r.falsePositives;
    totalFN += r.falseNegatives;

    for (const detail of r.matchDetails) {
      const entry = byType.get(detail.expectedType) ?? { expected: 0, detected: 0, truePositives: 0 };
      entry.expected++;
      if (detail.matched) {
        entry.detected++;
        entry.truePositives++;
      }
      byType.set(detail.expectedType, entry);
    }
  }

  const precisions = withExpected.map((r) => r.precision);
  const recalls = withExpected.map((r) => r.recall);
  const macroPrecision = precisions.length === 0 ? 0 : precisions.reduce((a, b) => a + b, 0) / precisions.length;
  const macroRecall = recalls.length === 0 ? 0 : recalls.reduce((a, b) => a + b, 0) / recalls.length;
  const macroF1 = macroPrecision + macroRecall === 0 ? 0 : (2 * macroPrecision * macroRecall) / (macroPrecision + macroRecall);

  const avgFidelity = results.length === 0 ? 1 : results.reduce((sum, r) => sum + r.evidenceFidelityRate, 0) / results.length;

  const byEventTypeRecord: Record<string, { expected: number; detected: number; truePositives: number; precision: number; recall: number }> = {};
  for (const [type, entry] of byType) {
    const p = entry.detected === 0 ? 0 : entry.truePositives / entry.detected;
    const r = entry.expected === 0 ? 1 : entry.truePositives / entry.expected;
    byEventTypeRecord[type] = {
      ...entry,
      precision: Number(p.toFixed(4)),
      recall: Number(r.toFixed(4)),
    };
  }

  return keyMomentEvalSummarySchema.parse({
    totalRecords: results.length,
    recordsWithExpected: withExpected.length,
    totalExpected,
    totalDetected,
    totalTruePositives: totalTP,
    totalFalsePositives: totalFP,
    totalFalseNegatives: totalFN,
    macroPrecision: Number(macroPrecision.toFixed(4)),
    macroRecall: Number(macroRecall.toFixed(4)),
    macroF1: Number(macroF1.toFixed(4)),
    averageEvidenceFidelity: Number(avgFidelity.toFixed(4)),
    byEventType: byEventTypeRecord,
  });
}
