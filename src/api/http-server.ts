import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { URL } from 'url';
import { ZodError } from 'zod';
import {
  assertTenantAccess,
  HttpAuthError,
  HttpAuthOptions,
  resolveHttpAuthContext,
  tenantScopeFromAuth,
} from '../auth/http-auth';
import { AnalysisRequest, analysisRequestSchema } from '../contracts/jobs';
import {
  reviewAssignmentRequestSchema,
  reviewCommentRequestSchema,
  reviewDecisionRequestSchema,
} from '../contracts/analysis';
import {
  tenantAdminConfigResponseSchema,
  tenantAdminConfigUpdateRequestSchema,
} from '../contracts/admin-config';
import {
  getRegisteredSchemaVersion,
  modelValidationThresholdApplyRequestSchema,
  modelValidationRunRequestSchema,
  modelValidationThresholdRecommendationRequestSchema,
  reviewedRunExportRefreshRequestSchema,
  reviewedRunExportRequestSchema,
  tenantPackAutoEvaluateCanaryRequestSchema,
  tenantPackApproveRequestSchema,
  tenantPackCommentRequestSchema,
  tenantPackEvaluateCanaryRequestSchema,
  tenantPackPublishRequestSchema,
  tenantPackPromoteRequestSchema,
  tenantPackRollbackRequestSchema,
  tenantPackValidateRequestSchema,
} from '../contracts';
import { RunEvent } from '../contracts/runtime';
import { MetricsEndpointProvider } from '../observability/prometheus-runtime-observability';
import { TenantAdminConfigRegistry } from '../admin/file-tenant-admin-config-registry';
import { TenantPackRegistry } from '../packs/file-tenant-pack-registry';
import { ConversationIntelligenceService } from '../service/conversation-intelligence-service';
import { CanaryAutomationService } from '../service/canary-automation-service';
import { ModelValidationService } from '../service/model-validation-service';
import { ReviewedRunExportRefreshService } from '../service/reviewed-run-export-refresh-service';
import { RunConsoleOptions, renderRunConsoleHtml } from '../ui/run-console';
import { SentimentStore, TrendBucket } from '../store/sentiment-store';
import { SentimentCalibrationService } from '../service/sentiment-calibration-service';

export interface ConversationIntelligenceServerUiOptions extends RunConsoleOptions {
  enabled?: boolean;
  path?: string;
}

export interface ConversationIntelligenceServerMetricsOptions {
  exporter: MetricsEndpointProvider;
  path?: string;
}

export interface ConversationIntelligenceServerOptions {
  port?: number;
  clock?: () => Date;
  auth?: HttpAuthOptions;
  ssePollIntervalMs?: number;
  ui?: ConversationIntelligenceServerUiOptions;
  metrics?: ConversationIntelligenceServerMetricsOptions;
  tenantPacks?: TenantPackRegistry;
  tenantAdminConfigs?: TenantAdminConfigRegistry;
  modelValidation?: {
    service: ModelValidationService;
    reviewedExports?: ReviewedRunExportRefreshService;
  };
  sentimentStore?: SentimentStore;
  sentimentCalibration?: SentimentCalibrationService;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body, null, 2));
}

function sendHtml(response: ServerResponse, statusCode: number, body: string): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(body);
}

function sendText(
  response: ServerResponse,
  statusCode: number,
  body: string,
  contentType: string,
): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', contentType);
  response.end(body);
}

function redirect(response: ServerResponse, location: string): void {
  response.statusCode = 302;
  response.setHeader('location', location);
  response.end();
}

function sendSseHeaders(response: ServerResponse): void {
  response.statusCode = 200;
  response.setHeader('content-type', 'text/event-stream; charset=utf-8');
  response.setHeader('cache-control', 'no-cache, no-transform');
  response.setHeader('connection', 'keep-alive');
}

