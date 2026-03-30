import { mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { z } from 'zod';
import {
  deriveScore5FromScore100,
  reviewedSentimentOutcomeSampleSchema,
} from '../sentiment/scoring';
import {
  participantSchema,
  transcriptInputSchema,
  transcriptTurnSchema,
} from '../contracts';
import { deriveTranscriptStats } from './transcript-stats';

const looseMetadataSchema = z.record(z.string(), z.unknown()).default({});

export const publicEngagementTypeSchema = z.enum(['CALL', 'EMAIL', 'TICKET', 'CHAT']);
export type PublicEngagementType = z.infer<typeof publicEngagementTypeSchema>;

export const publicDatasetTrackSchema = z.enum(['OPEN_CORE', 'RESEARCH_ONLY', 'SYNTHETIC']);
export type PublicDatasetTrack = z.infer<typeof publicDatasetTrackSchema>;

export const publicDatasetNameSchema = z.enum([
  'ABCD',
  'TASKMASTER',
  'DOC2DIAL',
  'MULTIDOC2DIAL',
  'DYNASENT',
  'SARC',
  'CALLCENTEREN',
  'SYNTHETIC_TEMPLATE',
]);
export type PublicDatasetName = z.infer<typeof publicDatasetNameSchema>;

const publicDataSentimentLabelSchema = z.object({
  polarity: z.enum(['VERY_NEGATIVE', 'NEGATIVE', 'NEUTRAL', 'POSITIVE', 'VERY_POSITIVE']),
  intensity: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1).default(1),
  rationale: z.string().min(1),
  analystScore100: z.number().int().min(0).max(100).optional(),
  analystScore5: z.number().int().min(1).max(5).optional(),
  reviewState: z.enum(['VERIFIED', 'UNCERTAIN', 'NEEDS_REVIEW']).default('VERIFIED'),
  correctionApplied: z.boolean().default(false),
  reviewedBy: z.string().min(1).optional(),
  reviewedAt: z.string().min(1).optional(),
  note: z.string().min(1).optional(),
});

const publicDataLabelsSchema = z.object({
  overallSentiment: publicDataSentimentLabelSchema.optional(),
  canonicalEvents: z.array(z.string().min(1)).default([]),
  tags: z.array(z.string().min(1)).default([]),
  category: z.string().min(1).optional(),
});

const publicPipelineBaseSchema = z.object({
  pipelineId: z.string().min(1),
  tenantId: z.string().min(1).default('public_eval'),
  useCase: z.string().min(1),
  dataset: publicDatasetNameSchema,
  datasetTrack: publicDatasetTrackSchema,
  engagementType: publicEngagementTypeSchema,
  description: z.string().min(1),
  notes: z.array(z.string().min(1)).default([]),
});

export const publicCallRecordSchema = z.object({
  recordId: z.string().min(1),
  conversationId: z.string().min(1).optional(),
  participants: z.array(participantSchema).min(1),
  turns: z.array(transcriptTurnSchema).min(1),
  labels: publicDataLabelsSchema.default({
    canonicalEvents: [],
    tags: [],
  }),
  metadata: looseMetadataSchema,
});

const emailMessageSchema = z.object({
  messageId: z.string().min(1),
  senderId: z.string().min(1),
  bodyText: z.string().min(1),
  sentAt: z.string().optional(),
  subject: z.string().min(1).optional(),
  metadata: looseMetadataSchema,
});

export const publicEmailRecordSchema = z.object({
  recordId: z.string().min(1),
  threadId: z.string().min(1).optional(),
  subject: z.string().min(1).optional(),
  participants: z.array(participantSchema).min(1),
  messages: z.array(emailMessageSchema).min(1),
  labels: publicDataLabelsSchema.default({
    canonicalEvents: [],
    tags: [],
  }),
  metadata: looseMetadataSchema,
});

const ticketCommentSchema = z.object({
  commentId: z.string().min(1),
  authorId: z.string().min(1),
  bodyText: z.string().min(1),
  createdAt: z.string().optional(),
  isInternalNote: z.boolean().default(false),
  metadata: looseMetadataSchema,
});

export const publicTicketRecordSchema = z.object({
  recordId: z.string().min(1),
  ticketId: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  participants: z.array(participantSchema).min(1),
  comments: z.array(ticketCommentSchema).min(1),
  labels: publicDataLabelsSchema.default({
    canonicalEvents: [],
    tags: [],
  }),
  metadata: looseMetadataSchema,
});

export const publicCallPipelineSchema = publicPipelineBaseSchema.extend({
  engagementType: z.literal('CALL'),
  records: z.array(publicCallRecordSchema).min(1),
});

