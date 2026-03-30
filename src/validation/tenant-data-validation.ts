import { z } from 'zod';
import { GoldLabelRecord, loadGoldLabelDataset } from './gold-label-toolkit';
import { CanonicalAnalysisEngine } from '../rlm/engine';
import { TenantPack, TenantPackDraft } from '../contracts/tenant-pack';
import { TranscriptInputDraft } from '../contracts/transcript';
import { TenantAdminSentimentScoring } from '../contracts/admin-config';
import { analyzeConversation } from '../pipeline/analyze-conversation';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const tenantDataValidationConfigSchema = z.object({
  inputPath: z.string().min(1),
  tenantId: z.string().min(1),
  useCase: z.string().default('support'),
  maxRecords: z.number().int().min(1).optional(),
});

export type TenantDataValidationConfig = z.input<typeof tenantDataValidationConfigSchema>;

// ---------------------------------------------------------------------------
// Per-record result
// ---------------------------------------------------------------------------

export const tenantDataValidationRecordResultSchema = z.object({
  recordId: z.string().min(1),
  engagementType: z.string().min(1),
  analystScore100: z.number().int().min(0).max(100),
  analystScore5: z.number().int().min(1).max(5),
  modelScore100: z.number().int().min(0).max(100).optional(),
  modelScore5: z.number().int().min(1).max(5).optional(),
  deltaScore100: z.number().int().min(0).max(100).optional(),
  status: z.enum(['MATCHED', 'DIVERGED', 'SKIPPED', 'ERROR']),
  errorMessage: z.string().optional(),
});

export type TenantDataValidationRecordResult = z.infer<typeof tenantDataValidationRecordResultSchema>;

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const engagementTypeSummarySchema = z.object({
  total: z.number().int().min(0),
  matched: z.number().int().min(0),
  averageDeltaScore100: z.number().min(0).optional(),
});

export const tenantDataValidationSummarySchema = z.object({
  tenantId: z.string().min(1),
  inputPath: z.string().min(1),
  totalRecords: z.number().int().min(0),
  matched: z.number().int().min(0),
  diverged: z.number().int().min(0),
  skipped: z.number().int().min(0),
  errors: z.number().int().min(0),
  averageDeltaScore100: z.number().min(0).optional(),
  withinFivePointsRate: z.number().min(0).max(1).optional(),
  byEngagementType: z.record(z.string(), engagementTypeSummarySchema),
  validatedAt: z.string().min(1),
  records: z.array(tenantDataValidationRecordResultSchema),
});

export type TenantDataValidationSummary = z.infer<typeof tenantDataValidationSummarySchema>;

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface TenantDataValidationDeps {
  engine: CanonicalAnalysisEngine;
  tenantPack: TenantPackDraft;
  sentimentScoring?: TenantAdminSentimentScoring;
  transcriptForRecord?: (record: GoldLabelRecord) => TranscriptInputDraft | null;
}

// ---------------------------------------------------------------------------
// Default transcript builder — minimal stub transcript for scoring comparison.
// ---------------------------------------------------------------------------

