import { describe, expect, it } from "@effect/vitest"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { ApiKeyId, OrgId, UserId } from "@maple/primitives"
import { Array as Arr, Effect, Schema } from "effect"
import type { AuditedReadSubject } from "@maple/backend/services/audit/audit-access"
import { makeMemoryAuditLog } from "@maple/backend/services/audit/AuditLogService"
import { AUDIT_DENIAL_COALESCE_WINDOW_MS, recordAccessDenial } from "./audit-denial"

const USER = Schema.decodeSync(UserId)("user_denied")
const OTHER_USER = Schema.decodeSync(UserId)("user_denied_too")
const KEY = Schema.decodeSync(ApiKeyId)("0f6c1c0e-8a3e-4c57-9a52-6f6f1d3b7a10")

// Each test refuses a caller in its own org: the coalescing memo is shared by the isolate.
const orgOf = (name: string) => Schema.decodeSync(OrgId)(`org_denial_${name}`)

const person = (orgId: OrgId, userId: UserId = USER): AuditedReadSubject => ({
	orgId,
	actor: { type: "user", userId },
	source: "dashboard",
})

const key = (orgId: OrgId): AuditedReadSubject => ({
	orgId,
	actor: { type: "api_key", userId: USER, apiKeyId: KEY, label: "ci" },
	source: "api",
})

const request = (method: string, path: string) =>
	HttpServerRequest.fromWeb(
		new Request(`https://api.test${path}?cursor=1`, { method, headers: { "cf-ray": "ray-denied" } }),
	)

/** Runs a refusal as the router would: with the route template the request matched. */
const matched = (routePath: `/${string}`) =>
	Effect.provideService(HttpRouter.RouteContext, {
		params: {},
		route: HttpRouter.route("*", routePath, HttpServerResponse.empty()),
	})

const RULE = "/v2/alerts/rules/:id"
const manageAlerts = { permission: "alerts:manage", message: "You need Manage alerts" } as const

describe("recordAccessDenial", () => {
	it.effect("records a person refused a named permission, with the permission and the route", () =>
		Effect.gen(function* () {
			const audit = makeMemoryAuditLog()
			const org = orgOf("named")
			yield* recordAccessDenial(
				audit,
				request("DELETE", "/v2/alerts/rules/rule_1"),
				person(org),
			)(manageAlerts).pipe(matched(RULE))
			const entries = yield* audit.list(org, { limit: 10, offset: 0 })
			expect(
				Arr.map(entries, (entry) => [entry.action, entry.outcome, entry.source, entry.denialReason]),
			).toEqual([["api.request", "denied", "dashboard", "You need Manage alerts"]])
			// The route, not the path: a path can carry a push token or a login code.
			expect(entries[0]?.metadata).toEqual({
				method: "DELETE",
				path: RULE,
				permission: "alerts:manage",
			})
			expect(entries[0]?.requestId).toBe("ray-denied")
		}),
	)

	it.effect("keeps the path a key asked for", () =>
		Effect.gen(function* () {
			const audit = makeMemoryAuditLog()
			const org = orgOf("key_path")
			yield* recordAccessDenial(
				audit,
				request("DELETE", "/v2/alerts/rules/rule_1"),
				key(org),
			)(manageAlerts).pipe(matched(RULE))
			const entries = yield* audit.list(org, { limit: 10, offset: 0 })
			expect(Arr.map(entries, (entry) => [entry.actorType, entry.metadata?.["path"]])).toEqual([
				["api_key", "/v2/alerts/rules/rule_1"],
			])
		}),
	)

	it.effect("leaves a person refused Read telemetry out of the log, and records a key refused it", () =>
		Effect.gen(function* () {
			const audit = makeMemoryAuditLog()
			const org = orgOf("read")
			const denial = { permission: "telemetry:read", message: "You need Read telemetry" } as const
			yield* recordAccessDenial(audit, request("GET", "/api/traces"), person(org))(denial)
			expect(yield* audit.list(org, { limit: 10, offset: 0 })).toHaveLength(0)
			yield* recordAccessDenial(audit, request("GET", "/api/traces"), key(org))(denial)
			const entries = yield* audit.list(org, { limit: 10, offset: 0 })
			expect(Arr.map(entries, (entry) => entry.actorType)).toEqual(["api_key"])
		}),
	)

	// Keyed on the URL, a caller looping over ids or spellings of one route would write a row each.
	it.effect("writes one row for a route however many ids or spellings of it are refused", () =>
		Effect.gen(function* () {
			const audit = makeMemoryAuditLog()
			const org = orgOf("route")
			yield* Effect.forEach(
				["/v2/alerts/rules/rule_1", "/v2/alerts/rules/rule_2", "/V2/alerts//rules/rule_3;x"],
				(path) =>
					recordAccessDenial(
						audit,
						request("DELETE", path),
						person(org),
					)(manageAlerts).pipe(matched(RULE)),
			)
			expect(yield* audit.list(org, { limit: 10, offset: 0 })).toHaveLength(1)
		}),
	)

	it.effect("writes a row of its own for another caller, another route and another message", () =>
		Effect.gen(function* () {
			const audit = makeMemoryAuditLog()
			const org = orgOf("distinct")
			const refuse = (caller: AuditedReadSubject, route: `/${string}`, message: string) =>
				recordAccessDenial(
					audit,
					request("DELETE", "/v2/alerts/rules/rule_1"),
					caller,
				)({ message }).pipe(matched(route))
			yield* refuse(person(org), RULE, "first")
			yield* refuse(person(org), RULE, "first")
			yield* refuse(person(org, OTHER_USER), RULE, "first")
			yield* refuse(person(org), "/v2/slos/:id", "first")
			yield* refuse(person(org), RULE, "second")
			expect(yield* audit.list(org, { limit: 10, offset: 0 })).toHaveLength(4)
		}),
	)

	it.effect("writes the same refusal again once the window has passed, and not a moment before", () =>
		Effect.gen(function* () {
			const audit = makeMemoryAuditLog()
			const org = orgOf("window")
			const refuse = recordAccessDenial(
				audit,
				request("POST", "/api/slos"),
				person(org),
			)({ message: "unmarked" })
			// Suspended: the in-memory log answers `list` with the entries it held when called.
			const written = Effect.suspend(() =>
				Effect.map(audit.list(org, { limit: 10, offset: 0 }), (entries) => entries.length),
			)
			yield* refuse
			yield* TestClock.adjust(AUDIT_DENIAL_COALESCE_WINDOW_MS - 1)
			yield* refuse
			expect(yield* written).toBe(1)
			yield* TestClock.adjust(1)
			yield* refuse
			expect(yield* written).toBe(2)
		}),
	)
})
