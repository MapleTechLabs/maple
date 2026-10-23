// SAFETY-FILE: JSON in this test is emitted by the handler under test before its fields are asserted.
import { afterEach, describe, expect, it } from "@effect/vitest"
import {
	ApiSchemaErrors,
	ApiUnexpectedErrors,
	CurrentTenant,
	SecurityAuditApiGroup,
} from "@maple/domain/http"
import {
	DISABLED_ORGANIZATION_FEATURE_FLAGS,
	ENABLED_ORGANIZATION_FEATURE_FLAGS,
} from "@maple/domain/organization-feature-flags"
import { OrgId, RoleName, UserId } from "@maple/domain/primitives"
import type { SecurityAuditWorkflowPayload } from "@maple/domain/security-audit"
import type { Finding } from "@maple/security-audit"
import { ApiErrorBoundaryLive } from "@maple/backend/http/error-boundary"
import { SecurityAuditWorkflowStarter, WorkflowStartError } from "@maple/backend/platform/bindings"
import { envPorts } from "@maple/backend/platform/env-ports"
import { WorkerPlatformLive } from "@maple/infra/worker-http"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/platform/test-pglite"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { SecurityAuditStore } from "@maple/backend/services/security-audit/SecurityAuditStore"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/http"
import { HttpApi, HttpApiBuilder } from "effect/http-api"
import { HttpSecurityAuditLive } from "./security-audit.http"

class SecurityAuditOnlyApi extends HttpApi.make("MapleAiApi")
	.add(SecurityAuditApiGroup)
	.middleware(ApiSchemaErrors)
	.middleware(ApiUnexpectedErrors) {}

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG_A = Schema.decodeUnknownSync(OrgId)("org_audit_a")
const ORG_B = Schema.decodeUnknownSync(OrgId)("org_audit_b")
const USER = Schema.decodeUnknownSync(UserId)("user_audit")
const decodeRole = Schema.decodeUnknownSync(RoleName)

/** The bearer token names the caller: `<orgId>|<role>`, so one harness serves several tenants. */
const AuthorizationStubLayer = Layer.succeed(
	CurrentTenant.SessionAuthorization,
	CurrentTenant.SessionAuthorization.of({
		bearer: (httpEffect) =>
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest
				const [org = "", role = ""] = (request.headers.authorization ?? "")
					.replace("Bearer ", "")
					.split("|")
				const tenant = new CurrentTenant.TenantSchema({
					orgId: Schema.decodeUnknownSync(OrgId)(org),
					userId: USER,
					roles: [decodeRole(role)],
					authMode: "clerk",
				})
				return yield* Effect.provideService(httpEffect, CurrentTenant.Context, tenant)
			}),
	}),
)

const makeHarness = (options: { readonly enabled?: boolean; readonly startFails?: boolean } = {}) => {
	const db = createTestDb(trackedDbs)
	const started: Array<SecurityAuditWorkflowPayload> = []
	const starter = Layer.succeed(SecurityAuditWorkflowStarter, {
		create: (payload) =>
			options.startFails === true
				? Effect.fail(new WorkflowStartError({ message: "instance limit reached", cause: null }))
				: Effect.sync(() => {
						started.push(payload)
					}),
	})
	const storeLayer = SecurityAuditStore.layer.pipe(Layer.provide(db.layer))
	const routes = HttpApiBuilder.layer(SecurityAuditOnlyApi).pipe(
		Layer.provide(HttpSecurityAuditLive),
		Layer.provide(ApiErrorBoundaryLive),
		Layer.provide(WorkerPlatformLive),
		Layer.provideMerge(AuthorizationStubLayer),
		Layer.provideMerge(
			Layer.mergeAll(
				envPorts({}),
				storeLayer,
				starter,
				OrganizationFeatureFlagsService.fixed(
					options.enabled === false
						? DISABLED_ORGANIZATION_FEATURE_FLAGS
						: ENABLED_ORGANIZATION_FEATURE_FLAGS,
				),
			),
		),
	)
	const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true })

	const call = async (
		method: string,
		path: string,
		options: { readonly as?: string; readonly body?: unknown } = {},
	) => {
		const response = await handler(
			new Request(`http://maple.test/api/security-audit${path}`, {
				method,
				headers: {
					authorization: `Bearer ${options.as ?? `${ORG_A}|org:admin`}`,
					"content-type": "application/json",
				},
				body: options.body === undefined ? null : JSON.stringify(options.body),
			}),
			Context.empty(),
		)
		const text = await response.text()
		return { status: response.status, body: text.length === 0 ? null : JSON.parse(text) }
	}

	/** Runs `body` against the same database the routes use, for seeding what the engine writes. */
	const withStore = <A, E>(body: (store: SecurityAuditStore["Service"]) => Effect.Effect<A, E>) =>
		Effect.runPromise(
			Effect.gen(function* () {
				return yield* body(yield* SecurityAuditStore)
			}).pipe(Effect.provide(storeLayer)),
		)

	const count = async (table: string) =>
		Number((await queryFirstRow<{ n: number }>(db, `SELECT count(*)::int AS n FROM ${table}`))?.n)

	return { call, dispose, started, withStore, count }
}

