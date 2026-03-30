import { randomUUID } from 'crypto';
import { ZodError } from 'zod';
import {
  AnalysisJobRecord,
  AnalysisRequest,
  AnalysisRequestDraft,
  AuditEventsSnapshot,
  RunEventsSnapshot,
  analysisJobRecordSchema,
  analysisRequestSchema,
  reviewQueueSnapshotSchema,
} from '../contracts/jobs';
import { PiiRedactionSummary } from '../contracts/pii';
import {
  ConversationAnalysis,
  ReviewAnalytics,
  ReviewAssignmentRequest,
  ReviewCommentRequest,
  ReviewDecisionRequest,
  ReviewQueueItem,
  ReviewQueueSnapshot,
  reviewAnalyticsSchema,
  reviewAssignmentRequestSchema,
  reviewCommentRequestSchema,
  reviewDecisionRequestSchema,
} from '../contracts';
import {
  buildDefaultTenantAdminConfig,
  ReviewAssignmentMode,
  TenantAdminConfig,
} from '../contracts/admin-config';
import { AuditAction, AuditEvent, AuthContext, RunEvent, RunEventType } from '../contracts/runtime';
import { TenantAdminConfigRegistry } from '../admin/file-tenant-admin-config-registry';
import { analyzeConversation } from '../pipeline/analyze-conversation';
import { CanonicalAnalysisEngine } from '../rlm/engine';
import { deriveScore5FromScore100 } from '../sentiment/scoring';
import { JobStore } from '../store/job-store';
import { maskAnalysisRequest, reversibleMaskAnalysisRequest, PiiTextMasker, PiiTokenMap } from '../pii/masking';
import {
  noopRuntimeObservability,
  ObservabilityAttributes,
  RuntimeObservability,
} from '../observability/runtime-observability';
import { SentimentStore } from '../store/sentiment-store';
import {
  SentimentAnalysisRecord,
  SentimentSegmentRecord,
  KeyMomentRecord,
  CalibrationSampleRecord,
} from '../contracts/sentiment-persistence';

export interface ConversationIntelligenceServiceOptions {
  engine: CanonicalAnalysisEngine;
  store: JobStore;
  sentimentStore?: SentimentStore;
  clock?: () => Date;
  piiMaskers?: PiiTextMasker[];
  observability?: RuntimeObservability;
  tenantAdminConfigs?: TenantAdminConfigRegistry;
  reviewSla?: {
    pendingTargetMinutes?: number;
    assignedTargetMinutes?: number;
  };
}

export class ConversationIntelligenceService {
  private readonly engine: CanonicalAnalysisEngine;
  private readonly store: JobStore;
  private readonly sentimentStore?: SentimentStore;
  private readonly clock: () => Date;
  private readonly piiMaskers: PiiTextMasker[];
  private readonly observability: RuntimeObservability;
  private readonly tenantAdminConfigs?: TenantAdminConfigRegistry;
  private readonly reviewSla: {
    pendingTargetMinutes: number;
    assignedTargetMinutes: number;
  };

  constructor(options: ConversationIntelligenceServiceOptions) {
    this.engine = options.engine;
    this.store = options.store;
    this.sentimentStore = options.sentimentStore;
    this.clock = options.clock ?? (() => new Date());
    this.piiMaskers = options.piiMaskers ?? [];
    this.observability = options.observability ?? noopRuntimeObservability;
    this.tenantAdminConfigs = options.tenantAdminConfigs;
    this.reviewSla = {
      pendingTargetMinutes: options.reviewSla?.pendingTargetMinutes ?? 60,
      assignedTargetMinutes: options.reviewSla?.assignedTargetMinutes ?? 30,
    };
  }

  async analyzeNow(requestInput: AnalysisRequestDraft): Promise<ConversationAnalysis> {
    const span = this.observability.startSpan('conversation_intelligence.analyze_now');
    const request = this.prepareRequest(requestInput);
    const tenantConfig = await this.resolveTenantAdminConfig(
      request.request.transcript.tenantId,
      request.request.transcript.useCase,
    );
    const startedAt = Date.now();

    try {
      const result = await analyzeConversation(request.request.transcript, request.request.tenantPack, {
        engine: this.engine,
        now: this.clock(),
        piiRedactionSummary: request.summary,
        piiTokenMap: request.tokenMap,
        observability: this.observability,
        sentimentScoringConfig: tenantConfig.sentimentScoring,
      });

      this.observability.recordHistogram(
        'conversation_intelligence.analyze_now.duration_ms',
        Date.now() - startedAt,
        {
          tenant_id: request.request.transcript.tenantId,
          engine: result.trace.engine,
        },
      );
      span.end('ok', {
        tenant_id: request.request.transcript.tenantId,
        engine: result.trace.engine,
      });

      return result;
    } catch (error) {
      span.fail(error);
      span.end('error');
      throw error;
    }
  }

