import { randomUUID } from 'crypto';
import { mkdir, readdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import {
  compiledTenantPackSchema,
  CompiledTenantPack,
  TenantPackApproveRequest,
  tenantPackApproveRequestSchema,
  tenantPackApproveResponseSchema,
  TenantPackApproveResponse,
  TenantPackCanaryDecision,
  TenantPackCanaryEvaluation,
  tenantPackCanaryEvaluationSchema,
  tenantPackCanaryPolicySchema,
  TenantPackCommentRequest,
  tenantPackCommentRequestSchema,
  tenantPackCommentResponseSchema,
  TenantPackCommentResponse,
  TenantPackDraft,
  TenantPackEvaluateCanaryRequest,
  tenantPackEvaluateCanaryRequestSchema,
  tenantPackEvaluateCanaryResponseSchema,
  TenantPackEvaluateCanaryResponse,
  TenantPackPublishRequest,
  tenantPackPublishRequestSchema,
  tenantPackPublishResponseSchema,
  TenantPackPublishResponse,
  TenantPackPromoteRequest,
  tenantPackPromoteRequestSchema,
  tenantPackPromoteResponseSchema,
  TenantPackPromoteResponse,
  TenantPackRelease,
  TenantPackReleaseActor,
  TenantPackReleaseHistoryEntry,
  tenantPackReleaseSchema,
  tenantPackRollbackRequestSchema,
  TenantPackRollbackRequest,
  tenantPackRollbackResponseSchema,
  TenantPackRollbackResponse,
  tenantPackSchema,
  tenantPackPreviewResponseSchema,
  TenantPackPreviewResponse,
  tenantPackStateSchema,
  TenantPackState,
} from '../contracts';

type ActivePackState = {
  activeVersion: string;
  previousVersion?: string;
};

type CanaryEvaluationDecision = {
  decision: TenantPackCanaryDecision;
  blockingReasons: string[];
  policy: ReturnType<typeof tenantPackCanaryPolicySchema.parse>;
  summary: string;
};

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await ensureDirectory(dirname(path));
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8');
}

async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as T;
}

export interface TenantPackRegistry {
  initialize(): Promise<void>;
  validate(tenantPack: TenantPackDraft): Promise<TenantPackPreviewResponse>;
  preview(tenantPack: TenantPackDraft): Promise<TenantPackPreviewResponse>;
  publish(input: TenantPackPublishRequest, actor?: TenantPackReleaseActor): Promise<TenantPackPublishResponse>;
  approve(input: TenantPackApproveRequest, actor?: TenantPackReleaseActor): Promise<TenantPackApproveResponse>;
  promote(input: TenantPackPromoteRequest, actor?: TenantPackReleaseActor): Promise<TenantPackPromoteResponse>;
  comment(input: TenantPackCommentRequest, actor?: TenantPackReleaseActor): Promise<TenantPackCommentResponse>;
  evaluateCanary(input: TenantPackEvaluateCanaryRequest, actor?: TenantPackReleaseActor): Promise<TenantPackEvaluateCanaryResponse>;
  rollback(input: TenantPackRollbackRequest, actor?: TenantPackReleaseActor): Promise<TenantPackRollbackResponse>;
  getActive(tenantId: string, useCase: string): Promise<CompiledTenantPack | null>;
  describe(tenantId: string, useCase: string): Promise<TenantPackState>;
}

