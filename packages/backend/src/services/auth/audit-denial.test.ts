import { describe, expect, it } from "@effect/vitest"
import { HttpServerRequest } from "effect/http"
import { ApiKeyId, OrgId, UserId } from "@maple/primitives"
import { Array as Arr, Effect, Schema } from "effect"
import { makeMemoryAuditLog } from "@maple/backend/services/audit/AuditLogService"
import { type DeniedCaller, recordAccessDenial } from "./audit-denial"

const USER = Schema.decodeSync(UserId)("user_denied")
const KEY = Schema.decodeSync(ApiKeyId)("0f6c1c0e-8a3e-4c57-9a52-6f6f1d3b7a10")

// Each test refuses a caller in its own org: the coalescing memo is shared by the isolate.
const orgOf = (name: string) => Schema.decodeSync(OrgId)(`org_denial_${name}`)

const person = (orgId: OrgId): DeniedCaller => ({
	orgId,
	actor: { type: "user", userId: USER },
	source: "dashboard",
})

const key = (orgId: OrgId): DeniedCaller => ({
	orgId,
	actor: { type: "api_key", userId: USER, apiKeyId: KEY, label: "ci" },
	source: "api",
})

const request = (method: string, path: string) =>
	HttpServerRequest.fromWeb(
		new Request(`https://api.test${path}?cursor=1`, { method, headers: { "cf-ray": "ray-denied" } }),
	)

describe("recordAccessDenial", () => {
	it.effect("records a person refused a named permission, with the permission and the request", () =>
		Effect.gen(function* () {
			const audit = makeMemoryAuditLog()
			const org = orgOf("named")
			yield* recordAccessDenial(audit, request("POST", "/api/alerts/rules"), person(org), {
				permission: "alerts:manage",
				reason: "You need Manage alerts",
			})
			const entries = yield* audit.list(org, { limit: 10, offset: 0 })
			expect(Arr.map(entries, (entry) => [entry.action, entry.outcome, entry.denialReason])).toEqual([
				["api.request", "denied", "You need Manage alerts"],
			])
			expect(entries[0]?.metadata).toEqual({
				method: "POST",
				path: "/api/alerts/rules",
				permission: "alerts:manage",
			})
			expect(entries[0]?.requestId).toBe("ray-denied")
		}),
	)

	it.effect("leaves a person refused Read telemetry out of the log, and records a key refused it", () =>
		Effect.gen(function* () {
			const audit = makeMemoryAuditLog()
			const org = orgOf("read")
			const denial = { permission: "telemetry:read", reason: "You need Read telemetry" } as const
			yield* recordAccessDenial(audit, request("GET", "/api/traces"), person(org), denial)
			expect(yield* audit.list(org, { limit: 10, offset: 0 })).toHaveLength(0)
			yield* recordAccessDenial(audit, request("GET", "/api/traces"), key(org), denial)
			const entries = yield* audit.list(org, { limit: 10, offset: 0 })
			expect(Arr.map(entries, (entry) => entry.actorType)).toEqual(["api_key"])
		}),
	)

	it.effect("writes a repeated refusal once, and a different reason again", () =>
		Effect.gen(function* () {
			const audit = makeMemoryAuditLog()
			const org = orgOf("repeat")
			const write = request("POST", "/api/slos")
			yield* recordAccessDenial(audit, write, person(org), { reason: "unmarked" })
			yield* recordAccessDenial(audit, write, person(org), { reason: "unmarked" })
			yield* recordAccessDenial(audit, write, person(org), {
				permission: "slos:manage",
				reason: "You need Manage SLOs",
			})
			expect(yield* audit.list(org, { limit: 10, offset: 0 })).toHaveLength(2)
		}),
	)
})