  async submitJob(requestInput: AnalysisRequestDraft): Promise<AnalysisJobRecord> {
    const span = this.observability.startSpan('conversation_intelligence.submit_job');
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

    await this.appendRunEvent({
      runId: job.jobId,
      tenantId: job.tenantId,
      type: 'RUN_CREATED',
      summary: 'Run queued for processing.',
      metadata: {
        conversationId: job.conversationId ?? '',
        useCase: job.useCase,
      },
    });

    await this.appendRunEvent({
      runId: job.jobId,
      tenantId: job.tenantId,
      type: 'PII_MASKED',
      summary: request.summary.applied
        ? `PII masking applied with ${request.summary.redactionCount} redactions.`
        : 'PII masking disabled for this request.',
      metadata: {
        redactionCount: request.summary.redactionCount,
        applied: request.summary.applied,
      },
    });

    this.observability.incrementCounter('conversation_intelligence.jobs.queued', 1, {
      tenant_id: job.tenantId,
      use_case: job.useCase,
    });
    span.end('ok', {
      tenant_id: job.tenantId,
      use_case: job.useCase,
    });

    return job;
  }

  async getJob(jobId: string): Promise<AnalysisJobRecord | null> {
    return this.store.getJob(jobId);
  }

  async listJobs(tenantId?: string): Promise<AnalysisJobRecord[]> {
    return this.store.listJobs(tenantId ? { tenantId } : {});
  }

  async listReviewQueue(tenantId?: string): Promise<ReviewQueueSnapshot> {
    const [snapshot, jobs] = await Promise.all([
      this.store.listReviewQueue(tenantId),
      this.listJobs(tenantId),
    ]);
    const jobById = new Map(jobs.map((job) => [job.jobId, job]));
    const configCache = new Map<string, TenantAdminConfig>();
    const items: ReviewQueueItem[] = [];

    for (const item of snapshot.items) {
      const job = jobById.get(item.jobId);
      if (!job) {
        items.push(item);
        continue;
      }

      const config = await this.resolveTenantAdminConfig(job.tenantId, job.useCase, configCache);
      items.push({
        ...item,
        policy: this.toReviewPolicySummary(config),
      });
    }

    return reviewQueueSnapshotSchema.parse({
      ...snapshot,
      items,
    });
  }

