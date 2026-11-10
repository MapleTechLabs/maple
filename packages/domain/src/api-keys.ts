// Stored shapes shared by the HTTP contract (`./http/api-keys.ts`) and the Postgres tables.

import { Schema } from "effect"

/**
 * `standard` — a human-minted organization key, admin-gated.
 * `mcp` — only valid for the MCP server; rejected on /v2.
 * `device` — minted for one device by a signed-in app. The *server* chooses its
 * scopes, TTL, and roles, so its ceiling is structural rather than a promise
 * the client makes; see `ApiKeysService.replaceDeviceKey`.
 */
export const ApiKeyKind = Schema.Literals(["standard", "mcp", "device"])
export type ApiKeyKind = Schema.Schema.Type<typeof ApiKeyKind>
