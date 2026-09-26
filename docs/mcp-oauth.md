# MCP OAuth

Maple's remote MCP endpoint (`/mcp`) is an OAuth 2.1 protected resource. Clients discover the
Maple authorization server through RFC 9728 protected-resource metadata, register as public
clients, and use authorization code + S256 PKCE.

## Discovery and endpoints

- `GET /.well-known/oauth-protected-resource/mcp` (also served without the `/mcp` suffix)
- `GET /.well-known/oauth-authorization-server` (also served with a `/mcp` suffix)
- `POST /register`: dynamic registration for public clients. Redirect URIs must use HTTPS or a
  loopback HTTP address.
- `GET /oauth/authorize`: validates the client, the registered redirect URI, `resource`, the
  `mcp:tools` scope, and the PKCE challenge, then redirects to the Maple approval page. Redirect
  URIs match exactly, except that HTTP loopback clients may use a different port at authorization
  time, as RFC 8252 requires.
- `POST /oauth/token`: accepts form-encoded `authorization_code` and `refresh_token` grants.
- `POST /oauth/revoke`: revokes an access token or an entire refresh-token family.

Unauthenticated MCP requests return `401` with a `WWW-Authenticate` challenge that carries the
protected-resource metadata URL and the required `mcp:tools` scope.

## Credentials

Authorization codes are single-use and expire after five minutes. Access tokens are opaque,
hashed Maple MCP keys with a one-hour expiry. Their metadata binds the approving user's roles,
OAuth client, and exact MCP resource. Refresh tokens are opaque, hashed, valid for 30 days, and
rotate on every use. A grant family expires 90 days after it was first issued, however often it refreshes,
so the client re-consents once a quarter. Reusing a rotated refresh token revokes the whole grant
family.

Manual MCP keys remain supported for clients without OAuth. They continue to use the existing
`Authorization: Bearer ...` configuration and are isolated to the MCP server by `kind: "mcp"`.

## Rate limiting

Authenticated `POST /mcp` requests share one budget per credential (the internal key ID for
OAuth tokens and manual MCP keys, the user for dashboard sessions) of **120 requests per 10
seconds**, partitioned by deployment environment. Exceeding it returns `429` with
`{ "error": "rate_limited" }` and `Retry-After: 10`. The limiter fails open with
`maple.rate_limit.outcome=failed_open` telemetry, like the `/v2` limiter documented in
[api-v2.md](api-v2.md#rate-limiting). The OAuth handshake endpoints above have their own
60 requests per 60s budget.

## Browser approval

The API redirects valid authorization requests to `/mcp-authorize` on `MAPLE_APP_BASE_URL`. The
existing sign-in and active-workspace redirects protect this page. Approval captures the current
workspace, user, and roles; changing workspace before approval changes the workspace bound to the
issued grant.

The OAuth tables come from migration `packages/db/drizzle/20260721133909_brown_brood`, which the
prd deploy applies.