  async getReviewAnalytics(tenantId?: string): Promise<ReviewAnalytics> {
    const [reviewQueue, jobs] = await Promise.all([
      this.listReviewQueue(tenantId),
      this.listJobs(tenantId),
    ]);

    const decisionCounts = {
      VERIFY: 0,
      MARK_UNCERTAIN: 0,
      KEEP_NEEDS_REVIEW: 0,
    };
    const resultingStateCounts = {
      VERIFIED: 0,
      UNCERTAIN: 0,
      NEEDS_REVIEW: 0,
    };
    const byActor = new Map<string, ReviewAnalytics['byActor'][number]>();
    const policyCounts = new Map<string, ReviewAnalytics['sla']['configuredPolicies'][number]>();
    let unassignedOverdueCount = 0;
    let assignedOverdueCount = 0;
    let oldestPendingAgeMinutes = 0;
    let oldestAssignedAgeMinutes = 0;
    const jobById = new Map(jobs.map((job) => [job.jobId, job]));

    for (const job of jobs) {
      const resolution = job.result?.review.resolution;
      if (!resolution) {
        continue;
      }

      decisionCounts[resolution.decision] += 1;
      resultingStateCounts[resolution.resultingState] += 1;

      const key = `${resolution.actorType}:${resolution.actorId}`;
      const existing = byActor.get(key) ?? {
        actorId: resolution.actorId,
        actorType: resolution.actorType,
        decisionCount: 0,
      };
      existing.decisionCount += 1;
      byActor.set(key, existing);
    }

    for (const item of reviewQueue.items) {
      const job = jobById.get(item.jobId);
      const policy = item.policy ?? this.defaultReviewPolicySummary();
      const scopeKey = `${item.tenantId}:${job?.useCase ?? 'support'}`;
      const existingPolicyCount = policyCounts.get(scopeKey) ?? {
        tenantId: item.tenantId,
        useCase: job?.useCase ?? 'support',
        pendingTargetMinutes: policy.pendingTargetMinutes,
        assignedTargetMinutes: policy.assignedTargetMinutes,
        assignmentMode: policy.assignmentMode,
        requireAssignmentBeforeDecision: policy.requireAssignmentBeforeDecision,
        runCount: 0,
      };
      existingPolicyCount.runCount += 1;
      policyCounts.set(scopeKey, existingPolicyCount);

      const assignedAt = item.review.assignment?.assignedAt;
      const ageMinutes = this.ageMinutes(assignedAt ?? item.createdAt);

      if (assignedAt) {
        oldestAssignedAgeMinutes = Math.max(oldestAssignedAgeMinutes, ageMinutes);
        if (ageMinutes >= policy.assignedTargetMinutes) {
          assignedOverdueCount += 1;
        }
      } else {
        oldestPendingAgeMinutes = Math.max(oldestPendingAgeMinutes, ageMinutes);
        if (ageMinutes >= policy.pendingTargetMinutes) {
          unassignedOverdueCount += 1;
        }
      }
    }

    const configuredPolicies = Array.from(policyCounts.values()).sort((left, right) => {
      if (right.runCount !== left.runCount) {
        return right.runCount - left.runCount;
      }
      const byTenant = left.tenantId.localeCompare(right.tenantId);
      if (byTenant !== 0) {
        return byTenant;
      }
      return left.useCase.localeCompare(right.useCase);
    });
    const primaryPolicy = configuredPolicies[0];

    return reviewAnalyticsSchema.parse({
      generatedAt: this.clock().toISOString(),
      pendingCount: reviewQueue.items.length,
      assignedCount: reviewQueue.items.filter((item) => item.review.assignment).length,
      decisionCounts,
      resultingStateCounts,
      byActor: Array.from(byActor.values()).sort((left, right) => right.decisionCount - left.decisionCount),
      sla: {
        pendingTargetMinutes: primaryPolicy?.pendingTargetMinutes ?? this.reviewSla.pendingTargetMinutes,
        assignedTargetMinutes: primaryPolicy?.assignedTargetMinutes ?? this.reviewSla.assignedTargetMinutes,
        overdueCount: unassignedOverdueCount + assignedOverdueCount,
        unassignedOverdueCount,
        assignedOverdueCount,
        oldestPendingAgeMinutes,
        oldestAssignedAgeMinutes,
        configuredPolicies,
      },
    });
  }

  async listRunEvents(runId: string): Promise<RunEventsSnapshot> {
    return this.store.listRunEvents(runId);
  }

