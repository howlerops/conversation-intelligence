import { z } from 'zod';

const looseMetadataSchema = z.record(z.string(), z.unknown()).default({});

export const authModeSchema = z.enum(['none', 'api_key', 'trusted_proxy']);
export type AuthMode = z.infer<typeof authModeSchema>;

export const principalTypeSchema = z.enum(['ANONYMOUS', 'USER', 'SERVICE', 'API_KEY', 'SYSTEM']);
export type PrincipalType = z.infer<typeof principalTypeSchema>;

export const authContextSchema = z.object({
  authMode: authModeSchema,
  principalId: z.string().min(1),
  principalType: principalTypeSchema,
  tenantId: z.string().min(1).optional(),
  scopes: z.array(z.string()).default([]),
});

export type AuthContext = z.infer<typeof authContextSchema>;

export const runEventTypeSchema = z.enum([
  'RUN_CREATED',
  'PII_MASKED',
  'RUN_CLAIMED',
  'LLM_STARTED',
  'LLM_COMPLETED',
  'REVIEW_REQUIRED',
  'ANALYST_ASSIGNED',
  'ANALYST_COMMENT_ADDED',
  'ANALYST_REVIEW_RECORDED',
  'RUN_COMPLETED',
  'RUN_FAILED',
]);

export type RunEventType = z.infer<typeof runEventTypeSchema>;

export const runEventSchema = z.object({
  eventId: z.string().min(1),
  runId: z.string().min(1),
  tenantId: z.string().min(1),
  type: runEventTypeSchema,
  createdAt: z.string().min(1),
  summary: z.string().min(1),
  actor: authContextSchema.optional(),
  metadata: looseMetadataSchema,
});

export type RunEvent = z.infer<typeof runEventSchema>;

export const auditResourceTypeSchema = z.enum([
  'analysis',
  'run',
  'review',
  'tenant_admin',
  'tenant_pack',
  'model_validation',
  'schema',
  'run_event_stream',
  'review_queue',
]);

export type AuditResourceType = z.infer<typeof auditResourceTypeSchema>;

export const auditActionSchema = z.enum([
  'analysis.requested',
  'schema.read',
  'tenant_admin.read',
  'tenant_admin.updated',
  'tenant_pack.read',
  'tenant_pack.validated',
  'tenant_pack.previewed',
  'tenant_pack.published',
  'tenant_pack.approved',
  'tenant_pack.commented',
  'tenant_pack.canary_auto_evaluated',
  'tenant_pack.canary_evaluated',
  'tenant_pack.promoted',
  'tenant_pack.rolled_back',
  'model_validation.exported',
  'model_validation.exports.refreshed',
  'model_validation.run',
  'model_validation.read',
  'model_validation.alerts.read',
  'run.created',
  'run.read',
  'run.audit.read',
  'run.assignment.updated',
  'run.comment.added',
  'run.review.updated',
  'run.list',
  'run.events.read',
  'run.stream.opened',
  'review_analytics.read',
  'review_queue.read',
]);

export type AuditAction = z.infer<typeof auditActionSchema>;

export const auditEventSchema = z.object({
  auditId: z.string().min(1),
  tenantId: z.string().min(1),
  action: auditActionSchema,
  resourceType: auditResourceTypeSchema,
  resourceId: z.string().min(1).optional(),
  occurredAt: z.string().min(1),
  actor: authContextSchema,
  metadata: looseMetadataSchema,
});

export type AuditEvent = z.infer<typeof auditEventSchema>;