function sendSseEvent(response: ServerResponse, event: RunEvent): void {
  response.write(`id: ${event.eventId}\n`);
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function notFound(response: ServerResponse): void {
  sendJson(response, 404, { error: 'Not found' });
}

function parseJobId(pathname: string): string | null {
  const match = pathname.match(/^\/v1\/jobs\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function parseRunId(pathname: string): string | null {
  const match = pathname.match(/^\/v1\/runs\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function parseRunEventsPath(pathname: string): string | null {
  const match = pathname.match(/^\/v1\/runs\/([^/]+)\/events$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function parseRunStreamPath(pathname: string): string | null {
  const match = pathname.match(/^\/v1\/runs\/([^/]+)\/stream$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function parseRunReviewPath(pathname: string): string | null {
  const match = pathname.match(/^\/v1\/runs\/([^/]+)\/review$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function parseRunCommentsPath(pathname: string): string | null {
  const match = pathname.match(/^\/v1\/runs\/([^/]+)\/comments$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function parseRunAssignmentPath(pathname: string): string | null {
  const match = pathname.match(/^\/v1\/runs\/([^/]+)\/assignment$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function parseRunAuditPath(pathname: string): string | null {
  const match = pathname.match(/^\/v1\/runs\/([^/]+)\/audit$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function parseSchemaPath(pathname: string): string | null {
  const match = pathname.match(/^\/v1\/schema\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function normalizeServerOptions(
  input: number | ConversationIntelligenceServerOptions | undefined,
): ConversationIntelligenceServerOptions {
  if (typeof input === 'number') {
    return { port: input };
  }

  return input ?? {};
}

async function appendAudit(
  service: ConversationIntelligenceService,
  input: {
    tenantId?: string;
    actor: ReturnType<typeof resolveHttpAuthContext>;
    action: Parameters<ConversationIntelligenceService['appendAuditEvent']>[0]['action'];
    resourceType: Parameters<ConversationIntelligenceService['appendAuditEvent']>[0]['resourceType'];
    resourceId?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  if (!input.tenantId) {
    return;
  }

  await service.appendAuditEvent({
    tenantId: input.tenantId,
    actor: input.actor,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    metadata: input.metadata,
  });
}

export function startConversationIntelligenceServer(
  service: ConversationIntelligenceService,
  portOrOptions: number | ConversationIntelligenceServerOptions = 8787,
): Promise<Server> {
  const options = normalizeServerOptions(portOrOptions);
  const uiPath = options.ui?.path ?? '/app';
  const uiEnabled = options.ui?.enabled ?? false;
  const metricsPath = options.metrics?.path ?? '/metrics';
  const canaryAutomation = options.tenantPacks && options.tenantAdminConfigs
    ? new CanaryAutomationService({
      service,
      tenantPacks: options.tenantPacks,
      tenantAdminConfigs: options.tenantAdminConfigs,
      clock: options.clock,
    })
    : null;
  const modelValidation = options.modelValidation?.service ?? null;
  const reviewedExports = options.modelValidation?.reviewedExports ?? null;
  const server = createServer(async (request, response) => {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    try {
      if (method === 'GET' && url.pathname === '/' && uiEnabled) {
        redirect(response, uiPath);
        return;
      }

      if (method === 'GET' && uiEnabled && (url.pathname === uiPath || url.pathname === `${uiPath}/`)) {
        sendHtml(response, 200, renderRunConsoleHtml(options.ui));
        return;
      }

      if (method === 'GET' && options.metrics && url.pathname === metricsPath) {
        sendText(response, 200, options.metrics.exporter.renderMetrics(), options.metrics.exporter.contentType);
        return;
      }

      if (method === 'GET') {
        const schemaVersion = parseSchemaPath(url.pathname);
        if (schemaVersion) {
          const registered = getRegisteredSchemaVersion(schemaVersion);
          if (!registered) {
            notFound(response);
            return;
          }
          const schemaAuthContext = resolveHttpAuthContext(request, options.auth);
          await appendAudit(service, {
            tenantId: tenantScopeFromAuth(schemaAuthContext),
            actor: schemaAuthContext,
            action: 'schema.read',
            resourceType: 'schema',
            resourceId: schemaVersion,
          });
          sendJson(response, 200, registered);
          return;
        }
      }

      if (method === 'GET' && url.pathname === '/healthz') {
        sendJson(response, 200, { status: 'ok' });
        return;
      }

      const authContext = resolveHttpAuthContext(request, options.auth);

      if (method === 'GET' && options.tenantPacks && url.pathname === '/v1/tenant-packs/active') {
        const tenantId = url.searchParams.get('tenantId') ?? tenantScopeFromAuth(authContext);
        const useCase = url.searchParams.get('useCase') ?? 'support';

        if (!tenantId) {
          sendJson(response, 400, { error: 'tenantId is required when auth is not tenant-scoped.' });
          return;
        }

        assertTenantAccess(authContext, tenantId);
        const state = await options.tenantPacks.describe(tenantId, useCase);
        await appendAudit(service, {
          tenantId,
          actor: authContext,
          action: 'tenant_pack.read',
          resourceType: 'tenant_pack',
          resourceId: state.activeVersion,
          metadata: {
            useCase,
            availableVersionCount: state.availableVersions.length,
          },
        });
        sendJson(response, 200, state);
        return;
      }

      if (method === 'GET' && options.tenantAdminConfigs && url.pathname === '/v1/tenant-admin/config') {
        const tenantId = url.searchParams.get('tenantId') ?? tenantScopeFromAuth(authContext);
        const useCase = url.searchParams.get('useCase') ?? 'support';

        if (!tenantId) {
          sendJson(response, 400, { error: 'tenantId is required when auth is not tenant-scoped.' });
          return;
        }

        assertTenantAccess(authContext, tenantId);
        const config = await options.tenantAdminConfigs.get(tenantId, useCase);
        await appendAudit(service, {
          tenantId,
          actor: authContext,
          action: 'tenant_admin.read',
          resourceType: 'tenant_admin',
          resourceId: useCase,
        });
        sendJson(response, 200, tenantAdminConfigResponseSchema.parse({ config }));
        return;
      }

      if (method === 'GET' && modelValidation && url.pathname === '/v1/model-validation/reports') {
        const tenantId = url.searchParams.get('tenantId') ?? tenantScopeFromAuth(authContext);
        const useCase = url.searchParams.get('useCase') ?? undefined;
        const packVersion = url.searchParams.get('packVersion') ?? undefined;

        if (!tenantId) {
          sendJson(response, 400, { error: 'tenantId is required when auth is not tenant-scoped.' });
          return;
        }

        assertTenantAccess(authContext, tenantId);
        const reports = await modelValidation.listReports({
          tenantId,
          useCase,
          packVersion,
        });
        await appendAudit(service, {
          tenantId,
          actor: authContext,
          action: 'model_validation.read',
          resourceType: 'model_validation',
          resourceId: packVersion ?? useCase,
        });
        sendJson(response, 200, reports);
        return;
      }

      if (method === 'GET' && modelValidation && url.pathname === '/v1/model-validation/reviewed-datasets') {
        const tenantId = url.searchParams.get('tenantId') ?? tenantScopeFromAuth(authContext);
        const useCase = url.searchParams.get('useCase') ?? undefined;

        if (!tenantId) {
          sendJson(response, 400, { error: 'tenantId is required when auth is not tenant-scoped.' });
          return;
        }

        assertTenantAccess(authContext, tenantId);
        const datasets = await modelValidation.listReviewedDatasets({
          tenantId,
          useCase,
        });
        await appendAudit(service, {
          tenantId,
          actor: authContext,
          action: 'model_validation.read',
          resourceType: 'model_validation',
          resourceId: useCase ?? 'reviewed_datasets',
          metadata: {
            reviewedDatasets: true,
          },
        });
        sendJson(response, 200, datasets);
        return;
      }

      if (method === 'GET' && modelValidation && url.pathname === '/v1/model-validation/recommend-thresholds') {
        const parsed = modelValidationThresholdRecommendationRequestSchema.parse({
          tenantId: url.searchParams.get('tenantId') ?? tenantScopeFromAuth(authContext) ?? undefined,
          useCase: url.searchParams.get('useCase') ?? undefined,
          packVersion: url.searchParams.get('packVersion') ?? undefined,
        });

        if (!parsed.tenantId || !parsed.useCase) {
          sendJson(response, 400, { error: 'tenantId and useCase are required for threshold recommendations.' });
          return;
        }

        assertTenantAccess(authContext, parsed.tenantId);
        const recommendation = await modelValidation.recommendThresholds(parsed);
        await appendAudit(service, {
          tenantId: parsed.tenantId,
          actor: authContext,
          action: 'model_validation.read',
          resourceType: 'model_validation',
          resourceId: parsed.packVersion ?? parsed.useCase,
          metadata: {
            recommendation: true,
          },
        });
        sendJson(response, 200, recommendation);
        return;
      }

      if (method === 'GET' && modelValidation && url.pathname === '/v1/model-validation/alerts') {
        const tenantId = url.searchParams.get('tenantId') ?? tenantScopeFromAuth(authContext);
        const useCase = url.searchParams.get('useCase') ?? undefined;
        const packVersion = url.searchParams.get('packVersion') ?? undefined;

        if (!tenantId) {
          sendJson(response, 400, { error: 'tenantId is required when auth is not tenant-scoped.' });
          return;
        }

        assertTenantAccess(authContext, tenantId);
        const alerts = await modelValidation.listAlerts({
          tenantId,
          useCase,
          packVersion,
        });
        await appendAudit(service, {
          tenantId,
          actor: authContext,
          action: 'model_validation.alerts.read',
          resourceType: 'model_validation',
          resourceId: packVersion ?? useCase,
        });
        sendJson(response, 200, alerts);
        return;
      }

      if (method === 'POST' && url.pathname === '/v1/analyze') {
        const body = analysisRequestSchema.parse(await readJsonBody(request)) as AnalysisRequest;
        assertTenantAccess(authContext, body.transcript.tenantId);
        const result = await service.analyzeNow(body);
        await appendAudit(service, {
          tenantId: body.transcript.tenantId,
          actor: authContext,
          action: 'analysis.requested',
          resourceType: 'analysis',
          resourceId: body.transcript.conversationId,
          metadata: {
            useCase: body.transcript.useCase,
          },
        });
        sendJson(response, 200, result);
        return;
      }

      if (method === 'POST' && (url.pathname === '/v1/jobs' || url.pathname === '/v1/runs')) {
        const body = analysisRequestSchema.parse(await readJsonBody(request)) as AnalysisRequest;
        assertTenantAccess(authContext, body.transcript.tenantId);
        const job = await service.submitJob(body);
        await appendAudit(service, {
          tenantId: job.tenantId,
          actor: authContext,
          action: 'run.created',
          resourceType: 'run',
          resourceId: job.jobId,
          metadata: {
            conversationId: job.conversationId ?? '',
            useCase: job.useCase,
          },
        });
        sendJson(response, 202, job);
        return;
      }

      if (method === 'POST') {
        if (reviewedExports && url.pathname === '/v1/model-validation/refresh-reviewed-exports') {
          const body = reviewedRunExportRefreshRequestSchema.parse(await readJsonBody(request));
          const tenantId = body.tenantId ?? tenantScopeFromAuth(authContext);

          if (tenantId) {
            assertTenantAccess(authContext, tenantId);
          }

          const result = await reviewedExports.refreshConfiguredExports({
            ...body,
            tenantId,
          });
          await appendAudit(service, {
            tenantId,
            actor: authContext,
            action: 'model_validation.exports.refreshed',
            resourceType: 'model_validation',
            resourceId: body.useCase,
            metadata: {
              refreshedCount: result.results.length,
              skippedCount: result.skipped.length,
              force: body.force,
            },
          });
          sendJson(response, 200, result);
          return;
        }

        if (modelValidation && url.pathname === '/v1/model-validation/export-reviewed-runs') {
          const body = reviewedRunExportRequestSchema.parse(await readJsonBody(request));
          const tenantId = body.tenantId ?? tenantScopeFromAuth(authContext);

          if (!tenantId) {
            sendJson(response, 400, { error: 'tenantId is required when auth is not tenant-scoped.' });
            return;
          }

          assertTenantAccess(authContext, tenantId);
          const result = await modelValidation.exportReviewedRuns({
            ...body,
            tenantId,
          });
          await appendAudit(service, {
            tenantId,
            actor: authContext,
            action: 'model_validation.exported',
            resourceType: 'model_validation',
            metadata: {
              exportedCount: result.response.exportedCount,
              skippedCount: result.response.skippedCount,
              useCase: body.useCase ?? '',
              packVersion: body.packVersion ?? '',
            },
          });
          sendText(response, 200, result.ndjson, 'application/x-ndjson; charset=utf-8');
          return;
        }

        if (modelValidation && url.pathname === '/v1/model-validation/apply-recommended-thresholds') {
          const body = modelValidationThresholdApplyRequestSchema.parse(await readJsonBody(request));
          const tenantId = body.tenantId ?? tenantScopeFromAuth(authContext);

          if (!tenantId || !body.useCase) {
            sendJson(response, 400, { error: 'tenantId and useCase are required when applying validation thresholds.' });
            return;
          }

          assertTenantAccess(authContext, tenantId);
          const result = await modelValidation.applyRecommendedThresholds({
            ...body,
            tenantId,
          });
          await appendAudit(service, {
            tenantId,
            actor: authContext,
            action: 'tenant_admin.updated',
            resourceType: 'tenant_admin',
            resourceId: body.useCase,
            metadata: {
              validationThresholdsApplied: result.applied,
              packVersion: result.packVersion ?? '',
              nightlyIntervalMinutes: result.validationMonitoring.minimumIntervalMinutes,
            },
          });
          sendJson(response, 200, result);
          return;
        }

        if (modelValidation && url.pathname === '/v1/model-validation/run') {
          const body = modelValidationRunRequestSchema.parse(await readJsonBody(request));
          const tenantId = body.tenantId ?? tenantScopeFromAuth(authContext);

          if (tenantId) {
            assertTenantAccess(authContext, tenantId);
          }

          const result = await modelValidation.runConfiguredValidations({
            ...body,
            tenantId,
          });
          await appendAudit(service, {
            tenantId,
            actor: authContext,
            action: 'model_validation.run',
            resourceType: 'model_validation',
            resourceId: body.useCase,
            metadata: {
              reportCount: result.reports.length,
              skippedCount: result.skipped.length,
              force: body.force,
            },
          });
          sendJson(response, 200, result);
          return;
        }

        if (options.tenantPacks && url.pathname === '/v1/tenant-packs/validate') {
          const body = tenantPackValidateRequestSchema.parse(await readJsonBody(request));
          assertTenantAccess(authContext, body.tenantPack.tenantId);
          const result = await options.tenantPacks.validate(body.tenantPack);
          await appendAudit(service, {
            tenantId: body.tenantPack.tenantId,
            actor: authContext,
            action: 'tenant_pack.validated',
            resourceType: 'tenant_pack',
            resourceId: body.tenantPack.packVersion,
            metadata: {
              useCase: body.tenantPack.useCase,
            },
          });
          sendJson(response, 200, result);
          return;
        }

        if (options.tenantPacks && url.pathname === '/v1/tenant-packs/preview') {
          const body = tenantPackValidateRequestSchema.parse(await readJsonBody(request));
          assertTenantAccess(authContext, body.tenantPack.tenantId);
          const result = await options.tenantPacks.preview(body.tenantPack);
          await appendAudit(service, {
            tenantId: body.tenantPack.tenantId,
            actor: authContext,
            action: 'tenant_pack.previewed',
            resourceType: 'tenant_pack',
            resourceId: body.tenantPack.packVersion,
            metadata: {
              useCase: body.tenantPack.useCase,
            },
          });
          sendJson(response, 200, result);
          return;
        }

        if (options.tenantPacks && url.pathname === '/v1/tenant-packs/publish') {
          const body = tenantPackPublishRequestSchema.parse(await readJsonBody(request));
          assertTenantAccess(authContext, body.tenantPack.tenantId);
          const result = await options.tenantPacks.publish(body, {
            actorId: authContext.principalId,
            actorType: authContext.principalType,
          });
          await appendAudit(service, {
            tenantId: body.tenantPack.tenantId,
            actor: authContext,
            action: 'tenant_pack.published',
            resourceType: 'tenant_pack',
            resourceId: body.tenantPack.packVersion,
            metadata: {
              useCase: body.tenantPack.useCase,
            },
          });
          sendJson(response, 200, result);
          return;
        }

        if (options.tenantPacks && url.pathname === '/v1/tenant-packs/approve') {
          const body = tenantPackApproveRequestSchema.parse(await readJsonBody(request));
          assertTenantAccess(authContext, body.tenantId);
          const result = await options.tenantPacks.approve(body, {
            actorId: authContext.principalId,
            actorType: authContext.principalType,
          });
          await appendAudit(service, {
            tenantId: body.tenantId,
            actor: authContext,
            action: 'tenant_pack.approved',
            resourceType: 'tenant_pack',
            resourceId: body.targetPackVersion,
            metadata: {
              useCase: body.useCase,
              approvals: result.release.approvals.length,
              status: result.release.status,
            },
          });
          sendJson(response, 200, result);
          return;
        }

        if (options.tenantPacks && url.pathname === '/v1/tenant-packs/comment') {
          const body = tenantPackCommentRequestSchema.parse(await readJsonBody(request));
          assertTenantAccess(authContext, body.tenantId);
          const result = await options.tenantPacks.comment(body, {
            actorId: authContext.principalId,
            actorType: authContext.principalType,
          });
          await appendAudit(service, {
            tenantId: body.tenantId,
            actor: authContext,
            action: 'tenant_pack.commented',
            resourceType: 'tenant_pack',
            resourceId: body.targetPackVersion,
            metadata: {
              useCase: body.useCase,
              commentLength: body.comment.length,
            },
          });
          sendJson(response, 200, result);
          return;
        }

        if (options.tenantPacks && url.pathname === '/v1/tenant-packs/evaluate-canary') {
          const body = tenantPackEvaluateCanaryRequestSchema.parse(await readJsonBody(request));
          assertTenantAccess(authContext, body.tenantId);
          const result = await options.tenantPacks.evaluateCanary(body, {
            actorId: authContext.principalId,
            actorType: authContext.principalType,
          });
          await appendAudit(service, {
            tenantId: body.tenantId,
            actor: authContext,
            action: 'tenant_pack.canary_evaluated',
            resourceType: 'tenant_pack',
            resourceId: body.targetPackVersion,
            metadata: {
              useCase: body.useCase,
              decision: result.evaluation.decision,
              applyResult: body.applyResult,
              blockingReasons: result.evaluation.blockingReasons,
            },
          });
          sendJson(response, 200, result);
          return;
        }

        if (canaryAutomation && url.pathname === '/v1/tenant-packs/auto-evaluate-canary') {
          const body = tenantPackAutoEvaluateCanaryRequestSchema.parse(await readJsonBody(request));
          assertTenantAccess(authContext, body.tenantId);
          const result = await canaryAutomation.evaluateScope(body);
          await appendAudit(service, {
            tenantId: body.tenantId,
            actor: authContext,
            action: 'tenant_pack.canary_auto_evaluated',
            resourceType: 'tenant_pack',
            resourceId: body.targetPackVersion,
            metadata: {
              useCase: body.useCase,
              attempted: result.attempted,
              skippedReason: result.skippedReason ?? '',
              decision: result.result?.evaluation.decision ?? '',
            },
          });
          sendJson(response, 200, result);
          return;
        }

        if (options.tenantPacks && url.pathname === '/v1/tenant-packs/promote') {
          const body = tenantPackPromoteRequestSchema.parse(await readJsonBody(request));
          assertTenantAccess(authContext, body.tenantId);
          const result = await options.tenantPacks.promote(body, {
            actorId: authContext.principalId,
            actorType: authContext.principalType,
          });
          await appendAudit(service, {
            tenantId: body.tenantId,
            actor: authContext,
            action: 'tenant_pack.promoted',
            resourceType: 'tenant_pack',
            resourceId: body.targetPackVersion,
            metadata: {
              useCase: body.useCase,
              result: body.result,
              status: result.release.status,
            },
          });
          sendJson(response, 200, result);
          return;
        }

        if (options.tenantPacks && url.pathname === '/v1/tenant-packs/rollback') {
          const body = tenantPackRollbackRequestSchema.parse(await readJsonBody(request));
          assertTenantAccess(authContext, body.tenantId);
          const result = await options.tenantPacks.rollback(body, {
            actorId: authContext.principalId,
            actorType: authContext.principalType,
          });
          await appendAudit(service, {
            tenantId: body.tenantId,
            actor: authContext,
            action: 'tenant_pack.rolled_back',
            resourceType: 'tenant_pack',
            resourceId: body.targetPackVersion,
            metadata: {
              useCase: body.useCase,
            },
          });
          sendJson(response, 200, result);
          return;
        }

        const runAssignmentId = parseRunAssignmentPath(url.pathname);

        if (runAssignmentId) {
          const run = await service.getJob(runAssignmentId);
          if (!run) {
            notFound(response);
            return;
          }

          if (run.status !== 'COMPLETED' || !run.result) {
            sendJson(response, 409, { error: `Run ${run.jobId} is not ready for analyst assignment.` });
            return;
          }

          assertTenantAccess(authContext, run.tenantId);
          const body = reviewAssignmentRequestSchema.parse(await readJsonBody(request));
          const updated = await service.recordReviewAssignment(run.jobId, body, authContext);
          await appendAudit(service, {
            tenantId: run.tenantId,
            actor: authContext,
            action: 'run.assignment.updated',
            resourceType: 'review',
            resourceId: run.jobId,
            metadata: {
              note: body.note ?? '',
            },
          });
          sendJson(response, 200, updated);
          return;
        }

        const runCommentsId = parseRunCommentsPath(url.pathname);

        if (runCommentsId) {
          const run = await service.getJob(runCommentsId);
          if (!run) {
            notFound(response);
            return;
          }

          if (run.status !== 'COMPLETED' || !run.result) {
            sendJson(response, 409, { error: `Run ${run.jobId} is not ready for analyst comments.` });
            return;
          }

          assertTenantAccess(authContext, run.tenantId);
          const body = reviewCommentRequestSchema.parse(await readJsonBody(request));
          const updated = await service.recordReviewComment(run.jobId, body, authContext);
          await appendAudit(service, {
            tenantId: run.tenantId,
            actor: authContext,
            action: 'run.comment.added',
            resourceType: 'review',
            resourceId: run.jobId,
            metadata: {
              commentLength: body.comment.length,
            },
          });
          sendJson(response, 200, updated);
          return;
        }

        const runReviewId = parseRunReviewPath(url.pathname);

        if (runReviewId) {
          const run = await service.getJob(runReviewId);
          if (!run) {
            notFound(response);
            return;
          }

          if (run.status !== 'COMPLETED' || !run.result) {
            sendJson(response, 409, { error: `Run ${run.jobId} is not ready for analyst review.` });
            return;
          }

          assertTenantAccess(authContext, run.tenantId);
          const body = reviewDecisionRequestSchema.parse(await readJsonBody(request));
          const updated = await service.recordReviewDecision(run.jobId, body, authContext);
          await appendAudit(service, {
            tenantId: run.tenantId,
            actor: authContext,
            action: 'run.review.updated',
            resourceType: 'review',
            resourceId: run.jobId,
            metadata: {
              decision: body.decision,
              note: body.note ?? '',
            },
          });
          sendJson(response, 200, updated);
          return;
        }
      }

      if (method === 'PUT' && options.tenantAdminConfigs && url.pathname === '/v1/tenant-admin/config') {
        const body = tenantAdminConfigUpdateRequestSchema.parse(await readJsonBody(request));
        assertTenantAccess(authContext, body.config.tenantId);
        const config = await options.tenantAdminConfigs.set(body.config);
        await appendAudit(service, {
          tenantId: config.tenantId,
          actor: authContext,
          action: 'tenant_admin.updated',
          resourceType: 'tenant_admin',
          resourceId: config.useCase,
          metadata: {
            useCase: config.useCase,
          },
        });
        sendJson(response, 200, tenantAdminConfigResponseSchema.parse({ config }));
        return;
      }

      if (method === 'GET' && url.pathname === '/v1/jobs') {
        const tenantId = tenantScopeFromAuth(authContext);
        const jobs = await service.listJobs(tenantId);
        await appendAudit(service, {
          tenantId,
          actor: authContext,
          action: 'run.list',
          resourceType: 'run',
          metadata: {
            count: jobs.length,
          },
        });
        sendJson(response, 200, { jobs });
        return;
      }

      if (method === 'GET' && url.pathname === '/v1/runs') {
        const tenantId = tenantScopeFromAuth(authContext);
        const runs = await service.listJobs(tenantId);
        await appendAudit(service, {
          tenantId,
          actor: authContext,
          action: 'run.list',
          resourceType: 'run',
          metadata: {
            count: runs.length,
          },
        });
        sendJson(response, 200, { runs });
        return;
      }

      if (method === 'GET' && url.pathname === '/v1/review-queue') {
        const tenantId = tenantScopeFromAuth(authContext);
        const snapshot = await service.listReviewQueue(tenantId);
        await appendAudit(service, {
          tenantId,
          actor: authContext,
          action: 'review_queue.read',
          resourceType: 'review_queue',
          metadata: {
            count: snapshot.items.length,
          },
        });
        sendJson(response, 200, snapshot);
        return;
      }

      if (method === 'GET' && url.pathname === '/v1/review-analytics') {
        const tenantId = tenantScopeFromAuth(authContext);
        const snapshot = await service.getReviewAnalytics(tenantId);
        await appendAudit(service, {
          tenantId,
          actor: authContext,
          action: 'review_analytics.read',
          resourceType: 'review_queue',
          metadata: {
            pendingCount: snapshot.pendingCount,
            assignedCount: snapshot.assignedCount,
          },
        });
        sendJson(response, 200, snapshot);
        return;
      }

      if (method === 'GET') {
        const runStreamId = parseRunStreamPath(url.pathname);

        if (runStreamId) {
          const run = await service.getJob(runStreamId);
          if (!run) {
            notFound(response);
            return;
          }

          assertTenantAccess(authContext, run.tenantId);
          await appendAudit(service, {
            tenantId: run.tenantId,
            actor: authContext,
            action: 'run.stream.opened',
            resourceType: 'run_event_stream',
            resourceId: run.jobId,
          });

          sendSseHeaders(response);
          response.write(': connected\n\n');

          const sentEventIds = new Set<string>();
          let stopped = false;

          const flushEvents = async (): Promise<void> => {
            if (stopped) {
              return;
            }

            const snapshot = await service.listRunEvents(run.jobId);
            for (const event of snapshot.events) {
              if (sentEventIds.has(event.eventId)) {
                continue;
              }

              sendSseEvent(response, event);
              sentEventIds.add(event.eventId);
            }
          };

          await flushEvents();

          const interval = setInterval(() => {
            void flushEvents().catch((error) => {
              response.write(`event: error\ndata: ${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n\n`);
            });
          }, options.ssePollIntervalMs ?? 100);

          request.on('close', () => {
            stopped = true;
            clearInterval(interval);
            response.end();
          });
          return;
        }

        const runEventsId = parseRunEventsPath(url.pathname);
        if (runEventsId) {
          const run = await service.getJob(runEventsId);
          if (!run) {
            notFound(response);
            return;
          }

          assertTenantAccess(authContext, run.tenantId);
          const snapshot = await service.listRunEvents(run.jobId);
          await appendAudit(service, {
            tenantId: run.tenantId,
            actor: authContext,
            action: 'run.events.read',
            resourceType: 'run',
            resourceId: run.jobId,
            metadata: {
              count: snapshot.events.length,
            },
          });
          sendJson(response, 200, snapshot);
          return;
        }

        const runAuditId = parseRunAuditPath(url.pathname);
        if (runAuditId) {
          const run = await service.getJob(runAuditId);
          if (!run) {
            notFound(response);
            return;
          }

          assertTenantAccess(authContext, run.tenantId);
          const snapshot = await service.listAuditEvents(run.tenantId, run.jobId);
          await appendAudit(service, {
            tenantId: run.tenantId,
            actor: authContext,
            action: 'run.audit.read',
            resourceType: 'run',
            resourceId: run.jobId,
            metadata: {
              count: snapshot.items.length,
            },
          });
          sendJson(response, 200, snapshot);
          return;
        }

        const runId = parseRunId(url.pathname);
        if (runId) {
          const run = await service.getJob(runId);
          if (!run) {
            notFound(response);
            return;
          }

          assertTenantAccess(authContext, run.tenantId);
          await appendAudit(service, {
            tenantId: run.tenantId,
            actor: authContext,
            action: 'run.read',
            resourceType: 'run',
            resourceId: run.jobId,
          });
          sendJson(response, 200, run);
          return;
        }

        const jobId = parseJobId(url.pathname);
        if (jobId) {
          const job = await service.getJob(jobId);
          if (!job) {
            notFound(response);
            return;
          }

          assertTenantAccess(authContext, job.tenantId);
          await appendAudit(service, {
            tenantId: job.tenantId,
            actor: authContext,
            action: 'run.read',
            resourceType: 'run',
            resourceId: job.jobId,
          });
          sendJson(response, 200, job);
          return;
        }
      }

      // -----------------------------------------------------------------------
      // Sentiment store routes — /v1/sentiment/*
      // -----------------------------------------------------------------------
      if (options.sentimentStore && url.pathname.startsWith('/v1/sentiment/')) {
        const authContext = resolveHttpAuthContext(request, options.auth);
        const sentimentStore = options.sentimentStore;
        const calibration = options.sentimentCalibration;

        const resolveTenantId = (params: URLSearchParams): string => {
          const tid = params.get('tenantId') ?? tenantScopeFromAuth(authContext);
          if (!tid) throw new HttpAuthError(400, 'tenantId query parameter is required');
          return tid;
        };

        if (method === 'GET' && url.pathname === '/v1/sentiment/analyses') {
          const tenantId = resolveTenantId(url.searchParams);
          assertTenantAccess(authContext, tenantId);
          const results = await sentimentStore.listSentimentAnalyses({
            tenantId,
            polarity: url.searchParams.get('polarity') ?? undefined,
            minScore100: url.searchParams.has('minScore100') ? Number(url.searchParams.get('minScore100')) : undefined,
            maxScore100: url.searchParams.has('maxScore100') ? Number(url.searchParams.get('maxScore100')) : undefined,
            limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
            offset: url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : undefined,
          });
          sendJson(response, 200, { items: results, count: results.length });
          return;
        }

        const analysisJobId = url.pathname.match(/^\/v1\/sentiment\/analyses\/([^/]+)$/)?.[1];
        if (method === 'GET' && analysisJobId) {
          const record = await sentimentStore.getSentimentAnalysis(decodeURIComponent(analysisJobId));
          if (!record) { notFound(response); return; }
          assertTenantAccess(authContext, record.tenantId);
          sendJson(response, 200, record);
          return;
        }

        if (method === 'GET' && url.pathname === '/v1/sentiment/trend') {
          const tenantId = resolveTenantId(url.searchParams);
          assertTenantAccess(authContext, tenantId);
          const bucket = (url.searchParams.get('bucket') ?? 'day') as TrendBucket;
          const days = Number(url.searchParams.get('days') ?? '30');
          const trend = await sentimentStore.getSentimentTrend(tenantId, bucket, days);
          sendJson(response, 200, { tenantId, bucket, days, points: trend });
          return;
        }

        if (method === 'GET' && url.pathname === '/v1/sentiment/segments/search') {
          const tenantId = resolveTenantId(url.searchParams);
          assertTenantAccess(authContext, tenantId);
          const q = url.searchParams.get('q') ?? '';
          if (!q) { sendJson(response, 400, { error: 'Query parameter "q" is required' }); return; }
          const limit = Math.min(Number(url.searchParams.get('limit') ?? '50'), 200);
          const results = await sentimentStore.searchSegmentsByPhrase(tenantId, q, limit);
          sendJson(response, 200, { tenantId, query: q, items: results, count: results.length });
          return;
        }

        if (method === 'GET' && url.pathname === '/v1/sentiment/key-moments') {
          const tenantId = resolveTenantId(url.searchParams);
          assertTenantAccess(authContext, tenantId);
          const moments = await sentimentStore.listKeyMoments({
            tenantId,
            type: url.searchParams.get('type') ?? undefined,
            businessImpact: url.searchParams.get('impact') ?? undefined,
            limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
          });
          sendJson(response, 200, { items: moments, count: moments.length });
          return;
        }

        if (method === 'GET' && url.pathname === '/v1/sentiment/calibration' && calibration) {
          const tenantId = resolveTenantId(url.searchParams);
          assertTenantAccess(authContext, tenantId);
          const result = await calibration.analyzeCalibration(tenantId, {
            useCase: url.searchParams.get('useCase') ?? undefined,
            windowDays: url.searchParams.has('windowDays') ? Number(url.searchParams.get('windowDays')) : undefined,
          });
          sendJson(response, 200, result);
          return;
        }

        if (method === 'GET' && url.pathname === '/v1/sentiment/calibration/drift' && calibration) {
          const tenantId = resolveTenantId(url.searchParams);
          assertTenantAccess(authContext, tenantId);
          const result = await calibration.detectDrift(tenantId, {
            baselineDays: url.searchParams.has('baselineDays') ? Number(url.searchParams.get('baselineDays')) : undefined,
            recentDays: url.searchParams.has('recentDays') ? Number(url.searchParams.get('recentDays')) : undefined,
          });
          sendJson(response, 200, result);
          return;
        }

        if (method === 'GET' && url.pathname === '/v1/sentiment/calibration/recommend' && calibration) {
          const tenantId = resolveTenantId(url.searchParams);
          assertTenantAccess(authContext, tenantId);
          const result = await calibration.recommendCalibrationOffset(tenantId, {
            useCase: url.searchParams.get('useCase') ?? undefined,
            engagementType: url.searchParams.get('engagementType') ?? undefined,
          });
          sendJson(response, 200, result);
          return;
        }

        if (method === 'GET' && url.pathname === '/v1/sentiment/calibration/convergence' && calibration) {
          const tenantId = resolveTenantId(url.searchParams);
          assertTenantAccess(authContext, tenantId);
          const result = await calibration.trackCalibrationConvergence(tenantId, {
            windowDays: url.searchParams.has('windowDays') ? Number(url.searchParams.get('windowDays')) : undefined,
            totalDays: url.searchParams.has('totalDays') ? Number(url.searchParams.get('totalDays')) : undefined,
          });
          sendJson(response, 200, result);
          return;
        }
      }

      notFound(response);
    } catch (error) {
      if (error instanceof HttpAuthError) {
        sendJson(response, error.statusCode, { error: error.message });
        return;
      }

      if (error instanceof ZodError) {
        sendJson(response, 400, {
          error: 'Invalid request',
          issues: error.issues,
        });
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { error: message });
    }
  });

  return new Promise((resolve) => {
    server.listen(options.port ?? 8787, () => resolve(server));
  });
}
