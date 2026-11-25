import * as Policy from "@maple/domain/policy"
import { describe, expect, it } from "@effect/vitest"
import { HttpServerRequest } from "effect/http"
import type { TenantContext } from "@maple/domain/http"
import { OrgId, UserId } from "@maple/primitives"
import { Array as Arr, Effect, Option, Schema } from "effect"
import { makeMemoryAuditLog } from "@maple/backend/services/audit/AuditLogService"
import { recordImpersonation } from "./impersonation-audit"

const ORG = Schema.decodeSync(OrgId)("org_impersonation_test")
const USER = Schema.decodeSync(UserId)("user_impersonated")

const request = () =>
	HttpServerRequest.fromWeb(
		new Request("https://api.test/api/dashboards", { headers: { "cf-ray": "ray-imp" } }),
	)

const tenant = (sessionId: string | undefined): TenantContext => ({
	orgId: ORG,
	userId: USER,
	roles: [],
	permissions: Policy.grantsOf([]),
	authMode: "clerk",
	...(sessionId !== undefined ? { impersonation: { actorId: "user_support", sessionId } } : undefined),
})

describe("recordImpersonation", () => {
	it.effect("records one entry per impersonated session, not one per request", () =>
		Effect.gen(function* () {
			const audit = makeMemoryAuditLog()
			yield* recordImpersonation(audit, request(), tenant("sess_once"), "dashboard")
			yield* recordImpersonation(audit, request(), tenant("sess_once"), "dashboard")
			yield* recordImpersonation(audit, request(), tenant("sess_other"), "dashboard")

			const entries = yield* audit.list(ORG, { limit: 10, offset: 0 })
			const sessions = Arr.map(entries, (entry) => entry.metadata?.["sessionId"])
			expect(sessions).toHaveLength(2)
			expect(sessions).toEqual(expect.arrayContaining(["sess_once", "sess_other"]))
			const first = Option.getOrUndefined(
				Arr.findFirst(entries, (entry) => entry.metadata?.["sessionId"] === "sess_once"),
			)
			expect(first?.action).toBe("auth.impersonation")
			expect(first?.affectedUserId).toBe(USER)
			expect(first?.metadata).toMatchObject({ impersonatorId: "user_support" })
			expect(first?.requestId).toBe("ray-imp")
		}),
	)

	it.effect("records every request of an impersonation with no session id", () =>
		Effect.gen(function* () {
			const audit = makeMemoryAuditLog()
			yield* recordImpersonation(audit, request(), tenant("unknown"), "dashboard")
			yield* recordImpersonation(audit, request(), tenant("unknown"), "dashboard")
			expect(yield* audit.list(ORG, { limit: 10, offset: 0 })).toHaveLength(2)
		}),
	)

	it.effect("records nothing for an ordinary session", () =>
		Effect.gen(function* () {
			const audit = makeMemoryAuditLog()
			yield* recordImpersonation(audit, request(), tenant(undefined), "dashboard")
			expect(yield* audit.list(ORG, { limit: 10, offset: 0 })).toHaveLength(0)
		}),
	)
})
