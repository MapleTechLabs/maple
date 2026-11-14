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

/** The kinds a caller may create by name. A `device` credential is issued to an installation by its own endpoints. */
export const CreatableApiKeyKind = Schema.Literals(["standard", "mcp"])
export type CreatableApiKeyKind = Schema.Schema.Type<typeof CreatableApiKeyKind>
