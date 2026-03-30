import { mkdir, readdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import {
  buildDefaultTenantAdminConfig,
  TenantAdminConfig,
  TenantAdminConfigDraft,
  tenantAdminConfigSchema,
} from '../contracts';

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

export interface TenantAdminConfigRegistry {
  initialize(): Promise<void>;
  get(tenantId: string, useCase: string): Promise<TenantAdminConfig>;
  set(input: TenantAdminConfigDraft): Promise<TenantAdminConfig>;
  list(): Promise<TenantAdminConfig[]>;
}

export class FileTenantAdminConfigRegistry implements TenantAdminConfigRegistry {
  constructor(
    private readonly rootDir: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async initialize(): Promise<void> {
    await ensureDirectory(this.rootDir);
  }

  async get(tenantId: string, useCase: string): Promise<TenantAdminConfig> {
    const path = this.configPath(tenantId, useCase);

    try {
      return tenantAdminConfigSchema.parse(await readJson<TenantAdminConfig>(path));
    } catch {
      return buildDefaultTenantAdminConfig(tenantId, useCase, this.clock().toISOString());
    }
  }

  async set(input: TenantAdminConfigDraft): Promise<TenantAdminConfig> {
    const parsed = tenantAdminConfigSchema.parse({
      ...input,
      updatedAt: input.updatedAt ?? this.clock().toISOString(),
    });
    await writeJson(this.configPath(parsed.tenantId, parsed.useCase), parsed);
    return parsed;
  }

  async list(): Promise<TenantAdminConfig[]> {
    const tenantEntries = await readdir(this.rootDir, { withFileTypes: true }).catch(() => []);
    const configs: TenantAdminConfig[] = [];

    for (const tenantEntry of tenantEntries) {
      if (!tenantEntry.isDirectory()) {
        continue;
      }

      const tenantDir = join(this.rootDir, tenantEntry.name);
      const scopeEntries = await readdir(tenantDir, { withFileTypes: true }).catch(() => []);

      for (const scopeEntry of scopeEntries) {
        if (!scopeEntry.isFile() || !scopeEntry.name.endsWith('.json')) {
          continue;
        }

        const config = await readJson<TenantAdminConfig>(join(tenantDir, scopeEntry.name));
        configs.push(tenantAdminConfigSchema.parse(config));
      }
    }

    return configs.sort((left, right) => {
      const byTenant = left.tenantId.localeCompare(right.tenantId);
      if (byTenant !== 0) {
        return byTenant;
      }
      return left.useCase.localeCompare(right.useCase);
    });
  }

  private configPath(tenantId: string, useCase: string): string {
    return join(this.rootDir, tenantId, `${useCase}.json`);
  }
}