const confirmed = (fingerprint: string): Finding => ({
	verdict: "confirmed",
	fingerprint,
	title: `Finding ${fingerprint}`,
	description: "rollKey looks the key up by id alone.",
	root_cause: "missing org predicate",
	intended_behavior: "scoped to the caller's org",
	trace: [],
	evidence: [],
	conditions: [],
	execution: { attacker_perspective: "member", payloads: [], instructions: [], observed_result: "rolled" },
	remediation: { strategy: "filter by org" },
	severity: {
		likelihood: { score: "medium", reason: "needs an id" },
		impact: { score: "high", reason: "cross-tenant" },
		overall_severity: "high",
	},
	confidence: { score: "high", reason: "reproduced" },
})

const rejected = (fingerprint: string): Finding => ({
	verdict: "rejected",
	fingerprint,
	title: `Claim ${fingerprint}`,
	description: "claimed bypass",
	trace: [],
	evidence: [],
	claimed_root_cause: "unchecked id",
	reason: "the gateway filters by org",
})

const TARGET = { repository: "acme/api", branch: "main" }

describe("/api/security-audit", () => {
	it("refuses every call with a 403 while the org is outside the rollout, and writes nothing", async () => {
		const harness = makeHarness({ enabled: false })
		try {
			const create = await harness.call("POST", "/targets", { body: TARGET })
			const list = await harness.call("GET", "/targets")

			expect([create.status, create.body._tag, list.status, list.body._tag]).toEqual([
				403,
				"@maple/http/security-audit/SecurityAuditDisabledError",
				403,
				"@maple/http/security-audit/SecurityAuditDisabledError",
			])
			expect(await harness.count("security_audit_targets")).toBe(0)
		} finally {
			await harness.dispose()
		}
	})

	it("lets members read but only admins write", async () => {
		const harness = makeHarness()
		try {
			const member = `${ORG_A}|org:member`
			const denied = await harness.call("POST", "/targets", { as: member, body: TARGET })
			const target = await harness.call("POST", "/targets", { body: TARGET })
			const deniedRun = await harness.call("POST", `/targets/${target.body.id}/runs`, {
				as: member,
				body: {},
			})
			const listed = await harness.call("GET", "/targets", { as: member })

			expect([denied.status, denied.body._tag, deniedRun.status]).toEqual([
				403,
				"@maple/http/security-audit/SecurityAuditForbiddenError",
				403,
			])
			expect(listed.body.targets.map((t: { id: string }) => t.id)).toEqual([target.body.id])
			expect([harness.started, await harness.count("security_audit_runs")]).toEqual([[], 0])
		} finally {
			await harness.dispose()
		}
	})

	it("rejects an unsafe repository, scope path or budget at the boundary", async () => {
		const harness = makeHarness()
		try {
			const statuses = await Promise.all(
				[
					{ ...TARGET, repository: "acme" },
					{ ...TARGET, repository: "acme/../etc" },
					{ ...TARGET, branch: "--upload-pack=x" },
					{ ...TARGET, scopePaths: ["../secrets"] },
					{ ...TARGET, scopePaths: ["/etc/passwd"] },
					{ ...TARGET, budgetPerRun: 0 },
					{ ...TARGET, budgetPerRun: 20_001 },
				].map((body) => harness.call("POST", "/targets", { body }).then((r) => r.status)),
			)
			expect(statuses).toEqual([400, 400, 400, 400, 400, 400, 400])
			expect(await harness.count("security_audit_targets")).toBe(0)
		} finally {
			await harness.dispose()
		}
	})

	it("starts a run for the target's branch and carries the last finished run forward", async () => {
		const harness = makeHarness()
		try {
			const target = await harness.call("POST", "/targets", {
				body: { ...TARGET, scopePaths: ["apps/api"], budgetPerRun: 300 },
			})
			const first = await harness.call("POST", `/targets/${target.body.id}/runs`, { body: {} })
			// A run still in progress is not a baseline to carry forward.
			const second = await harness.call("POST", `/targets/${target.body.id}/runs`, {
				body: { budget: 40 },
			})
			await harness.withStore((store) =>
				store.forOrg(ORG_A).finishRun(first.body.id, { status: "complete" }),
			)
			const third = await harness.call("POST", `/targets/${target.body.id}/runs`, {
				body: { kind: "revalidation", scopePaths: ["apps/api/src/routes"] },
			})

			expect([first.status, first.body.status, first.body.kind, third.body.kind]).toEqual([
				200,
				"in_progress",
				"manual",
				"revalidation",
			])
			expect(harness.started).toEqual([
				{
					orgId: ORG_A,
					runId: first.body.id,
					repository: "acme/api",
					ref: "main",
					profile: "deep",
					scopePaths: ["apps/api"],
					budget: 300,
					priorRunId: null,
				},
				{
					orgId: ORG_A,
					runId: second.body.id,
					repository: "acme/api",
					ref: "main",
					profile: "deep",
					scopePaths: ["apps/api"],
					budget: 40,
					priorRunId: null,
				},
				{
					orgId: ORG_A,
					runId: third.body.id,
					repository: "acme/api",
					ref: "main",
					profile: "deep",
					scopePaths: ["apps/api/src/routes"],
					budget: 300,
					priorRunId: first.body.id,
				},
			])
		} finally {
			await harness.dispose()
		}
	})

	it("marks the run failed when its workflow does not start", async () => {
		const harness = makeHarness({ startFails: true })
		try {
			const target = await harness.call("POST", "/targets", { body: TARGET })
			const start = await harness.call("POST", `/targets/${target.body.id}/runs`, { body: {} })
			const runs = await harness.call("GET", `/runs?targetId=${target.body.id}`)

			expect([start.status, start.body._tag]).toEqual([
				503,
				"@maple/http/security-audit/SecurityAuditStartError",
			])
			expect(runs.body.runs.map((r: { status: string; error: string }) => [r.status, r.error])).toEqual(
				[["failed", "The audit workflow did not start: instance limit reached"]],
			)
		} finally {
			await harness.dispose()
		}
	})

	it("hides rejected findings unless asked, and persists a dismissal with its reason", async () => {
		const harness = makeHarness()
		try {
			const target = await harness.call("POST", "/targets", { body: TARGET })
			const run = await harness.call("POST", `/targets/${target.body.id}/runs`, { body: {} })
			await harness.withStore((store) =>
				store.forOrg(ORG_A).saveFindings(run.body.id, [confirmed("f1"), rejected("f2")]),
			)
			const findingsPath = `/targets/${target.body.id}/findings`

			const visible = await harness.call("GET", findingsPath)
			const all = await harness.call("GET", `${findingsPath}?includeRejected=true`)
			const dismiss = await harness.call("PATCH", `${findingsPath}/f1`, {
				body: { status: "dismissed", reason: "fixture data, not reachable" },
			})
			const missingReason = await harness.call("PATCH", `${findingsPath}/f1`, {
				body: { status: "accepted_risk" },
			})
			const after = await harness.call("GET", findingsPath)

			const fingerprints = (body: { findings: ReadonlyArray<{ fingerprint: string }> }) =>
				body.findings.map((f) => f.fingerprint)
			expect([fingerprints(visible.body), fingerprints(all.body)]).toEqual([["f1"], ["f1", "f2"]])
			expect([dismiss.status, missingReason.status]).toEqual([200, 400])
			expect(
				after.body.findings.map(
					(f: { status: string; statusReason: string; statusChangedBy: string }) => [
						f.status,
						f.statusReason,
						f.statusChangedBy,
					],
				),
			).toEqual([["dismissed", "fixture data, not reachable", USER]])
		} finally {
			await harness.dispose()
		}
	})

	it("answers 404 for another org's target, run and finding ids", async () => {
		const harness = makeHarness()
		try {
			const target = await harness.call("POST", "/targets", { body: TARGET })
			const run = await harness.call("POST", `/targets/${target.body.id}/runs`, { body: {} })
			await harness.withStore((store) =>
				store.forOrg(ORG_A).saveFindings(run.body.id, [confirmed("f1")]),
			)
			const other = `${ORG_B}|org:admin`

			const responses = await Promise.all([
				harness.call("GET", `/runs/${run.body.id}`, { as: other }),
				harness.call("GET", `/runs/${run.body.id}/events`, { as: other }),
				harness.call("POST", `/targets/${target.body.id}/runs`, { as: other, body: {} }),
				harness.call("GET", `/targets/${target.body.id}/findings`, { as: other }),
				harness.call("PATCH", `/targets/${target.body.id}/findings/f1`, {
					as: other,
					body: { status: "dismissed", reason: "not mine" },
				}),
			])
			const own = await harness.call("GET", `/runs/${run.body.id}`)
			const foreignRuns = await harness.call("GET", "/runs", { as: other })

			expect(responses.map((r) => r.status)).toEqual([404, 404, 404, 404, 404])
			expect([own.status, own.body.id, own.body.unitTotal, foreignRuns.body.runs]).toEqual([
				200,
				run.body.id,
				0,
				[],
			])
			expect(harness.started.map((p) => p.orgId)).toEqual([ORG_A])
		} finally {
			await harness.dispose()
		}
	})
})