export const publicEmailPipelineSchema = publicPipelineBaseSchema.extend({
  engagementType: z.literal('EMAIL'),
  records: z.array(publicEmailRecordSchema).min(1),
});

export const publicTicketPipelineSchema = publicPipelineBaseSchema.extend({
  engagementType: z.literal('TICKET'),
  records: z.array(publicTicketRecordSchema).min(1),
});

export const publicDataPipelineSchema = z.discriminatedUnion('engagementType', [
  publicCallPipelineSchema,
  publicEmailPipelineSchema,
  publicTicketPipelineSchema,
]);

export type PublicDataPipeline = z.infer<typeof publicDataPipelineSchema>;

export const publicDataPipelineSuiteSchema = z.object({
  pipelines: z.array(publicDataPipelineSchema).min(1),
});

export type PublicDataPipelineSuite = z.infer<typeof publicDataPipelineSuiteSchema>;

export const publicDataPipelineRecordOutputSchema = z.object({
  pipelineId: z.string().min(1),
  tenantId: z.string().min(1),
  useCase: z.string().min(1),
  dataset: publicDatasetNameSchema,
  datasetTrack: publicDatasetTrackSchema,
  engagementType: publicEngagementTypeSchema,
  sourceRecordId: z.string().min(1),
  transcript: transcriptInputSchema,
  canonicalEventLabels: z.array(z.string().min(1)).default([]),
  tags: z.array(z.string().min(1)).default([]),
  reviewedSentimentSample: reviewedSentimentOutcomeSampleSchema.optional(),
});

export type PublicDataPipelineRecordOutput = z.infer<typeof publicDataPipelineRecordOutputSchema>;

export const publicDataPipelineOutputSchema = z.object({
  pipelineId: z.string().min(1),
  tenantId: z.string().min(1),
  useCase: z.string().min(1),
  dataset: publicDatasetNameSchema,
  datasetTrack: publicDatasetTrackSchema,
  engagementType: publicEngagementTypeSchema,
  description: z.string().min(1),
  notes: z.array(z.string().min(1)).default([]),
  generatedAt: z.string().min(1),
  summary: z.object({
    totalRecords: z.number().int().min(0),
    transcriptCount: z.number().int().min(0),
    reviewedSentimentSampleCount: z.number().int().min(0),
    canonicalEventLabelCount: z.number().int().min(0),
    byQueue: z.record(z.string(), z.number().int().min(0)).default({}),
    byTranscriptLengthBucket: z.record(z.string(), z.number().int().min(0)).default({}),
    tagCounts: z.record(z.string(), z.number().int().min(0)).default({}),
  }),
  records: z.array(publicDataPipelineRecordOutputSchema),
});

export type PublicDataPipelineOutput = z.infer<typeof publicDataPipelineOutputSchema>;

export const publicDataPipelineSuiteOutputSchema = z.object({
  generatedAt: z.string().min(1),
  summary: z.object({
    pipelineCount: z.number().int().min(0),
    recordCount: z.number().int().min(0),
    reviewedSentimentSampleCount: z.number().int().min(0),
    byEngagementType: z.record(z.string(), z.number().int().min(0)).default({}),
    byUseCase: z.record(z.string(), z.number().int().min(0)).default({}),
    byQueue: z.record(z.string(), z.number().int().min(0)).default({}),
    byTranscriptLengthBucket: z.record(z.string(), z.number().int().min(0)).default({}),
  }),
  pipelines: z.array(publicDataPipelineOutputSchema),
});

export type PublicDataPipelineSuiteOutput = z.infer<typeof publicDataPipelineSuiteOutputSchema>;

export interface PublicDataPipelineArtifacts {
  summaryPath: string;
  pipelinePaths: Array<{
    pipelineId: string;
    outputPath: string;
    transcriptsPath: string;
    reviewedSentimentPath?: string;
  }>;
}

