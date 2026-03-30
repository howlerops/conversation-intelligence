import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileTenantAdminConfigRegistry } from '../src';

describe('FileTenantAdminConfigRegistry', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.allSettled(tempDirs.map(async (dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('returns defaults and persists tenant admin config overrides', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ci-tenant-admin-'));
    tempDirs.push(rootDir);

    const registry = new FileTenantAdminConfigRegistry(rootDir, () => new Date('2026-03-28T00:00:00.000Z'));
    await registry.initialize();

    const defaults = await registry.get('tenant_acme', 'support');
    expect(defaults.reviewWorkflow.sla.pendingTargetMinutes).toBe(60);
    expect(defaults.reviewWorkflow.assignment.mode).toBe('MANUAL');
    expect(defaults.canaryAutomation.enabled).toBe(false);

    const updated = await registry.set({
      tenantId: 'tenant_acme',
      useCase: 'support',
      reviewWorkflow: {
        sla: {
          pendingTargetMinutes: 15,
          assignedTargetMinutes: 5,
        },
        assignment: {
          mode: 'AUTO_ASSIGN_SELF',
          requireAssignmentBeforeDecision: true,
        },
      },
      canaryAutomation: {
        enabled: true,
        minimumIntervalMinutes: 10,
        evaluationWindowHours: 24,
        applyResult: true,
      },
    });

    expect(updated.updatedAt).toBe('2026-03-28T00:00:00.000Z');

    const persisted = await registry.get('tenant_acme', 'support');
    expect(persisted.reviewWorkflow.sla.pendingTargetMinutes).toBe(15);
    expect(persisted.reviewWorkflow.assignment.mode).toBe('AUTO_ASSIGN_SELF');
    expect(persisted.canaryAutomation.applyResult).toBe(true);

    const allConfigs = await registry.list();
    expect(allConfigs).toHaveLength(1);
    expect(allConfigs[0].tenantId).toBe('tenant_acme');
  });
});