  async appendAuditEvent(input: {
    tenantId: string;
    actor: AuthContext;
    action: AuditAction;
    resourceType: AuditEvent['resourceType'];
    resourceId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<AuditEvent> {
    return this.store.appendAuditEvent({
      auditId: randomUUID(),
      tenantId: input.tenantId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      occurredAt: this.clock().toISOString(),
      actor: input.actor,
      metadata: input.metadata ?? {},
    });
  }

  async listAuditEvents(tenantId?: string, resourceId?: string): Promise<AuditEventsSnapshot> {
    return this.store.listAuditEvents({
      tenantId,
      resourceId,
    });
  }

  async recordReviewComment(
    jobId: string,
    input: ReviewCommentRequest,
    actor: AuthContext,
  ): Promise<AnalysisJobRecord> {
    const existing = await this.store.getJob(jobId);

    if (!existing) {
      throw new Error(`Run ${jobId} was not found.`);
    }

    if (existing.status !== 'COMPLETED' || !existing.result) {
      throw new Error(`Run ${jobId} is not ready for analyst comments.`);
    }

    const parsed = reviewCommentRequestSchema.parse(input);
    const commentedAt = this.clock().toISOString();
    const adminConfig = await this.resolveTenantAdminConfig(existing.tenantId, existing.useCase);
    const assignmentUpdate = this.applyAssignmentPolicy(
      existing.result.review,
      actor,
      adminConfig,
      'comment',
      commentedAt,
    );
    const updated = await this.store.updateJob({
      ...existing,
      updatedAt: commentedAt,
      result: {
        ...existing.result,
        review: {
          ...assignmentUpdate.review,
          comments: [
            ...(assignmentUpdate.review.comments ?? []),
            {
              commentId: randomUUID(),
              actorId: actor.principalId,
              actorType: actor.principalType,
              createdAt: commentedAt,
              text: parsed.comment,
            },
          ],
          history: [
            ...(assignmentUpdate.review.history ?? []),
            {
              kind: 'COMMENT',
              actedAt: commentedAt,
              actorId: actor.principalId,
              actorType: actor.principalType,
              note: parsed.comment,
            },
          ],
        },
      },
    });

    if (assignmentUpdate.autoAssigned) {
      await this.emitAutoAssignmentEvent(updated, actor, assignmentUpdate.assignmentNote, commentedAt);
    }

    await this.appendRunEvent({
      runId: updated.jobId,
      tenantId: updated.tenantId,
      type: 'ANALYST_COMMENT_ADDED',
      summary: `Analyst comment added by ${actor.principalId}.`,
      actor,
      metadata: {
        commentLength: parsed.comment.length,
      },
    });

    this.observability.incrementCounter('conversation_intelligence.review.comments', 1, {
      tenant_id: updated.tenantId,
      actor_type: actor.principalType,
    });

    return updated;
  }

  async recordReviewDecision(
    jobId: string,
    input: ReviewDecisionRequest,
    actor: AuthContext,
  ): Promise<AnalysisJobRecord> {
    const existing = await this.store.getJob(jobId);

    if (!existing) {
      throw new Error(`Run ${jobId} was not found.`);
    }

    if (existing.status !== 'COMPLETED' || !existing.result) {
      throw new Error(`Run ${jobId} is not ready for analyst review.`);
    }

    const parsed = reviewDecisionRequestSchema.parse(input);
    const decidedAt = this.clock().toISOString();
    const adminConfig = await this.resolveTenantAdminConfig(existing.tenantId, existing.useCase);
    const assignmentUpdate = this.applyAssignmentPolicy(
      existing.result.review,
      actor,
      adminConfig,
      'decision',
      decidedAt,
    );
    if (adminConfig.reviewWorkflow.assignment.requireAssignmentBeforeDecision && !assignmentUpdate.review.assignment) {
      throw new Error(`Run ${jobId} must be assigned before a review decision can be recorded.`);
    }
    const resultingState = this.reviewStateFromDecision(parsed.decision);
    const analystSentiment = parsed.sentimentLabel
      ? {
        score100: parsed.sentimentLabel.score100,
        score5: deriveScore5FromScore100(parsed.sentimentLabel.score100),
        correctionApplied: parsed.sentimentLabel.correctionApplied,
        note: parsed.sentimentLabel.note,
        reviewedAt: decidedAt,
        reviewedById: actor.principalId,
        reviewedByType: actor.principalType,
      }
      : assignmentUpdate.review.analystSentiment;
    const updated = await this.store.updateJob({
      ...existing,
      updatedAt: decidedAt,
      result: {
        ...existing.result,
        review: {
          ...assignmentUpdate.review,
          analystSentiment,
          state: resultingState,
          resolution: {
            decision: parsed.decision,
            resultingState,
            note: parsed.note,
            decidedAt,
            actorId: actor.principalId,
            actorType: actor.principalType,
          },
          history: [
            ...(assignmentUpdate.review.history ?? []),
            {
              kind: 'DECISION',
              actedAt: decidedAt,
              actorId: actor.principalId,
              actorType: actor.principalType,
              note: parsed.note,
              decision: parsed.decision,
              resultingState,
            },
          ],
        },
      },
    });

    if (assignmentUpdate.autoAssigned) {
      await this.emitAutoAssignmentEvent(updated, actor, assignmentUpdate.assignmentNote, decidedAt);
    }

    await this.appendRunEvent({
      runId: updated.jobId,
      tenantId: updated.tenantId,
      type: 'ANALYST_REVIEW_RECORDED',
      summary: this.reviewSummary(parsed.decision, actor.principalId),
      actor,
      metadata: {
        decision: parsed.decision,
        resultingState,
        note: parsed.note ?? '',
        analystSentimentScore100: analystSentiment?.score100,
        analystSentimentScore5: analystSentiment?.score5,
      },
    });

    await this.persistCalibrationSampleFromReview(updated, analystSentiment, decidedAt);

    this.observability.incrementCounter('conversation_intelligence.review.decisions', 1, {
      tenant_id: updated.tenantId,
      decision: parsed.decision,
      resulting_state: resultingState,
    });

    return updated;
  }

  async recordReviewAssignment(
    jobId: string,
    input: ReviewAssignmentRequest,
    actor: AuthContext,
  ): Promise<AnalysisJobRecord> {
    const existing = await this.store.getJob(jobId);

    if (!existing) {
      throw new Error(`Run ${jobId} was not found.`);
    }

    if (existing.status !== 'COMPLETED' || !existing.result) {
      throw new Error(`Run ${jobId} is not ready for analyst assignment.`);
    }

    const parsed = reviewAssignmentRequestSchema.parse(input);
    const assignedAt = this.clock().toISOString();
    const updated = await this.store.updateJob({
      ...existing,
      updatedAt: assignedAt,
      result: {
        ...existing.result,
        review: {
          ...existing.result.review,
          assignment: {
            assigneeId: actor.principalId,
            assigneeType: actor.principalType,
            assignedById: actor.principalId,
            assignedByType: actor.principalType,
            assignedAt,
            note: parsed.note,
          },
          history: [
            ...(existing.result.review.history ?? []),
            {
              kind: 'ASSIGNED',
              actedAt: assignedAt,
              actorId: actor.principalId,
              actorType: actor.principalType,
              note: parsed.note,
              assigneeId: actor.principalId,
              assigneeType: actor.principalType,
            },
          ],
        },
      },
    });

    await this.appendRunEvent({
      runId: updated.jobId,
      tenantId: updated.tenantId,
      type: 'ANALYST_ASSIGNED',
      summary: `Run assigned to ${actor.principalId}.`,
      actor,
      metadata: {
        assigneeId: actor.principalId,
        assigneeType: actor.principalType,
        note: parsed.note ?? '',
      },
    });

    this.observability.incrementCounter('conversation_intelligence.review.assignments', 1, {
      tenant_id: updated.tenantId,
      assignee_type: actor.principalType,
    });

    return updated;
  }

  async claimNextQueuedJob(workerId: string): Promise<AnalysisJobRecord | null> {
    const claimed = await this.store.claimNextQueuedJob(workerId, this.clock().toISOString());

    if (claimed) {
      await this.appendRunEvent({
        runId: claimed.jobId,
        tenantId: claimed.tenantId,
        type: 'RUN_CLAIMED',
        summary: `Worker ${workerId} claimed the run.`,
        actor: {
          authMode: 'none',
          principalId: workerId,
          principalType: 'SERVICE',
          scopes: [],
          tenantId: claimed.tenantId,
        },
        metadata: {
          workerId,
        },
      });
    }

    return claimed;
  }

  async processClaimedJob(job: AnalysisJobRecord): Promise<void> {
    const span = this.observability.startSpan('conversation_intelligence.process_claimed_job', {
      run_id: job.jobId,
      tenant_id: job.tenantId,
    });
    const existing = await this.store.getJob(job.jobId);

    if (!existing?.request) {
      span.end('ok', {
        skipped: true,
      });
      return;
    }

    await this.appendRunEvent({
      runId: existing.jobId,
      tenantId: existing.tenantId,
      type: 'LLM_STARTED',
      summary: 'Analysis engine execution started.',
      metadata: {
        useCase: existing.useCase,
      },
    });

    const startedAt = Date.now();

    try {
      const tenantConfig = await this.resolveTenantAdminConfig(existing.tenantId, existing.useCase);
      // Note: the token map for reversible PII masking is ephemeral and was not
      // persisted with the job. Async jobs therefore carry masked tokens in their
      // output. Use analyzeNow() when you need the decoded result inline.
      const result = await analyzeConversation(existing.request.transcript, existing.request.tenantPack, {
        engine: this.engine,
        jobId: existing.jobId,
        now: this.clock(),
        piiRedactionSummary: existing.piiRedactionSummary,
        observability: this.observability,
        sentimentScoringConfig: tenantConfig.sentimentScoring,
      });

      await this.appendRunEvent({
        runId: existing.jobId,
        tenantId: existing.tenantId,
        type: 'LLM_COMPLETED',
        summary: 'Analysis engine execution completed.',
        metadata: {
          engine: result.trace.engine,
          model: result.trace.model ?? '',
          durationMs: Date.now() - startedAt,
        },
      });

      if (result.review.state === 'NEEDS_REVIEW') {
        await this.appendRunEvent({
          runId: existing.jobId,
          tenantId: existing.tenantId,
          type: 'REVIEW_REQUIRED',
          summary: 'Run requires analyst review.',
          metadata: {
            reasons: result.review.reasons,
          },
        });
      }

      await this.store.updateJob({
        ...existing,
        status: 'COMPLETED',
        updatedAt: this.clock().toISOString(),
        result,
      });

      await this.appendRunEvent({
        runId: existing.jobId,
        tenantId: existing.tenantId,
        type: 'RUN_COMPLETED',
        summary: 'Run completed successfully.',
        metadata: {
          reviewState: result.review.state,
          durationMs: Date.now() - startedAt,
          schemaValidationPassed: true,
        },
      });

      await this.persistSentimentData(existing.jobId, existing.request.transcript, result);

      this.observability.incrementCounter('conversation_intelligence.jobs.completed', 1, {
        tenant_id: existing.tenantId,
        use_case: existing.useCase,
      });
      this.observability.recordHistogram(
        'conversation_intelligence.jobs.processing.duration_ms',
        Date.now() - startedAt,
        this.jobObservabilityAttributes(existing, {
          engine: result.trace.engine,
        }),
      );
      span.end('ok', {
        engine: result.trace.engine,
        review_state: result.review.state,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      const failureKind = this.classifyProcessingError(error);
      const durationMs = Date.now() - startedAt;

      await this.store.updateJob({
        ...existing,
        status: 'FAILED',
        updatedAt: this.clock().toISOString(),
        error: {
          message,
          stack,
        },
      });

      await this.appendRunEvent({
        runId: existing.jobId,
        tenantId: existing.tenantId,
        type: 'RUN_FAILED',
        summary: `Run failed: ${message}`,
        metadata: {
          message,
          failureKind,
          durationMs,
          schemaValidationPassed: failureKind === 'SCHEMA_INVALID' ? false : undefined,
        },
      });

      this.observability.incrementCounter('conversation_intelligence.jobs.failed', 1, {
        tenant_id: existing.tenantId,
        use_case: existing.useCase,
      });
      this.observability.recordHistogram(
        'conversation_intelligence.jobs.processing.duration_ms',
        durationMs,
        this.jobObservabilityAttributes(existing, {
          failed: true,
          failure_kind: failureKind,
        }),
      );
      span.fail(error);
      span.end('error');
    }
  }

  private async resolveTenantAdminConfig(
    tenantId: string,
    useCase: string,
    cache?: Map<string, TenantAdminConfig>,
  ): Promise<TenantAdminConfig> {
    const cacheKey = `${tenantId}:${useCase}`;
    const cached = cache?.get(cacheKey);
    if (cached) {
      return cached;
    }

    const config = this.tenantAdminConfigs
      ? await this.tenantAdminConfigs.get(tenantId, useCase)
      : {
        ...buildDefaultTenantAdminConfig(tenantId, useCase, this.clock().toISOString()),
        reviewWorkflow: {
          sla: {
            pendingTargetMinutes: this.reviewSla.pendingTargetMinutes,
            assignedTargetMinutes: this.reviewSla.assignedTargetMinutes,
          },
          assignment: {
            mode: 'MANUAL' as ReviewAssignmentMode,
            requireAssignmentBeforeDecision: false,
          },
        },
      };

    const merged = {
      ...config,
      reviewWorkflow: {
        sla: {
          pendingTargetMinutes: config.reviewWorkflow.sla.pendingTargetMinutes ?? this.reviewSla.pendingTargetMinutes,
          assignedTargetMinutes: config.reviewWorkflow.sla.assignedTargetMinutes ?? this.reviewSla.assignedTargetMinutes,
        },
        assignment: {
          mode: config.reviewWorkflow.assignment.mode,
          requireAssignmentBeforeDecision: config.reviewWorkflow.assignment.requireAssignmentBeforeDecision,
        },
      },
    } satisfies TenantAdminConfig;

    cache?.set(cacheKey, merged);
    return merged;
  }

  private toReviewPolicySummary(config: TenantAdminConfig) {
    return {
      pendingTargetMinutes: config.reviewWorkflow.sla.pendingTargetMinutes,
      assignedTargetMinutes: config.reviewWorkflow.sla.assignedTargetMinutes,
      assignmentMode: config.reviewWorkflow.assignment.mode,
      requireAssignmentBeforeDecision: config.reviewWorkflow.assignment.requireAssignmentBeforeDecision,
    };
  }

  private defaultReviewPolicySummary() {
    return {
      pendingTargetMinutes: this.reviewSla.pendingTargetMinutes,
      assignedTargetMinutes: this.reviewSla.assignedTargetMinutes,
      assignmentMode: 'MANUAL' as ReviewAssignmentMode,
      requireAssignmentBeforeDecision: false,
    };
  }

  private applyAssignmentPolicy(
    review: ConversationAnalysis['review'],
    actor: AuthContext,
    config: TenantAdminConfig,
    action: 'comment' | 'decision',
    actedAt: string,
  ): {
    review: ConversationAnalysis['review'];
    autoAssigned: boolean;
    assignmentNote?: string;
  } {
    if (review.assignment || config.reviewWorkflow.assignment.mode !== 'AUTO_ASSIGN_SELF') {
      return {
        review,
        autoAssigned: false,
      };
    }

    const assignmentNote = `Auto-assigned by policy during analyst ${action}.`;
    return {
      autoAssigned: true,
      assignmentNote,
      review: {
        ...review,
        assignment: {
          assigneeId: actor.principalId,
          assigneeType: actor.principalType,
          assignedById: actor.principalId,
          assignedByType: actor.principalType,
          assignedAt: actedAt,
          note: assignmentNote,
        },
        history: [
          ...(review.history ?? []),
          {
            kind: 'ASSIGNED',
            actedAt,
            actorId: actor.principalId,
            actorType: actor.principalType,
            note: assignmentNote,
            assigneeId: actor.principalId,
            assigneeType: actor.principalType,
          },
        ],
      },
    };
  }

  private async emitAutoAssignmentEvent(
    job: AnalysisJobRecord,
    actor: AuthContext,
    note: string | undefined,
    assignedAt: string,
  ): Promise<void> {
    await this.store.appendRunEvent({
      eventId: randomUUID(),
      runId: job.jobId,
      tenantId: job.tenantId,
      type: 'ANALYST_ASSIGNED',
      createdAt: assignedAt,
      summary: `Run assigned to ${actor.principalId}.`,
      actor,
      metadata: {
        assigneeId: actor.principalId,
        assigneeType: actor.principalType,
        note: note ?? '',
        autoAssigned: true,
      },
    });

    this.observability.incrementCounter('conversation_intelligence.review.assignments', 1, {
      tenant_id: job.tenantId,
      assignee_type: actor.principalType,
      auto_assigned: true,
    });
  }

  private prepareRequest(requestInput: AnalysisRequestDraft): {
    request: AnalysisRequest;
    summary: PiiRedactionSummary;
    tokenMap?: PiiTokenMap;
  } {
    const parsed = analysisRequestSchema.parse(requestInput);
    if (parsed.piiConfig.enabled && parsed.piiConfig.reversible) {
      return reversibleMaskAnalysisRequest(parsed, { customMaskers: this.piiMaskers });
    }
    return maskAnalysisRequest(parsed, { customMaskers: this.piiMaskers });
  }

  private async appendRunEvent(input: {
    runId: string;
    tenantId: string;
    type: RunEventType;
    summary: string;
    metadata?: Record<string, unknown>;
    actor?: AuthContext;
  }): Promise<RunEvent> {
    return this.store.appendRunEvent({
      eventId: randomUUID(),
      runId: input.runId,
      tenantId: input.tenantId,
      type: input.type,
      createdAt: this.clock().toISOString(),
      summary: input.summary,
      actor: input.actor,
      metadata: input.metadata ?? {},
    });
  }

  private jobObservabilityAttributes(
    job: AnalysisJobRecord,
    extra: ObservabilityAttributes = {},
  ): ObservabilityAttributes {
    return {
      tenant_id: job.tenantId,
      use_case: job.useCase,
      ...extra,
    };
  }

  private reviewStateFromDecision(
    decision: ReviewDecisionRequest['decision'],
  ): ConversationAnalysis['review']['state'] {
    switch (decision) {
      case 'VERIFY':
        return 'VERIFIED';
      case 'MARK_UNCERTAIN':
        return 'UNCERTAIN';
      case 'KEEP_NEEDS_REVIEW':
        return 'NEEDS_REVIEW';
    }
  }

  private reviewSummary(
    decision: ReviewDecisionRequest['decision'],
    principalId: string,
  ): string {
    switch (decision) {
      case 'VERIFY':
        return `Analyst ${principalId} marked the run verified.`;
      case 'MARK_UNCERTAIN':
        return `Analyst ${principalId} marked the run uncertain.`;
      case 'KEEP_NEEDS_REVIEW':
        return `Analyst ${principalId} kept the run in review.`;
    }
  }

  private classifyProcessingError(error: unknown): 'SCHEMA_INVALID' | 'ENGINE_ERROR' | 'UNKNOWN' {
    if (error instanceof ZodError) {
      return 'SCHEMA_INVALID';
    }

    if (error instanceof Error) {
      return 'ENGINE_ERROR';
    }

    return 'UNKNOWN';
  }

  private ageMinutes(timestamp: string): number {
    const millis = Date.parse(timestamp);
    if (Number.isNaN(millis)) {
      return 0;
    }

    return Math.max(0, Math.floor((this.clock().getTime() - millis) / 60000));
  }

  // ---------------------------------------------------------------------------
  // Sentiment persistence helpers — never fail the primary job path.
  // ---------------------------------------------------------------------------

  private async persistSentimentData(
    jobId: string,
    transcript: { tenantId: string; conversationId?: string; useCase: string; turns: Array<{ turnId: string; speakerId: string; text: string }> },
    result: ConversationAnalysis,
  ): Promise<void> {
    if (!this.sentimentStore) return;

    try {
      const sentiment = result.overallEndUserSentiment;
      if (sentiment) {
        const record: SentimentAnalysisRecord = {
          jobId,
          tenantId: result.tenantId,
          conversationId: result.conversationId,
          useCase: result.useCase,
          polarity: sentiment.polarity,
          intensity: sentiment.intensity,
          confidence: sentiment.confidence,
          score100: sentiment.score?.score100 ?? 50,
          score5: sentiment.score?.score5 ?? 3,
          scoringMethod: sentiment.score?.method,
          calibrationOffset: sentiment.score?.calibration?.score100Offset,
          aspectCount: result.aspectSentiments.length,
          eventCount: result.canonicalEvents.length,
          keyMomentCount: result.canonicalKeyMoments.length,
          analyzedAt: result.trace.generatedAt,
          packVersion: result.trace.packVersion,
        };
        await this.sentimentStore.saveSentimentAnalysis(record);
      }

      const speakerRoleMap = new Map(
        result.speakerAssignments.map((a) => [a.speakerId, a.role]),
      );
      const segments: SentimentSegmentRecord[] = transcript.turns.map((turn) => ({
        segmentId: `${jobId}:${turn.turnId}`,
        jobId,
        tenantId: result.tenantId,
        turnId: turn.turnId,
        speakerRole: speakerRoleMap.get(turn.speakerId) ?? 'UNKNOWN',
        text: turn.text,
      }));
      await this.sentimentStore.saveSentimentSegments(segments);

      if (result.canonicalKeyMoments.length > 0) {
        const moments: KeyMomentRecord[] = result.canonicalKeyMoments.map((km, idx) => ({
          momentId: `${jobId}:km:${idx}`,
          jobId,
          tenantId: result.tenantId,
          type: km.type,
          actorRole: km.actorRole,
          startTurnId: km.startTurnId,
          endTurnId: km.endTurnId,
          confidence: km.confidence,
          businessImpact: km.businessImpact,
          rationale: km.rationale,
          evidenceJson: JSON.stringify(km.evidence),
        }));
        await this.sentimentStore.saveKeyMoments(moments);
      }
    } catch {
      // Sentiment persistence must never block the primary job path.
    }
  }

  private async persistCalibrationSampleFromReview(
    job: AnalysisJobRecord,
    analystSentiment: { score100: number; score5: number; correctionApplied: boolean } | undefined,
    createdAt: string,
  ): Promise<void> {
    if (!this.sentimentStore || !analystSentiment || !job.result?.overallEndUserSentiment) return;

    try {
      const model = job.result.overallEndUserSentiment;
      const sample: CalibrationSampleRecord = {
        sampleId: `${job.jobId}:cal`,
        jobId: job.jobId,
        tenantId: job.tenantId,
        useCase: job.useCase,
        modelPolarity: model.polarity,
        modelIntensity: model.intensity,
        modelConfidence: model.confidence,
        modelScore100: model.score?.score100 ?? 50,
        modelScore5: model.score?.score5 ?? 3,
        analystScore100: analystSentiment.score100,
        analystScore5: analystSentiment.score5,
        deltaScore100: analystSentiment.score100 - (model.score?.score100 ?? 50),
        deltaScore5: analystSentiment.score5 - (model.score?.score5 ?? 3),
        correctionApplied: analystSentiment.correctionApplied,
        createdAt,
      };
      await this.sentimentStore.saveCalibrationSample(sample);
    } catch {
      // Calibration persistence must never block the review decision path.
    }
  }
}