export function buildPublicDataPipelineSuite(
  input: unknown,
  clock: () => Date = () => new Date(),
): PublicDataPipelineSuiteOutput {
  const parsed = publicDataPipelineSuiteSchema.parse(input);
  const generatedAt = clock().toISOString();
  const pipelines = parsed.pipelines.map((pipeline) => buildPipelineOutput(pipeline, generatedAt));
  const summary = pipelines.reduce<PublicDataPipelineSuiteOutput['summary']>((aggregate, pipeline) => {
    aggregate.pipelineCount += 1;
    aggregate.recordCount += pipeline.summary.totalRecords;
    aggregate.reviewedSentimentSampleCount += pipeline.summary.reviewedSentimentSampleCount;
    aggregate.byEngagementType[pipeline.engagementType] = (aggregate.byEngagementType[pipeline.engagementType] ?? 0) + pipeline.summary.totalRecords;
    aggregate.byUseCase[pipeline.useCase] = (aggregate.byUseCase[pipeline.useCase] ?? 0) + pipeline.summary.totalRecords;
    for (const [queue, count] of Object.entries(pipeline.summary.byQueue)) {
      aggregate.byQueue[queue] = (aggregate.byQueue[queue] ?? 0) + count;
    }
    for (const [bucket, count] of Object.entries(pipeline.summary.byTranscriptLengthBucket)) {
      aggregate.byTranscriptLengthBucket[bucket] = (aggregate.byTranscriptLengthBucket[bucket] ?? 0) + count;
    }
    return aggregate;
  }, {
    pipelineCount: 0,
    recordCount: 0,
    reviewedSentimentSampleCount: 0,
    byEngagementType: {},
    byUseCase: {},
    byQueue: {},
    byTranscriptLengthBucket: {},
  });

  return publicDataPipelineSuiteOutputSchema.parse({
    generatedAt,
    summary,
    pipelines,
  });
}

export async function writePublicDataPipelineArtifacts(
  outputDir: string,
  input: PublicDataPipelineSuiteOutput,
): Promise<PublicDataPipelineArtifacts> {
  const parsed = publicDataPipelineSuiteOutputSchema.parse(input);
  const summaryPath = join(outputDir, 'summary.json');
  await writeJson(summaryPath, parsed);

  const pipelinePaths: PublicDataPipelineArtifacts['pipelinePaths'] = [];

  for (const pipeline of parsed.pipelines) {
    const pipelineDir = join(outputDir, pipeline.pipelineId);
    const outputPath = join(pipelineDir, 'pipeline.json');
    const transcriptsPath = join(pipelineDir, 'transcripts.jsonl');
    const reviewedSentimentPath = join(pipelineDir, 'reviewed-sentiment.jsonl');
    await writeJson(outputPath, pipeline);
    await writeText(
      transcriptsPath,
      pipeline.records.map((record) => JSON.stringify(record.transcript)).join('\n'),
    );

    const reviewedSamples = pipeline.records
      .map((record) => record.reviewedSentimentSample)
      .filter((sample): sample is NonNullable<typeof sample> => Boolean(sample));

    if (reviewedSamples.length > 0) {
      await writeText(
        reviewedSentimentPath,
        reviewedSamples.map((sample) => JSON.stringify(sample)).join('\n'),
      );
    }

    pipelinePaths.push({
      pipelineId: pipeline.pipelineId,
      outputPath,
      transcriptsPath,
      reviewedSentimentPath: reviewedSamples.length > 0 ? reviewedSentimentPath : undefined,
    });
  }

  return {
    summaryPath,
    pipelinePaths,
  };
}

function buildPipelineOutput(
  pipeline: PublicDataPipeline,
  generatedAt: string,
): PublicDataPipelineOutput {
  const records = pipeline.records.map((record) => buildRecordOutput(pipeline, record));
  const tagCounts = records.reduce<Record<string, number>>((aggregate, record) => {
    for (const tag of record.tags) {
      aggregate[tag] = (aggregate[tag] ?? 0) + 1;
    }
    return aggregate;
  }, {});
  const byQueue = records.reduce<Record<string, number>>((aggregate, record) => {
    const queue = typeof record.transcript.metadata.queue === 'string'
      ? record.transcript.metadata.queue
      : 'UNSPECIFIED';
    aggregate[queue] = (aggregate[queue] ?? 0) + 1;
    return aggregate;
  }, {});
  const byTranscriptLengthBucket = records.reduce<Record<string, number>>((aggregate, record) => {
    const bucket = typeof record.transcript.metadata.transcriptLengthBucket === 'string'
      ? record.transcript.metadata.transcriptLengthBucket
      : 'UNSPECIFIED';
    aggregate[bucket] = (aggregate[bucket] ?? 0) + 1;
    return aggregate;
  }, {});

  return publicDataPipelineOutputSchema.parse({
    pipelineId: pipeline.pipelineId,
    tenantId: pipeline.tenantId,
    useCase: pipeline.useCase,
    dataset: pipeline.dataset,
    datasetTrack: pipeline.datasetTrack,
    engagementType: pipeline.engagementType,
    description: pipeline.description,
    notes: pipeline.notes,
    generatedAt,
    summary: {
      totalRecords: records.length,
      transcriptCount: records.length,
      reviewedSentimentSampleCount: records.filter((record) => Boolean(record.reviewedSentimentSample)).length,
      canonicalEventLabelCount: records.reduce((sum, record) => sum + record.canonicalEventLabels.length, 0),
      byQueue,
      byTranscriptLengthBucket,
      tagCounts,
    },
    records,
  });
}

