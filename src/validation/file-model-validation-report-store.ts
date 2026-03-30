import { mkdir, readdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import {
  ModelValidationAlert,
  ModelValidationReport,
  modelValidationAlertSchema,
  modelValidationReportSchema,
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

export interface ModelValidationReportFilters {
  tenantId?: string;
  useCase?: string;
  packVersion?: string;
}

export interface ModelValidationReportStore {
  initialize(): Promise<void>;
  saveReport(report: ModelValidationReport): Promise<ModelValidationReport>;
  listReports(filters?: ModelValidationReportFilters): Promise<ModelValidationReport[]>;
  getLatestReport(filters: ModelValidationReportFilters): Promise<ModelValidationReport | null>;
  listAlerts(filters?: ModelValidationReportFilters): Promise<ModelValidationAlert[]>;
}

export class FileModelValidationReportStore implements ModelValidationReportStore {
  constructor(private readonly rootDir: string) {}

  async initialize(): Promise<void> {
    await ensureDirectory(this.rootDir);
  }

  async saveReport(report: ModelValidationReport): Promise<ModelValidationReport> {
    const parsed = modelValidationReportSchema.parse(report);
    await writeJson(this.reportPath(parsed), parsed);
    return parsed;
  }

  async listReports(filters: ModelValidationReportFilters = {}): Promise<ModelValidationReport[]> {
    const reportPaths = await this.collectJsonFiles(this.rootDir);
    const reports = await Promise.all(reportPaths.map(async (path) => modelValidationReportSchema.parse(await readJson<ModelValidationReport>(path))));

    return reports
      .filter((report) => this.matchesFilters(report, filters))
      .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt));
  }

  async getLatestReport(filters: ModelValidationReportFilters): Promise<ModelValidationReport | null> {
    const reports = await this.listReports(filters);
    return reports[0] ?? null;
  }

  async listAlerts(filters: ModelValidationReportFilters = {}): Promise<ModelValidationAlert[]> {
    const reports = await this.listReports(filters);
    return reports
      .flatMap((report) => report.alerts)
      .map((alert) => modelValidationAlertSchema.parse(alert))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  private reportPath(report: ModelValidationReport): string {
    const packVersion = report.packVersion ?? '_all';
    return join(this.rootDir, report.tenantId, report.useCase, packVersion, `${report.reportId}.json`);
  }

  private matchesFilters(report: ModelValidationReport, filters: ModelValidationReportFilters): boolean {
    if (filters.tenantId && report.tenantId !== filters.tenantId) {
      return false;
    }
    if (filters.useCase && report.useCase !== filters.useCase) {
      return false;
    }
    if (filters.packVersion && report.packVersion !== filters.packVersion) {
      return false;
    }
    return true;
  }

  private async collectJsonFiles(rootDir: string): Promise<string[]> {
    const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
    const files: string[] = [];

    for (const entry of entries) {
      const path = join(rootDir, entry.name);
      if (entry.isDirectory()) {
        files.push(...await this.collectJsonFiles(path));
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.json')) {
        files.push(path);
      }
    }

    return files;
  }
}
