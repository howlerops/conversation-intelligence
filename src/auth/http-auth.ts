import { IncomingMessage } from 'http';
import { authContextSchema, AuthContext, AuthMode, PrincipalType } from '../contracts/runtime';

export interface ApiKeyAuthEntry {
  token: string;
  tenantId: string;
  principalId: string;
  principalType?: PrincipalType;
  scopes?: string[];
}

export interface HttpAuthOptions {
  mode?: AuthMode;
  apiKeys?: ApiKeyAuthEntry[];
  tenantHeader?: string;
  principalHeader?: string;
  scopesHeader?: string;
}

export class HttpAuthError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpAuthError';
  }
}

function readHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];

  if (Array.isArray(value)) {
    return value[0];
  }

  return value ?? undefined;
}

function parseBearerToken(request: IncomingMessage): string | undefined {
  const authorization = readHeader(request, 'authorization');

  if (!authorization) {
    return undefined;
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function parseScopes(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(',')
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

export function resolveHttpAuthContext(
  request: IncomingMessage,
  options: HttpAuthOptions = {},
): AuthContext {
  const mode = options.mode ?? 'none';

  if (mode === 'none') {
    return authContextSchema.parse({
      authMode: 'none',
      principalId: 'anonymous',
      principalType: 'ANONYMOUS',
      scopes: ['runs:read', 'runs:write'],
    });
  }

  if (mode === 'api_key') {
    const token = parseBearerToken(request);
    const entry = options.apiKeys?.find((candidate) => candidate.token === token);

    if (!entry) {
      throw new HttpAuthError(401, 'Missing or invalid API key.');
    }

    return authContextSchema.parse({
      authMode: 'api_key',
      principalId: entry.principalId,
      principalType: entry.principalType ?? 'API_KEY',
      tenantId: entry.tenantId,
      scopes: entry.scopes ?? ['runs:read', 'runs:write'],
    });
  }

  const tenantHeader = options.tenantHeader ?? 'x-ci-tenant-id';
  const principalHeader = options.principalHeader ?? 'x-ci-principal-id';
  const scopesHeader = options.scopesHeader ?? 'x-ci-scopes';

  const tenantId = readHeader(request, tenantHeader);
  const principalId = readHeader(request, principalHeader);

  if (!tenantId || !principalId) {
    throw new HttpAuthError(401, 'Trusted proxy headers are missing.');
  }

  return authContextSchema.parse({
    authMode: 'trusted_proxy',
    principalId,
    principalType: 'SERVICE',
    tenantId,
    scopes: parseScopes(readHeader(request, scopesHeader)),
  });
}

export function assertTenantAccess(context: AuthContext, tenantId: string): void {
  if (!context.tenantId) {
    return;
  }

  if (context.tenantId !== tenantId) {
    throw new HttpAuthError(403, `Tenant ${context.tenantId} cannot access tenant ${tenantId}.`);
  }
}

export function tenantScopeFromAuth(context: AuthContext): string | undefined {
  return context.tenantId;
}