function buildRecordOutput(
  pipeline: PublicDataPipeline,
  record: z.infer<typeof publicCallRecordSchema> | z.infer<typeof publicEmailRecordSchema> | z.infer<typeof publicTicketRecordSchema>,
): PublicDataPipelineRecordOutput {
  const transcript = pipeline.engagementType === 'CALL'
    ? transcriptFromCallRecord(pipeline, record as z.infer<typeof publicCallRecordSchema>)
    : pipeline.engagementType === 'EMAIL'
      ? transcriptFromEmailRecord(pipeline, record as z.infer<typeof publicEmailRecordSchema>)
      : transcriptFromTicketRecord(pipeline, record as z.infer<typeof publicTicketRecordSchema>);

  return publicDataPipelineRecordOutputSchema.parse({
    pipelineId: pipeline.pipelineId,
    tenantId: pipeline.tenantId,
    useCase: pipeline.useCase,
    dataset: pipeline.dataset,
    datasetTrack: pipeline.datasetTrack,
    engagementType: pipeline.engagementType,
    sourceRecordId: record.recordId,
    transcript,
    canonicalEventLabels: record.labels.canonicalEvents,
    tags: record.labels.tags,
    reviewedSentimentSample: buildReviewedSentimentSample(pipeline, record, transcript),
  });
}

function transcriptFromCallRecord(
  pipeline: z.infer<typeof publicCallPipelineSchema>,
  record: z.infer<typeof publicCallRecordSchema>,
) {
  const stats = deriveTranscriptStats({ turns: record.turns });
  return transcriptInputSchema.parse({
    tenantId: pipeline.tenantId,
    conversationId: record.conversationId ?? `${pipeline.pipelineId}_${record.recordId}`,
    useCase: pipeline.useCase,
    participants: record.participants,
    turns: record.turns,
    metadata: {
      ...record.metadata,
      engagementType: pipeline.engagementType,
      queue: resolveQueueLabel(pipeline, record.metadata.queue),
      sourceDataset: pipeline.dataset,
      datasetTrack: pipeline.datasetTrack,
      pipelineId: pipeline.pipelineId,
      sourceRecordId: record.recordId,
      transcriptTurnCount: stats.transcriptTurnCount,
      transcriptCharacterCount: stats.transcriptCharacterCount,
      transcriptLengthBucket: stats.transcriptLengthBucket,
    },
  });
}

function transcriptFromEmailRecord(
  pipeline: z.infer<typeof publicEmailPipelineSchema>,
  record: z.infer<typeof publicEmailRecordSchema>,
) {
  const turns = record.messages.map((message) => transcriptTurnSchema.parse({
    turnId: message.messageId,
    speakerId: message.senderId,
    text: formatEmailTurnText(record.subject, message.subject, message.bodyText),
    startedAt: message.sentAt,
    endedAt: message.sentAt,
    metadata: {
      ...message.metadata,
      sourceType: 'email_message',
    },
  }));
  const stats = deriveTranscriptStats({ turns });

  return transcriptInputSchema.parse({
    tenantId: pipeline.tenantId,
    conversationId: record.threadId ?? `${pipeline.pipelineId}_${record.recordId}`,
    useCase: pipeline.useCase,
    participants: record.participants,
    turns,
    metadata: {
      ...record.metadata,
      engagementType: pipeline.engagementType,
      queue: resolveQueueLabel(pipeline, record.metadata.queue),
      sourceDataset: pipeline.dataset,
      datasetTrack: pipeline.datasetTrack,
      pipelineId: pipeline.pipelineId,
      sourceRecordId: record.recordId,
      subject: record.subject,
      transcriptTurnCount: stats.transcriptTurnCount,
      transcriptCharacterCount: stats.transcriptCharacterCount,
      transcriptLengthBucket: stats.transcriptLengthBucket,
    },
  });
}

