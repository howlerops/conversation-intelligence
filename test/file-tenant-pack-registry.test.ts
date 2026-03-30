import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileTenantPackRegistry, TenantPackDraft } from '../src';
import tenantPackFixture from '../fixtures/tenant-pack.support.acme.json';

describe('FileTenantPackRegistry', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.allSettled(tempDirs.map(async (dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('validates, comments on, evaluates, promotes, and rolls back tenant packs', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ci-tenant-packs-'));
    tempDirs.push(rootDir);

    const registry = new FileTenantPackRegistry(rootDir);
    await registry.initialize();

    const tenantPack = tenantPackFixture as TenantPackDraft;

    const preview = await registry.preview(tenantPack);
    expect(preview.valid).toBe(true);
    expect(preview.compiledPack.runtimePack.packVersion).toBe(tenantPack.packVersion);
    expect(preview.compiledPack.digest.supportedEventTypeCount).toBeGreaterThan(0);
    const initialState = await registry.describe(tenantPack.tenantId, tenantPack.useCase ?? 'support');
    expect(initialState.activePack).toBeNull();
    expect(initialState.availableVersions).toEqual([]);

    const publishV1 = await registry.publish({ tenantPack });
    expect(publishV1.activeVersion).toBe(tenantPack.packVersion);
    expect(publishV1.previousVersion).toBeUndefined();
    expect(publishV1.availableVersions).toEqual([tenantPack.packVersion]);
    expect(publishV1.release.status).toBe('ACTIVE');
    expect(publishV1.release.history.map((entry) => entry.kind)).toEqual(expect.arrayContaining([
      'PUBLISHED',
      'ACTIVATED',
    ]));

    const v2Pack = {
      ...tenantPack,
      packVersion: 'support-v2',
      policyDigest: [...(tenantPack.policyDigest ?? []), 'Escalate delayed refund promises.'],
    } satisfies TenantPackDraft;

    const publishV2 = await registry.publish({
      tenantPack: v2Pack,
      release: {
        mode: 'CANARY',
        canaryPercentage: 20,
        note: 'Canary the new refund escalation policy first.',
      },
    });
    expect(publishV2.activeVersion).toBe(tenantPack.packVersion);
    expect(publishV2.release.status).toBe('CANARY');
    expect(publishV2.release.canary?.percentage).toBe(20);
    expect(publishV2.release.history.map((entry) => entry.kind)).toContain('CANARY_STARTED');
    expect(publishV2.availableVersions).toEqual([tenantPack.packVersion, 'support-v2']);

    const commentV2 = await registry.comment({
      tenantId: tenantPack.tenantId,
      useCase: tenantPack.useCase ?? 'support',
      targetPackVersion: 'support-v2',
      comment: 'Watching refund-delay review rate closely.',
    }, {
      actorId: 'pack_admin',
      actorType: 'USER',
    });
    expect(commentV2.release.history.at(-1)?.kind).toBe('COMMENTED');
    expect(commentV2.release.history.at(-1)?.note).toContain('review rate');

    const previewEvaluation = await registry.evaluateCanary({
      tenantId: tenantPack.tenantId,
      useCase: tenantPack.useCase ?? 'support',
      targetPackVersion: 'support-v2',
      metrics: {
        sampleSize: 18,
        failureRate: 0.02,
        reviewRate: 0.12,
        uncertainRate: 0.03,
        averageScore100: 58,
      },
      applyResult: false,
      note: 'Below sample target, hold before automatic promote.',
    }, {
      actorId: 'pack_admin',
      actorType: 'USER',
    });
    expect(previewEvaluation.evaluation.decision).toBe('FAIL');
    expect(previewEvaluation.release.status).toBe('CANARY');
    expect(previewEvaluation.release.canary?.evaluations).toHaveLength(1);

    const failedCanary = await registry.promote({
      tenantId: tenantPack.tenantId,
      useCase: tenantPack.useCase ?? 'support',
      targetPackVersion: 'support-v2',
      result: 'FAIL',
      note: 'Canary regression detected.',
    });
    expect(failedCanary.activeVersion).toBe(tenantPack.packVersion);
    expect(failedCanary.release.status).toBe('REJECTED');
    expect(failedCanary.release.history.map((entry) => entry.kind)).toEqual(expect.arrayContaining([
      'CANARY_EVALUATED',
      'REJECTED',
    ]));

    const v3Pack = {
      ...tenantPack,
      packVersion: 'support-v3',
      policyDigest: [...(tenantPack.policyDigest ?? []), 'Use stronger callback commitment language.'],
    } satisfies TenantPackDraft;

    const publishV3 = await registry.publish({
      tenantPack: v3Pack,
      release: {
        mode: 'APPROVAL_REQUIRED',
        approvalsRequired: 1,
        canaryPercentage: 15,
        note: 'Require approval before canarying v3.',
      },
    });
    expect(publishV3.activeVersion).toBe(tenantPack.packVersion);
    expect(publishV3.release.status).toBe('PENDING_APPROVAL');

    const approvedV3 = await registry.approve({
      tenantId: tenantPack.tenantId,
      useCase: tenantPack.useCase ?? 'support',
      targetPackVersion: 'support-v3',
      note: 'Approved for canary.',
    }, {
      actorId: 'pack_admin',
      actorType: 'USER',
    });
    expect(approvedV3.activeVersion).toBe(tenantPack.packVersion);
    expect(approvedV3.release.status).toBe('CANARY');
    expect(approvedV3.release.approvals).toHaveLength(1);

    const autoEvaluatedV3 = await registry.evaluateCanary({
      tenantId: tenantPack.tenantId,
      useCase: tenantPack.useCase ?? 'support',
      targetPackVersion: 'support-v3',
      metrics: {
        sampleSize: 30,
        failureRate: 0.01,
        reviewRate: 0.1,
        uncertainRate: 0.02,
        averageScore100: 72,
      },
      applyResult: true,
      note: 'Automated canary checks passed.',
    }, {
      actorId: 'pack_admin',
      actorType: 'USER',
    });
    expect(autoEvaluatedV3.evaluation.decision).toBe('PASS');
    expect(autoEvaluatedV3.release.status).toBe('ACTIVE');

    const promotedV3 = autoEvaluatedV3;
    expect(promotedV3.activeVersion).toBe('support-v3');
    expect(promotedV3.previousVersion).toBe(tenantPack.packVersion);

    const activePack = await registry.getActive(tenantPack.tenantId, tenantPack.useCase ?? 'support');
    expect(activePack?.packVersion).toBe('support-v3');
    const activeState = await registry.describe(tenantPack.tenantId, tenantPack.useCase ?? 'support');
    expect(activeState.activeVersion).toBe('support-v3');
    expect(activeState.availableVersions).toEqual([tenantPack.packVersion, 'support-v2', 'support-v3']);
    expect(activeState.releases.map((release) => release.packVersion)).toEqual(expect.arrayContaining([
      tenantPack.packVersion,
      'support-v2',
      'support-v3',
    ]));

    const rollback = await registry.rollback({
      tenantId: tenantPack.tenantId,
      useCase: tenantPack.useCase ?? 'support',
      targetPackVersion: tenantPack.packVersion,
    });
    expect(rollback.activeVersion).toBe(tenantPack.packVersion);
    expect(rollback.previousVersion).toBe('support-v3');
    expect(rollback.availableVersions).toEqual([tenantPack.packVersion, 'support-v2', 'support-v3']);
    expect(rollback.release.history.map((entry) => entry.kind)).toContain('ROLLED_BACK');

    const rolledBackActive = await registry.getActive(tenantPack.tenantId, tenantPack.useCase ?? 'support');
    expect(rolledBackActive?.packVersion).toBe(tenantPack.packVersion);
  });
});
