import { describe, expect, it } from 'vitest';
import { HttpAuthError, resolveHttpAuthContext } from '../src';

function makeRequest(headers: Record<string, string>) {
  return {
    headers,
  } as const;
}

describe('http auth', () => {
  it('resolves API-key auth contexts', () => {
    const context = resolveHttpAuthContext(makeRequest({
      authorization: 'Bearer token-acme',
    }) as never, {
      mode: 'api_key',
      apiKeys: [
        {
          token: 'token-acme',
          tenantId: 'tenant_support_acme',
          principalId: 'svc_acme',
        },
      ],
    });

    expect(context.authMode).toBe('api_key');
    expect(context.tenantId).toBe('tenant_support_acme');
    expect(context.principalId).toBe('svc_acme');
  });

  it('rejects invalid API keys', () => {
    expect(() => resolveHttpAuthContext(makeRequest({
      authorization: 'Bearer wrong',
    }) as never, {
      mode: 'api_key',
      apiKeys: [
        {
          token: 'token-acme',
          tenantId: 'tenant_support_acme',
          principalId: 'svc_acme',
        },
      ],
    })).toThrow(HttpAuthError);
  });

  it('resolves trusted-proxy contexts from forwarded headers', () => {
    const context = resolveHttpAuthContext(makeRequest({
      'x-ci-tenant-id': 'tenant_support_acme',
      'x-ci-principal-id': 'gateway-user',
      'x-ci-scopes': 'runs:read,runs:write',
    }) as never, {
      mode: 'trusted_proxy',
    });

    expect(context.authMode).toBe('trusted_proxy');
    expect(context.tenantId).toBe('tenant_support_acme');
    expect(context.scopes).toEqual(['runs:read', 'runs:write']);
  });
});
