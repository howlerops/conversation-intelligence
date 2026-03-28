import { randomUUID } from 'crypto';
import {
  AnalysisJobRecord,
  AnalysisRequestDraft,
  analysisJobRecordSchema,
  analysisRequestSchema,
} from '../contracts/jobs';
import { ConversationAnalysis, ReviewQueueSnapshot } from '../contracts';
import { analyzeConversation } from '../pipeline/analyze-conversation';
import { CanonicalAnalysisEngine } from '../rlm/engine';
import { JobStore } from '../store/job-store';
import { maskAnalysisRequest, PiiTextMasker } from '../pii/masking';

export interface ConversationIntelligenceServiceOptions {
  engine: CanonicalAnalysisEngine;
  store: JobStore;
  clock?: () => Date;
  piiMaskers?: PiiTextMasker[];
}

export class ConversationIntelligenceService {
  private readonly engine: CanonicalAnalysisEngine;
  private readonly store: JobStore;
  private readonly clock: () => Date;
  private readonly piiMaskers: PiiTextMasker[];

  constructor(options: ConversationIntelligenceServiceOptions) {
    this.engine = options.engine;
    this.store = options.store;
    this.clock = options.clock ?? (() => new Date());
    this.piiMaskers = options.piiMaskers ?? [];
  }

  async analyzeNow(requestInput: AnalysisRequestDraft): Promise<ConversationAnalysis> {
    const request = this.prepareRequest(requestInput);
    return analyzeConversation(request.request.transcript, request.request.tenantPack, {
      engine: this.engine,
      now: this.clock(),
      piiRedactionSummary: request.summary,
    });
  }

  async submitJob(requestInput: AnalysisRequestDraft): Promise<AnalysisJobRecord> {
    const request = this.prepareRequest(requestInput);
    const timestamp = this.clock().toISOString();
    const jobId = randomUUID();

    const job = await this.store.createJob(analysisJobRecordSchema.parse({
      jobId,
      status: 'QUEUED',
      tenantId: request.request.transcript.tenantId,
      conversationId: request.request.transcript.conversationId,
      useCase: request.request.transcript.useCase,
      createdAt: timestamp,
      updatedAt: timestamp,
      request: request.request,
      piiRedactionSummary: request.summary,
    }));

    return job;
  }

  async getJob(jobId: string): Promise<AnalysisJobRecord | null> {
    return this.store.getJob(jobId);
  }

  async listJobs(): Promise<AnalysisJobRecord[]> {
    return this.store.listJobs();
  }

  async listReviewQueue(): Promise<ReviewQueueSnapshot> {
    return this.store.listReviewQueue();
  }

  async claimNextQueuedJob(workerId: string): Promise<AnalysisJobRecord | null> {
    return this.store.claimNextQueuedJob(workerId, this.clock().toISOString());
  }

  async processClaimedJob(job: AnalysisJobRecord): Promise<void> {
    const existing = await this.store.getJob(job.jobId);

    if (!existing?.request) {
      return;
    }

    try {
      const result = await analyzeConversation(existing.request.transcript, existing.request.tenantPack, {
        engine: this.engine,
        jobId: existing.jobId,
        now: this.clock(),
        piiRedactionSummary: existing.piiRedactionSummary,
      });

      await this.store.updateJob({
        ...existing,
        status: 'COMPLETED',
        updatedAt: this.clock().toISOString(),
        result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;

      await this.store.updateJob({
        ...existing,
        status: 'FAILED',
        updatedAt: this.clock().toISOString(),
        error: {
          message,
          stack,
        },
      });
    }
  }

  private prepareRequest(requestInput: AnalysisRequestDraft) {
    const parsed = analysisRequestSchema.parse(requestInput);
    return maskAnalysisRequest(parsed, {
      customMaskers: this.piiMaskers,
    });
  }
}