function transcriptFromTicketRecord(
  pipeline: z.infer<typeof publicTicketPipelineSchema>,
  record: z.infer<typeof publicTicketRecordSchema>,
) {
  const turns = record.comments.map((comment) => transcriptTurnSchema.parse({
    turnId: comment.commentId,
    speakerId: comment.authorId,
    text: comment.isInternalNote ? `[INTERNAL NOTE] ${comment.bodyText}` : comment.bodyText,
    startedAt: comment.createdAt,
    endedAt: comment.createdAt,
    metadata: {
      ...comment.metadata,
      sourceType: 'ticket_comment',
      isInternalNote: comment.isInternalNote,
    },
  }));
  const stats = deriveTranscriptStats({ turns });

  return transcriptInputSchema.parse({
    tenantId: pipeline.tenantId,
    conversationId: record.ticketId ?? `${pipeline.pipelineId}_${record.recordId}`,
    useCase: pipeline.useCase,
    participants: record.participants,
    turns,
    metadata: {
      ...record.metadata,
      engagementType: pipeline.engagementType,
      queue: resolveQueueLabel(pipeline, record.metadata.queue),
      sourceDataset: pipeline.dataset,
      datasetTrack: pipeline.datasetTrack,
      pipelineId: pipeline.pipelineId,
      sourceRecordId: record.recordId,
      title: record.title,
      transcriptTurnCount: stats.transcriptTurnCount,
      transcriptCharacterCount: stats.transcriptCharacterCount,
      transcriptLengthBucket: stats.transcriptLengthBucket,
    },
  });
}

function buildReviewedSentimentSample(
  pipeline: PublicDataPipeline,
  record: z.infer<typeof publicCallRecordSchema> | z.infer<typeof publicEmailRecordSchema> | z.infer<typeof publicTicketRecordSchema>,
  transcript: z.infer<typeof transcriptInputSchema>,
) {
  const sentiment = record.labels.overallSentiment;
  if (!sentiment || typeof sentiment.analystScore100 !== 'number') {
    return undefined;
  }

  return reviewedSentimentOutcomeSampleSchema.parse({
    runId: `${pipeline.pipelineId}:${record.recordId}`,
    tenantId: pipeline.tenantId,
    useCase: pipeline.useCase,
    source: 'fixture',
    engagementType: pipeline.engagementType,
    queue: typeof transcript.metadata.queue === 'string' ? transcript.metadata.queue : undefined,
    transcriptTurnCount: typeof transcript.metadata.transcriptTurnCount === 'number'
      ? transcript.metadata.transcriptTurnCount
      : undefined,
    transcriptCharacterCount: typeof transcript.metadata.transcriptCharacterCount === 'number'
      ? transcript.metadata.transcriptCharacterCount
      : undefined,
    transcriptLengthBucket: typeof transcript.metadata.transcriptLengthBucket === 'string'
      ? transcript.metadata.transcriptLengthBucket
      : undefined,
    sourceDataset: pipeline.dataset,
    datasetTrack: pipeline.datasetTrack,
    name: `${pipeline.pipelineId}:${record.recordId}`,
    category: record.labels.category,
    reviewedBy: sentiment.reviewedBy,
    reviewedAt: sentiment.reviewedAt,
    note: sentiment.note,
    model: {
      polarity: sentiment.polarity,
      intensity: sentiment.intensity,
      confidence: sentiment.confidence,
      rationale: sentiment.rationale,
    },
    analyst: {
      score100: sentiment.analystScore100,
      score5: sentiment.analystScore5 ?? deriveScore5FromScore100(sentiment.analystScore100),
      reviewState: sentiment.reviewState,
      correctionApplied: sentiment.correctionApplied,
    },
  });
}

function resolveQueueLabel(
  pipeline: Pick<PublicDataPipeline, 'useCase' | 'engagementType'>,
  configuredQueue: unknown,
): string {
  if (typeof configuredQueue === 'string' && configuredQueue.length > 0) {
    return configuredQueue;
  }

  if (pipeline.useCase === 'support' && pipeline.engagementType === 'CALL') {
    return 'support_voice';
  }
  if (pipeline.useCase === 'support' && pipeline.engagementType === 'TICKET') {
    return 'support_async';
  }
  if (pipeline.useCase === 'support' && pipeline.engagementType === 'EMAIL') {
    return 'support_email';
  }
  if (pipeline.useCase === 'collections' && pipeline.engagementType === 'EMAIL') {
    return 'collections_email';
  }
  return `${pipeline.useCase}_${pipeline.engagementType.toLowerCase()}`;
}

function formatEmailTurnText(
  threadSubject: string | undefined,
  messageSubject: string | undefined,
  bodyText: string,
): string {
  const subject = messageSubject ?? threadSubject;
  return subject ? `Subject: ${subject}\n\n${bodyText}` : bodyText;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8');
}

async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value ? `${value}\n` : '', 'utf8');
}
