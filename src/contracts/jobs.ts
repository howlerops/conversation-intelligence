import { z } from 'zod';
import { conversationAnalysisSchema, reviewQueueItemSchema } from './analysis';
import { piiConfigSchema, piiRedactionSummarySchema } from './pii';
import { transcriptInputSchema } from './transcript';
import { tenantPackSchema } from './tenant-pack';

export const analysisRequestSchema = z.object({
  transcript: transcriptInputSchema,
  tenantPack: tenantPackSchema,
  piiConfig: piiConfigSchema.default({
    enabled: true,
    maskDisplayNames: false,
    customRegexRules: [],
  }),
});

export type AnalysisRequest = z.infer<typeof analysisRequestSchema>;
export type AnalysisRequestDraft = z.input<typeof analysisRequestSchema>;

export const analysisJobStatusSchema = z.enum([
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
]);

export type AnalysisJobStatus = z.infer<typeof analysisJobStatusSchema>;

export const analysisJobRecordSchema = z.object({
  jobId: z.string().min(1),
  status: analysisJobStatusSchema,
  tenantId: z.string().min(1),
  conversationId: z.string().optional(),
  useCase: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  request: analysisRequestSchema.optional(),
  piiRedactionSummary: piiRedactionSummarySchema.optional(),
  result: conversationAnalysisSchema.optional(),
  error: z.object({
    message: z.string().min(1),
    stack: z.string().optional(),
  }).optional(),
});

export type AnalysisJobRecord = z.infer<typeof analysisJobRecordSchema>;

export const reviewQueueSnapshotSchema = z.object({
  generatedAt: z.string().min(1),
  items: z.array(reviewQueueItemSchema),
});

export type ReviewQueueSnapshot = z.infer<typeof reviewQueueSnapshotSchema>;
