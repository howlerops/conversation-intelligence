# Auth And Gateway Guidance

The runtime is intentionally optimized for low-overhead installs. That affects the auth recommendation.

## Current Runtime Modes

Implemented runtime auth modes:

- `none` for local development
- `api_key` for small installs and internal services
- `trusted_proxy` for deployments behind an existing gateway or platform edge

## OIDC Recommendation

Do not put full OIDC session handling inside this runtime yet.

Recommended production pattern:

1. terminate OIDC in the gateway, ingress, or existing app platform
2. validate the user token there
3. forward only the trusted identity headers required by this runtime
4. run this service in `trusted_proxy` mode

This keeps the conversation-intelligence runtime focused on:

- tenant scoping
- audit emission
- workflow state
- review actions

and avoids turning it into a full identity product.

## Trusted Proxy Contract

Default headers:

- `x-ci-tenant-id`
- `x-ci-principal-id`
- `x-ci-scopes`

These are configurable with:

- `CI_TRUSTED_PROXY_TENANT_HEADER`
- `CI_TRUSTED_PROXY_PRINCIPAL_HEADER`
- `CI_TRUSTED_PROXY_SCOPES_HEADER`

## Hardening Requirements

If you run in `trusted_proxy` mode:

- ensure the service is not directly exposed to the public internet
- strip incoming copies of the trusted headers before the gateway re-injects them
- bind gateway auth scopes to tenant-aware authorization upstream
- keep audit trails enabled so review actions remain attributable

## When To Add Native OIDC

Add native OIDC or JWT verification only if one of these becomes true:

- customers need to expose this runtime directly without an existing gateway
- embedded installs cannot rely on a surrounding platform for auth
- policy requires token validation inside every downstream service

At the current stage, trusted-proxy mode is the better fit for the low-overhead deployment goal.