function defaultTranscriptForRecord(record: GoldLabelRecord): TranscriptInputDraft {
  return {
    tenantId: record.tenantId,
    useCase: record.useCase,
    participants: [
      { speakerId: 'customer', displayName: 'Customer', rawRoleLabel: 'customer' },
      { speakerId: 'agent', displayName: 'Agent', rawRoleLabel: 'agent' },
    ],
    turns: [
      { turnId: 't1', speakerId: 'customer', text: `Sentiment benchmark record ${record.recordId}. Score: ${record.sentiment.score100}.` },
      { turnId: 't2', speakerId: 'agent', text: 'Thank you for contacting us. How can I help?' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runTenantDataValidation(
  config: TenantDataValidationConfig,
  deps: TenantDataValidationDeps,
): Promise<TenantDataValidationSummary> {
  const parsedConfig = tenantDataValidationConfigSchema.parse(config);
  const allRecords = await loadGoldLabelDataset(parsedConfig.inputPath);

  const filtered = allRecords
    .filter((r) => r.status !== 'REJECTED')
    .slice(0, parsedConfig.maxRecords);

  const results: TenantDataValidationRecordResult[] = [];
  const transcriptBuilder = deps.transcriptForRecord ?? defaultTranscriptForRecord;

  for (const record of filtered) {
    const transcript = transcriptBuilder(record);
    if (!transcript) {
      results.push(tenantDataValidationRecordResultSchema.parse({
        recordId: record.recordId,
        engagementType: record.engagementType,
        analystScore100: record.sentiment.score100,
        analystScore5: record.sentiment.score5,
        status: 'SKIPPED',
      }));
      continue;
    }

    try {
      const analysis = await analyzeConversation(transcript, deps.tenantPack, {
        engine: deps.engine,
        now: new Date(),
        sentimentScoringConfig: deps.sentimentScoring,
      });

      const modelScore100 = analysis.overallEndUserSentiment?.score?.score100;
      const modelScore5 = analysis.overallEndUserSentiment?.score?.score5;

      if (modelScore100 === undefined) {
        results.push(tenantDataValidationRecordResultSchema.parse({
          recordId: record.recordId,
          engagementType: record.engagementType,
          analystScore100: record.sentiment.score100,
          analystScore5: record.sentiment.score5,
          status: 'SKIPPED',
          errorMessage: 'No model sentiment score produced.',
        }));
        continue;
      }

      const delta = Math.abs(modelScore100 - record.sentiment.score100);
      const status = delta <= 5 ? 'MATCHED' as const : 'DIVERGED' as const;

      results.push(tenantDataValidationRecordResultSchema.parse({
        recordId: record.recordId,
        engagementType: record.engagementType,
        analystScore100: record.sentiment.score100,
        analystScore5: record.sentiment.score5,
        modelScore100,
        modelScore5,
        deltaScore100: delta,
        status,
      }));
    } catch (error) {
      results.push(tenantDataValidationRecordResultSchema.parse({
        recordId: record.recordId,
        engagementType: record.engagementType,
        analystScore100: record.sentiment.score100,
        analystScore5: record.sentiment.score5,
        status: 'ERROR',
        errorMessage: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  const matched = results.filter((r) => r.status === 'MATCHED').length;
  const diverged = results.filter((r) => r.status === 'DIVERGED').length;
  const skipped = results.filter((r) => r.status === 'SKIPPED').length;
  const errors = results.filter((r) => r.status === 'ERROR').length;

  const compared = results.filter((r) => r.deltaScore100 !== undefined);
  const avgDelta = compared.length > 0
    ? Number((compared.reduce((sum, r) => sum + (r.deltaScore100 ?? 0), 0) / compared.length).toFixed(2))
    : undefined;
  const within5Rate = compared.length > 0
    ? Number((compared.filter((r) => (r.deltaScore100 ?? 100) <= 5).length / compared.length).toFixed(4))
    : undefined;

  const byEngType: Record<string, { total: number; matched: number; deltas: number[] }> = {};
  for (const r of results) {
    const entry = byEngType[r.engagementType] ?? { total: 0, matched: 0, deltas: [] };
    entry.total++;
    if (r.status === 'MATCHED') entry.matched++;
    if (r.deltaScore100 !== undefined) entry.deltas.push(r.deltaScore100);
    byEngType[r.engagementType] = entry;
  }

  const byEngagementType: Record<string, { total: number; matched: number; averageDeltaScore100?: number }> = {};
  for (const [type, entry] of Object.entries(byEngType)) {
    byEngagementType[type] = {
      total: entry.total,
      matched: entry.matched,
      averageDeltaScore100: entry.deltas.length > 0
        ? Number((entry.deltas.reduce((a, b) => a + b, 0) / entry.deltas.length).toFixed(2))
        : undefined,
    };
  }

  return tenantDataValidationSummarySchema.parse({
    tenantId: parsedConfig.tenantId,
    inputPath: parsedConfig.inputPath,
    totalRecords: results.length,
    matched,
    diverged,
    skipped,
    errors,
    averageDeltaScore100: avgDelta,
    withinFivePointsRate: within5Rate,
    byEngagementType,
    validatedAt: new Date().toISOString(),
    records: results,
  });
}