export class FileTenantPackRegistry implements TenantPackRegistry {
  constructor(
    private readonly rootDir: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async initialize(): Promise<void> {
    await ensureDirectory(this.rootDir);
  }

  async validate(tenantPack: TenantPackDraft): Promise<TenantPackPreviewResponse> {
    return this.preview(tenantPack);
  }

  async preview(tenantPack: TenantPackDraft): Promise<TenantPackPreviewResponse> {
    return tenantPackPreviewResponseSchema.parse({
      valid: true,
      compiledPack: this.compile(tenantPack),
    });
  }

  async publish(
    input: TenantPackPublishRequest,
    actor?: TenantPackReleaseActor,
  ): Promise<TenantPackPublishResponse> {
    const parsed = tenantPackPublishRequestSchema.parse(input);
    const compiled = this.compile(parsed.tenantPack);
    const now = this.now();
    const currentState = await this.readActiveState(compiled.tenantId, compiled.useCase);
    const existingReleases = await this.readReleases(compiled.tenantId, compiled.useCase);
    const shouldStartCanary = parsed.release?.mode === 'CANARY' || Boolean(parsed.release?.canaryPercentage);

    await writeJson(this.packPath(compiled.tenantId, compiled.useCase, compiled.packVersion), compiled);

    let release = tenantPackReleaseSchema.parse({
      tenantId: compiled.tenantId,
      useCase: compiled.useCase,
      packVersion: compiled.packVersion,
      mode: parsed.release?.mode ?? 'DIRECT',
      status: parsed.release?.mode === 'APPROVAL_REQUIRED'
        ? 'PENDING_APPROVAL'
        : shouldStartCanary
          ? 'CANARY'
          : 'ACTIVE',
      note: parsed.release?.note,
      approvalsRequired: parsed.release?.mode === 'APPROVAL_REQUIRED'
        ? parsed.release.approvalsRequired ?? 1
        : 0,
      approvals: [],
      canary: shouldStartCanary
        ? {
          percentage: parsed.release?.canaryPercentage ?? 10,
          startedAt: parsed.release?.mode === 'CANARY' ? now : undefined,
          note: parsed.release?.note,
          policy: parsed.release?.canaryPolicy,
          evaluations: [],
        }
        : undefined,
      history: [],
      createdAt: now,
      updatedAt: now,
      activatedAt: parsed.release?.mode === 'DIRECT' || !parsed.release ? now : undefined,
      activatedById: parsed.release?.mode === 'DIRECT' || !parsed.release ? actor?.actorId : undefined,
      activatedByType: parsed.release?.mode === 'DIRECT' || !parsed.release ? actor?.actorType : undefined,
    });

    release = this.appendHistoryEntry(release, 'PUBLISHED', now, actor, parsed.release?.note, {
      mode: release.mode,
      status: release.status,
    });

    if (release.status === 'CANARY') {
      release = this.appendHistoryEntry(release, 'CANARY_STARTED', now, actor, parsed.release?.note, {
        percentage: release.canary?.percentage ?? 0,
      });
    }

    const releases = this.upsertRelease(existingReleases, release);

    if (release.status === 'ACTIVE') {
      const activated = await this.activateRelease({
        tenantId: compiled.tenantId,
        useCase: compiled.useCase,
        targetPackVersion: compiled.packVersion,
        releases,
        state: currentState,
        actor,
        note: parsed.release?.note,
      });

      return tenantPackPublishResponseSchema.parse({
        activeVersion: activated.activeVersion,
        previousVersion: activated.previousVersion,
        compiledPack: compiled,
        release: activated.release,
        availableVersions: await this.listVersions(compiled.tenantId, compiled.useCase),
      });
    }

    await this.writeReleases(compiled.tenantId, compiled.useCase, releases);

    return tenantPackPublishResponseSchema.parse({
      activeVersion: currentState?.activeVersion,
      previousVersion: currentState?.previousVersion,
      compiledPack: compiled,
      release,
      availableVersions: await this.listVersions(compiled.tenantId, compiled.useCase),
    });
  }

  async approve(
    input: TenantPackApproveRequest,
    actor?: TenantPackReleaseActor,
  ): Promise<TenantPackApproveResponse> {
    const parsed = tenantPackApproveRequestSchema.parse(input);
    const now = this.now();
    const state = await this.readActiveState(parsed.tenantId, parsed.useCase);
    const releases = await this.readReleases(parsed.tenantId, parsed.useCase);
    const target = releases.find((release) => release.packVersion === parsed.targetPackVersion);

    if (!target) {
      throw new Error(`Release ${parsed.targetPackVersion} was not found for ${parsed.tenantId}/${parsed.useCase}.`);
    }

    if (target.status !== 'PENDING_APPROVAL') {
      throw new Error(`Release ${parsed.targetPackVersion} is not waiting for approval.`);
    }

    const approvals = actor && !target.approvals.some((approval) => approval.actorId === actor.actorId && approval.actorType === actor.actorType)
      ? [...target.approvals, {
        ...actor,
        approvedAt: now,
        note: parsed.note,
      }]
      : target.approvals;

    let updated = tenantPackReleaseSchema.parse({
      ...target,
      approvals,
      updatedAt: now,
    });
    updated = this.appendHistoryEntry(updated, 'APPROVED', now, actor, parsed.note, {
      approvalCount: updated.approvals.length,
      approvalsRequired: updated.approvalsRequired,
    });

    let nextReleases = this.upsertRelease(releases, updated);

    if (updated.approvals.length >= updated.approvalsRequired) {
      if (updated.canary) {
        updated = tenantPackReleaseSchema.parse({
          ...updated,
          status: 'CANARY',
          updatedAt: now,
          canary: {
            ...updated.canary,
            startedAt: updated.canary.startedAt ?? now,
            note: parsed.note ?? updated.canary.note,
          },
        });
        updated = this.appendHistoryEntry(updated, 'CANARY_STARTED', now, actor, parsed.note, {
          percentage: updated.canary?.percentage ?? 0,
        });
        nextReleases = this.upsertRelease(nextReleases, updated);
        await this.writeReleases(parsed.tenantId, parsed.useCase, nextReleases);

        return tenantPackApproveResponseSchema.parse({
          activeVersion: state?.activeVersion,
          previousVersion: state?.previousVersion,
          release: updated,
          availableVersions: await this.listVersions(parsed.tenantId, parsed.useCase),
        });
      }

      const activated = await this.activateRelease({
        tenantId: parsed.tenantId,
        useCase: parsed.useCase,
        targetPackVersion: parsed.targetPackVersion,
        releases: nextReleases,
        state,
        actor,
        note: parsed.note,
      });

      return tenantPackApproveResponseSchema.parse({
        activeVersion: activated.activeVersion,
        previousVersion: activated.previousVersion,
        release: activated.release,
        availableVersions: await this.listVersions(parsed.tenantId, parsed.useCase),
      });
    }

    await this.writeReleases(parsed.tenantId, parsed.useCase, nextReleases);

    return tenantPackApproveResponseSchema.parse({
      activeVersion: state?.activeVersion,
      previousVersion: state?.previousVersion,
      release: updated,
      availableVersions: await this.listVersions(parsed.tenantId, parsed.useCase),
    });
  }

  async promote(
    input: TenantPackPromoteRequest,
    actor?: TenantPackReleaseActor,
  ): Promise<TenantPackPromoteResponse> {
    const parsed = tenantPackPromoteRequestSchema.parse(input);
    const now = this.now();
    const state = await this.readActiveState(parsed.tenantId, parsed.useCase);
    const releases = await this.readReleases(parsed.tenantId, parsed.useCase);
    const target = releases.find((release) => release.packVersion === parsed.targetPackVersion);

    if (!target) {
      throw new Error(`Release ${parsed.targetPackVersion} was not found for ${parsed.tenantId}/${parsed.useCase}.`);
    }

    if (target.status !== 'CANARY') {
      throw new Error(`Release ${parsed.targetPackVersion} is not in canary.`);
    }

    const evaluation = this.createManualCanaryEvaluation(target, parsed.result, now, actor, parsed.note);
    let updated = this.appendCanaryEvaluation(target, evaluation, now, parsed.note);
    let nextReleases = this.upsertRelease(releases, updated);

    if (parsed.result === 'FAIL') {
      updated = this.rejectRelease(updated, now, actor, parsed.note, {
        source: 'manual_promote',
      });
      nextReleases = this.upsertRelease(nextReleases, updated);
      await this.writeReleases(parsed.tenantId, parsed.useCase, nextReleases);
      return tenantPackPromoteResponseSchema.parse({
        activeVersion: state?.activeVersion,
        previousVersion: state?.previousVersion,
        release: updated,
        availableVersions: await this.listVersions(parsed.tenantId, parsed.useCase),
      });
    }

    const activated = await this.activateRelease({
      tenantId: parsed.tenantId,
      useCase: parsed.useCase,
      targetPackVersion: parsed.targetPackVersion,
      releases: nextReleases,
      state,
      actor,
      note: parsed.note,
    });

    return tenantPackPromoteResponseSchema.parse({
      activeVersion: activated.activeVersion,
      previousVersion: activated.previousVersion,
      release: activated.release,
      availableVersions: await this.listVersions(parsed.tenantId, parsed.useCase),
    });
  }

  async comment(
    input: TenantPackCommentRequest,
    actor?: TenantPackReleaseActor,
  ): Promise<TenantPackCommentResponse> {
    const parsed = tenantPackCommentRequestSchema.parse(input);
    const state = await this.readActiveState(parsed.tenantId, parsed.useCase);
    const releases = await this.readReleases(parsed.tenantId, parsed.useCase);
    const target = releases.find((release) => release.packVersion === parsed.targetPackVersion);

    if (!target) {
      throw new Error(`Release ${parsed.targetPackVersion} was not found for ${parsed.tenantId}/${parsed.useCase}.`);
    }

    const updated = this.appendHistoryEntry(target, 'COMMENTED', this.now(), actor, parsed.comment, {});
    const nextReleases = this.upsertRelease(releases, updated);
    await this.writeReleases(parsed.tenantId, parsed.useCase, nextReleases);

    return tenantPackCommentResponseSchema.parse({
      activeVersion: state?.activeVersion,
      previousVersion: state?.previousVersion,
      release: updated,
      availableVersions: await this.listVersions(parsed.tenantId, parsed.useCase),
    });
  }

  async evaluateCanary(
    input: TenantPackEvaluateCanaryRequest,
    actor?: TenantPackReleaseActor,
  ): Promise<TenantPackEvaluateCanaryResponse> {
    const parsed = tenantPackEvaluateCanaryRequestSchema.parse(input);
    const now = this.now();
    const state = await this.readActiveState(parsed.tenantId, parsed.useCase);
    const releases = await this.readReleases(parsed.tenantId, parsed.useCase);
    const target = releases.find((release) => release.packVersion === parsed.targetPackVersion);

    if (!target) {
      throw new Error(`Release ${parsed.targetPackVersion} was not found for ${parsed.tenantId}/${parsed.useCase}.`);
    }

    if (target.status !== 'CANARY') {
      throw new Error(`Release ${parsed.targetPackVersion} is not in canary.`);
    }

    const decision = this.evaluateCanaryDecision(target, parsed.metrics, parsed.policy);
    const evaluation = tenantPackCanaryEvaluationSchema.parse({
      evaluationId: randomUUID(),
      decidedAt: now,
      actorId: actor?.actorId,
      actorType: actor?.actorType,
      decision: decision.decision,
      summary: decision.summary,
      metrics: parsed.metrics,
      policy: decision.policy,
      blockingReasons: decision.blockingReasons,
      note: parsed.note,
      applied: parsed.applyResult,
    });

    let updated = this.appendCanaryEvaluation(target, evaluation, now, parsed.note);
    let nextReleases = this.upsertRelease(releases, updated);

    if (parsed.applyResult) {
      if (evaluation.decision === 'PASS') {
        const activated = await this.activateRelease({
          tenantId: parsed.tenantId,
          useCase: parsed.useCase,
          targetPackVersion: parsed.targetPackVersion,
          releases: nextReleases,
          state,
          actor,
          note: parsed.note ?? evaluation.summary,
        });

        return tenantPackEvaluateCanaryResponseSchema.parse({
          activeVersion: activated.activeVersion,
          previousVersion: activated.previousVersion,
          release: activated.release,
          evaluation,
          availableVersions: await this.listVersions(parsed.tenantId, parsed.useCase),
        });
      }

      updated = this.rejectRelease(updated, now, actor, parsed.note ?? evaluation.summary, {
        source: 'automated_evaluation',
      });
      nextReleases = this.upsertRelease(nextReleases, updated);
    }

    await this.writeReleases(parsed.tenantId, parsed.useCase, nextReleases);

    return tenantPackEvaluateCanaryResponseSchema.parse({
      activeVersion: state?.activeVersion,
      previousVersion: state?.previousVersion,
      release: updated,
      evaluation,
      availableVersions: await this.listVersions(parsed.tenantId, parsed.useCase),
    });
  }

  async rollback(
    input: TenantPackRollbackRequest,
    actor?: TenantPackReleaseActor,
  ): Promise<TenantPackRollbackResponse> {
    const parsed = tenantPackRollbackRequestSchema.parse(input);
    const compiled = await this.readPack(parsed.tenantId, parsed.useCase, parsed.targetPackVersion);
    if (!compiled) {
      throw new Error(`Pack ${parsed.targetPackVersion} was not found for ${parsed.tenantId}/${parsed.useCase}.`);
    }

    const state = await this.readActiveState(parsed.tenantId, parsed.useCase);
    const releases = await this.readReleases(parsed.tenantId, parsed.useCase);
    const existing = releases.find((release) => release.packVersion === parsed.targetPackVersion);
    const seedRelease = existing ?? tenantPackReleaseSchema.parse({
      tenantId: parsed.tenantId,
      useCase: parsed.useCase,
      packVersion: parsed.targetPackVersion,
      mode: 'DIRECT',
      status: 'ACTIVE',
      approvalsRequired: 0,
      approvals: [],
      history: [],
      createdAt: compiled.compiledAt,
      updatedAt: this.now(),
    });

    const activated = await this.activateRelease({
      tenantId: parsed.tenantId,
      useCase: parsed.useCase,
      targetPackVersion: parsed.targetPackVersion,
      releases: this.upsertRelease(releases, seedRelease),
      state,
      actor,
      note: parsed.note ?? 'Rollback activated this pack version.',
      activationKind: 'ROLLED_BACK',
    });

    return tenantPackRollbackResponseSchema.parse({
      activeVersion: activated.activeVersion,
      previousVersion: activated.previousVersion,
      compiledPack: compiled,
      release: activated.release,
      availableVersions: await this.listVersions(parsed.tenantId, parsed.useCase),
    });
  }

  async getActive(tenantId: string, useCase: string): Promise<CompiledTenantPack | null> {
    const state = await this.readActiveState(tenantId, useCase);
    if (!state) {
      return null;
    }

    return this.readPack(tenantId, useCase, state.activeVersion);
  }

  async describe(tenantId: string, useCase: string): Promise<TenantPackState> {
    const [state, activePack, availableVersions, releases] = await Promise.all([
      this.readActiveState(tenantId, useCase),
      this.getActive(tenantId, useCase),
      this.listVersions(tenantId, useCase),
      this.readReleases(tenantId, useCase),
    ]);

    return tenantPackStateSchema.parse({
      tenantId,
      useCase,
      activeVersion: state?.activeVersion,
      availableVersions,
      activePack,
      releases: releases.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    });
  }

  private compile(tenantPack: TenantPackDraft): CompiledTenantPack {
    const parsed = tenantPackSchema.parse(tenantPack);
    const warnings: string[] = [];

    if (parsed.analysisPolicy.sentimentRoles.length === 0) {
      warnings.push('No sentiment roles configured.');
    }
    if (parsed.policyDigest.length === 0) {
      warnings.push('Policy digest is empty.');
    }
    if (Object.keys(parsed.roleAliases).length === 0 && Object.keys(parsed.speakerIdRoleMap).length === 0) {
      warnings.push('No role aliases or speaker ID mappings configured.');
    }

    return compiledTenantPackSchema.parse({
      tenantId: parsed.tenantId,
      packVersion: parsed.packVersion,
      useCase: parsed.useCase,
      compiledAt: this.now(),
      runtimePack: parsed,
      digest: {
        roleAliasCount: Object.keys(parsed.roleAliases).length,
        speakerIdRoleCount: Object.keys(parsed.speakerIdRoleMap).length,
        policyDigestEntryCount: parsed.policyDigest.length,
        canonicalMappingCount: Object.keys(parsed.taxonomy.canonicalToTenant).length,
        supportedEventTypeCount: parsed.supportedCanonicalEventTypes.length,
      },
      warnings,
    });
  }

  private async activateRelease(input: {
    tenantId: string;
    useCase: string;
    targetPackVersion: string;
    releases: TenantPackRelease[];
    state: ActivePackState | null;
    actor?: TenantPackReleaseActor;
    note?: string;
    activationKind?: 'ACTIVATED' | 'ROLLED_BACK';
  }): Promise<{
    activeVersion: string;
    previousVersion?: string;
    release: TenantPackRelease;
  }> {
    const now = this.now();
    const activationKind = input.activationKind ?? 'ACTIVATED';
    const nextReleases = input.releases.map((release) => {
      if (release.packVersion === input.targetPackVersion) {
        let updated = tenantPackReleaseSchema.parse({
          ...release,
          status: 'ACTIVE',
          updatedAt: now,
          activatedAt: now,
          activatedById: input.actor?.actorId,
          activatedByType: input.actor?.actorType,
          note: input.note ?? release.note,
          canary: release.canary
            ? {
              ...release.canary,
              completedAt: release.canary.completedAt,
              result: release.canary.result,
            }
            : undefined,
          rejectedAt: undefined,
        });
        updated = this.appendHistoryEntry(updated, activationKind, now, input.actor, input.note, {
          previousVersion: input.state?.activeVersion ?? '',
        });
        return updated;
      }

      if (release.status === 'ACTIVE') {
        let updated = tenantPackReleaseSchema.parse({
          ...release,
          status: 'SUPERSEDED',
          updatedAt: now,
          supersededAt: now,
        });
        updated = this.appendHistoryEntry(updated, 'SUPERSEDED', now, input.actor, input.note, {
          supersededBy: input.targetPackVersion,
        });
        return updated;
      }

      return release;
    });

    const activeState: ActivePackState = {
      activeVersion: input.targetPackVersion,
      previousVersion: input.state?.activeVersion,
    };

    await writeJson(this.activeStatePath(input.tenantId, input.useCase), activeState);
    await this.writeReleases(input.tenantId, input.useCase, nextReleases);

    const release = nextReleases.find((item) => item.packVersion === input.targetPackVersion);
    if (!release) {
      throw new Error(`Release ${input.targetPackVersion} could not be activated.`);
    }

    return {
      activeVersion: input.targetPackVersion,
      previousVersion: input.state?.activeVersion,
      release,
    };
  }

  private createManualCanaryEvaluation(
    release: TenantPackRelease,
    decision: TenantPackCanaryDecision,
    now: string,
    actor?: TenantPackReleaseActor,
    note?: string,
  ): TenantPackCanaryEvaluation {
    return tenantPackCanaryEvaluationSchema.parse({
      evaluationId: randomUUID(),
      decidedAt: now,
      actorId: actor?.actorId,
      actorType: actor?.actorType,
      decision,
      summary: decision === 'PASS'
        ? 'Canary passed manual promotion review.'
        : 'Canary failed manual promotion review.',
      metrics: {
        sampleSize: release.canary?.evaluations.length ?? 0,
        failureRate: decision === 'FAIL' ? 1 : 0,
        reviewRate: 0,
        uncertainRate: 0,
      },
      policy: tenantPackCanaryPolicySchema.parse(release.canary?.policy ?? {}),
      blockingReasons: decision === 'FAIL' ? ['Manual canary promotion was marked failed.'] : [],
      note,
      applied: true,
    });
  }

  private evaluateCanaryDecision(
    release: TenantPackRelease,
    metrics: TenantPackEvaluateCanaryRequest['metrics'],
    overridePolicy?: TenantPackEvaluateCanaryRequest['policy'],
  ): CanaryEvaluationDecision {
    const policy = tenantPackCanaryPolicySchema.parse(overridePolicy ?? release.canary?.policy ?? {});
    const blockingReasons: string[] = [];

    if (metrics.sampleSize < policy.minimumSampleSize) {
      blockingReasons.push(`sample size ${metrics.sampleSize} is below required ${policy.minimumSampleSize}`);
    }
    if (metrics.failureRate > policy.maximumFailureRate) {
      blockingReasons.push(`failure rate ${metrics.failureRate.toFixed(3)} exceeds ${policy.maximumFailureRate.toFixed(3)}`);
    }
    if (metrics.reviewRate > policy.maximumReviewRate) {
      blockingReasons.push(`review rate ${metrics.reviewRate.toFixed(3)} exceeds ${policy.maximumReviewRate.toFixed(3)}`);
    }
    if (metrics.uncertainRate > policy.maximumUncertainRate) {
      blockingReasons.push(`uncertain rate ${metrics.uncertainRate.toFixed(3)} exceeds ${policy.maximumUncertainRate.toFixed(3)}`);
    }
    if (
      typeof policy.minimumAverageScore100 === 'number'
      && typeof metrics.averageScore100 === 'number'
      && metrics.averageScore100 < policy.minimumAverageScore100
    ) {
      blockingReasons.push(`average score ${metrics.averageScore100.toFixed(1)} is below ${policy.minimumAverageScore100.toFixed(1)}`);
    }

    return {
      decision: blockingReasons.length > 0 ? 'FAIL' : 'PASS',
      blockingReasons,
      policy,
      summary: blockingReasons.length > 0
        ? `Canary failed automated evaluation: ${blockingReasons.join('; ')}.`
        : 'Canary passed automated evaluation.',
    };
  }

  private appendCanaryEvaluation(
    release: TenantPackRelease,
    evaluation: TenantPackCanaryEvaluation,
    now: string,
    note?: string,
  ): TenantPackRelease {
    let updated = tenantPackReleaseSchema.parse({
      ...release,
      updatedAt: now,
      canary: release.canary
        ? {
          ...release.canary,
          note: note ?? release.canary.note,
          completedAt: evaluation.applied ? now : release.canary.completedAt,
          result: evaluation.applied ? evaluation.decision : release.canary.result,
          evaluations: [...(release.canary.evaluations ?? []), evaluation],
        }
        : undefined,
    });
    updated = this.appendHistoryEntry(updated, 'CANARY_EVALUATED', now, {
      actorId: evaluation.actorId ?? 'system',
      actorType: evaluation.actorType ?? 'SYSTEM',
    }, note ?? evaluation.summary, {
      decision: evaluation.decision,
      applied: evaluation.applied,
      blockingReasonCount: evaluation.blockingReasons.length,
    });
    return updated;
  }

  private rejectRelease(
    release: TenantPackRelease,
    now: string,
    actor?: TenantPackReleaseActor,
    note?: string,
    metadata: Record<string, unknown> = {},
  ): TenantPackRelease {
    let updated = tenantPackReleaseSchema.parse({
      ...release,
      status: 'REJECTED',
      updatedAt: now,
      rejectedAt: now,
      canary: release.canary
        ? {
          ...release.canary,
          completedAt: release.canary.completedAt ?? now,
          result: 'FAIL',
          note: note ?? release.canary.note,
        }
        : undefined,
    });
    updated = this.appendHistoryEntry(updated, 'REJECTED', now, actor, note, metadata);
    return updated;
  }

  private appendHistoryEntry(
    release: TenantPackRelease,
    kind: TenantPackReleaseHistoryEntry['kind'],
    createdAt: string,
    actor?: TenantPackReleaseActor,
    note?: string,
    metadata: Record<string, unknown> = {},
  ): TenantPackRelease {
    const entry: TenantPackReleaseHistoryEntry = {
      entryId: randomUUID(),
      kind,
      createdAt,
      actorId: actor?.actorId,
      actorType: actor?.actorType,
      note,
      status: release.status,
      metadata,
    };

    return tenantPackReleaseSchema.parse({
      ...release,
      updatedAt: createdAt,
      history: [...(release.history ?? []), entry],
    });
  }

  private upsertRelease(releases: TenantPackRelease[], release: TenantPackRelease): TenantPackRelease[] {
    const filtered = releases.filter((item) => item.packVersion !== release.packVersion);
    return [...filtered, release];
  }

  private async listVersions(tenantId: string, useCase: string): Promise<string[]> {
    try {
      const entries = await readdir(this.packDir(tenantId, useCase));
      return entries
        .filter((entry) => entry.endsWith('.json') && entry !== 'active.json' && entry !== 'releases.json')
        .map((entry) => entry.replace(/\.json$/, ''))
        .sort();
    } catch {
      return [];
    }
  }

  private async readActiveState(tenantId: string, useCase: string): Promise<ActivePackState | null> {
    try {
      return await readJson<ActivePackState>(this.activeStatePath(tenantId, useCase));
    } catch {
      return null;
    }
  }

  private async readReleases(tenantId: string, useCase: string): Promise<TenantPackRelease[]> {
    try {
      const releases = await readJson<TenantPackRelease[]>(this.releasesPath(tenantId, useCase));
      return releases.map((release) => tenantPackReleaseSchema.parse(release));
    } catch {
      return [];
    }
  }

  private async writeReleases(tenantId: string, useCase: string, releases: TenantPackRelease[]): Promise<void> {
    await writeJson(this.releasesPath(tenantId, useCase), releases);
  }

  private async readPack(
    tenantId: string,
    useCase: string,
    packVersion: string,
  ): Promise<CompiledTenantPack | null> {
    try {
      return compiledTenantPackSchema.parse(
        await readJson<CompiledTenantPack>(this.packPath(tenantId, useCase, packVersion)),
      );
    } catch {
      return null;
    }
  }

  private packDir(tenantId: string, useCase: string): string {
    return join(this.rootDir, tenantId, useCase);
  }

  private packPath(tenantId: string, useCase: string, packVersion: string): string {
    return join(this.packDir(tenantId, useCase), `${packVersion}.json`);
  }

  private activeStatePath(tenantId: string, useCase: string): string {
    return join(this.packDir(tenantId, useCase), 'active.json');
  }

  private releasesPath(tenantId: string, useCase: string): string {
    return join(this.packDir(tenantId, useCase), 'releases.json');
  }

  private now(): string {
    return this.clock().toISOString();
  }
}
