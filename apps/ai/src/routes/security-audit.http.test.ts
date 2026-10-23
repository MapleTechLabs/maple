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
import {
	SecurityAuditWorkflowStarter,
	WorkflowCancelError,
	WorkflowStartError,
} from "@maple/backend/platform/bindings"
import { envPorts } from "@maple/backend/platform/env-ports"
import { AuditLogService, makeMemoryAuditLog } from "@maple/backend/services/audit/AuditLogService"
import { WorkerPlatformLive } from "@maple/infra/worker-http"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/platform/test-pglite"
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

const makeHarness = (
	options: {
		readonly enabled?: boolean
		readonly startFails?: boolean
		readonly cancelFails?: boolean
	} = {},
) => {
	const db = createTestDb(trackedDbs)
	const started: Array<SecurityAuditWorkflowPayload> = []
	const cancelled: Array<string> = []
	const starter = Layer.succeed(SecurityAuditWorkflowStarter, {
		create: (payload) =>
			options.startFails === true
				? Effect.fail(new WorkflowStartError({ message: "instance limit reached", cause: null }))
				: Effect.sync(() => {
						started.push(payload)
					}),
		cancel: (runId) =>
			options.cancelFails === true
				? Effect.fail(new WorkflowCancelError({ message: "binding unavailable", cause: null }))
				: Effect.sync(() => {
						cancelled.push(runId)
					}),
	})
	const auditLog = makeMemoryAuditLog()
	const storeLayer = SecurityAuditStore.layer.pipe(Layer.provide(db.layer))
	// The org's GitHub connection: a target can only name a repository it has connected.
	const connected = executeSql(
		db,
		`INSERT INTO vcs_repositories (id, org_id, provider, installation_id, external_repo_id, owner, name,
			full_name, tracked_branch, html_url, created_at, updated_at)
		 VALUES ($1, $2, 'github', $3, '1001', 'acme', 'api', 'acme/api', 'main', 'https://github.com/acme/api', now(), now())`,
		[crypto.randomUUID(), ORG_A, crypto.randomUUID()],
	)
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
				Layer.succeed(AuditLogService, auditLog),
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
		await connected
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

	const sql = (statement: string, params: Array<unknown> = []) => executeSql(db, statement, params)

	return { call, dispose, started, cancelled, withStore, count, sql, auditLog }
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

const tag = (name: string) => `@maple/http/security-audit/${name}`

describe("/api/security-audit access", () => {
	it("refuses every call with a 403 while the org is outside the rollout, and writes nothing", async () => {
		const harness = makeHarness({ enabled: false })
		try {
			const create = await harness.call("POST", "/targets", { body: TARGET })
			const list = await harness.call("GET", "/targets")

			expect([create.status, create.body._tag, list.status, list.body._tag]).toEqual([
				403,
				tag("SecurityAuditDisabledError"),
				403,
				tag("SecurityAuditDisabledError"),
			])
			expect(await harness.count("security_audit_targets")).toBe(0)
		} finally {
			await harness.dispose()
		}
	})

	it("lets members list targets and runs, and keeps findings, reports and writes to admins", async () => {
		const harness = makeHarness()
		try {
			const member = `${ORG_A}|org:member`
			const target = await harness.call("POST", "/targets", { body: TARGET })
			const run = await harness.call("POST", `/targets/${target.body.id}/runs`, { body: {} })
			const memberCalls = await Promise.all([
				harness.call("GET", "/targets", { as: member }),
				harness.call("GET", "/runs", { as: member }),
				harness.call("GET", `/runs/${run.body.id}`, { as: member }),
				harness.call("GET", `/runs/${run.body.id}/events`, { as: member }),
				harness.call("GET", `/targets/${target.body.id}/findings`, { as: member }),
				harness.call("POST", "/targets", { as: member, body: { ...TARGET, branch: "next" } }),
				harness.call("PATCH", `/targets/${target.body.id}/findings/f1`, {
					as: member,
					body: { status: "dismissed", reason: "no" },
				}),
			])

			expect(memberCalls.map((r) => r.status)).toEqual([200, 200, 403, 403, 403, 403, 403])
			expect(memberCalls[5]?.body._tag).toBe(tag("SecurityAuditForbiddenError"))
			expect(harness.started.map((p) => p.runId)).toEqual([run.body.id])
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
			const foreignRuns = await harness.call("GET", "/runs", { as: other })

			expect(responses.map((r) => r.status)).toEqual([404, 404, 404, 404, 404])
			expect(foreignRuns.body.runs).toEqual([])
			expect(harness.started.map((p) => p.orgId)).toEqual([ORG_A])
		} finally {
			await harness.dispose()
		}
	})
})

describe("/api/security-audit targets", () => {
	it("rejects an unsafe repository, scope path, budget or page size at the boundary", async () => {
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
			const run = "00000000-0000-4000-8000-000000000000"
			const pages = await Promise.all(
				["limit=0", "limit=1001", "beforeAt=-1"].map((q) =>
					harness.call("GET", `/runs/${run}/events?${q}`).then((r) => r.status),
				),
			)
			expect([statuses, pages]).toEqual([
				[400, 400, 400, 400, 400, 400, 400],
				[400, 400, 400],
			])
			expect(await harness.count("security_audit_targets")).toBe(0)
		} finally {
			await harness.dispose()
		}
	})

	it("resolves the repository through the org's connection and refuses duplicates", async () => {
		const harness = makeHarness()
		try {
			const created = await harness.call("POST", "/targets", {
				body: { ...TARGET, repository: "Acme/API" },
			})
			const duplicate = await harness.call("POST", "/targets", { body: TARGET })
			const unconnected = await harness.call("POST", "/targets", {
				body: { ...TARGET, repository: "acme/web" },
			})

			expect([created.status, created.body.repository]).toEqual([200, "acme/api"])
			expect([
				duplicate.status,
				duplicate.body._tag,
				unconnected.status,
				unconnected.body._tag,
			]).toEqual([
				409,
				tag("SecurityAuditTargetExistsError"),
				404,
				tag("SecurityAuditRepositoryNotConnectedError"),
			])
			expect(await harness.count("security_audit_targets")).toBe(1)
		} finally {
			await harness.dispose()
		}
	})
})

describe("/api/security-audit runs", () => {
	it("starts manual runs one at a time, with a finite budget and the best prior run", async () => {
		const harness = makeHarness()
		try {
			const target = await harness.call("POST", "/targets", { body: { ...TARGET, budgetPerRun: 300 } })
			const runs = `/targets/${target.body.id}/runs`
			const finish = (runId: string) =>
				harness.withStore((store) => store.forOrg(ORG_A).finishRun(runId, { status: "complete" }))

			// `kind` is not the client's to set: the API only starts manual runs.
			const whole = await harness.call("POST", runs, { body: { kind: "revalidation" } })
			const whileRunning = await harness.call("POST", runs, { body: {} })
			await finish(whole.body.id)
			const scoped = await harness.call("POST", runs, {
				body: { scopePaths: ["apps/api/src/routes"], budget: 40 },
			})
			await finish(scoped.body.id)
			const next = await harness.call("POST", runs, { body: {} })

			const unbudgeted = await harness.call("POST", "/targets", { body: { ...TARGET, branch: "next" } })
			await harness.call("POST", `/targets/${unbudgeted.body.id}/runs`, { body: {} })

			expect([whole.body.kind, whileRunning.status, whileRunning.body._tag]).toEqual([
				"manual",
				409,
				tag("SecurityAuditRunInProgressError"),
			])
			expect(
				harness.started.map((p) => [p.runId, p.ref, p.scopePaths, p.budget, p.priorRunId]),
			).toEqual([
				[whole.body.id, "main", [], 300, null],
				[scoped.body.id, "main", ["apps/api/src/routes"], 40, whole.body.id],
				// The whole-target run is preferred over the later scoped one.
				[next.body.id, "main", [], 300, whole.body.id],
				[expect.any(String), "next", [], 400, null],
			])
		} finally {
			await harness.dispose()
		}
	})

	it("refuses a run on a disabled target", async () => {
		const harness = makeHarness()
		try {
			const target = await harness.call("POST", "/targets", { body: TARGET })
			await harness.sql(`UPDATE security_audit_targets SET enabled = false WHERE id = $1`, [
				target.body.id,
			])
			const start = await harness.call("POST", `/targets/${target.body.id}/runs`, { body: {} })

			expect([start.status, start.body._tag, harness.started]).toEqual([
				409,
				tag("SecurityAuditTargetDisabledError"),
				[],
			])
		} finally {
			await harness.dispose()
		}
	})

	it("marks the run failed when its workflow does not start, freeing the target", async () => {
		const harness = makeHarness({ startFails: true })
		try {
			const target = await harness.call("POST", "/targets", { body: TARGET })
			const start = await harness.call("POST", `/targets/${target.body.id}/runs`, { body: {} })
			const retry = await harness.call("POST", `/targets/${target.body.id}/runs`, { body: {} })
			const runs = await harness.call("GET", `/runs?targetId=${target.body.id}`)

			expect([start.status, start.body._tag, retry.body._tag]).toEqual([
				503,
				tag("SecurityAuditStartError"),
				tag("SecurityAuditStartError"),
			])
			expect(runs.body.runs.map((r: { status: string; error: string }) => [r.status, r.error])).toEqual(
				[
					["failed", "The audit workflow did not start: instance limit reached"],
					["failed", "The audit workflow did not start: instance limit reached"],
				],
			)
		} finally {
			await harness.dispose()
		}
	})

	it("serves a run whose stored reports predate the current shape, with unit counts", async () => {
		const harness = makeHarness()
		try {
			const target = await harness.call("POST", "/targets", { body: TARGET })
			const run = await harness.call("POST", `/targets/${target.body.id}/runs`, { body: {} })
			await harness.sql(
				`UPDATE security_audit_runs SET reports = '{"report":1}'::jsonb WHERE id = $1`,
				[run.body.id],
			)
			const detail = await harness.call("GET", `/runs/${run.body.id}`)

			expect([
				detail.status,
				detail.body.reports,
				detail.body.unitCounts,
				detail.body.unitTotal,
			]).toEqual([200, null, {}, 0])
		} finally {
			await harness.dispose()
		}
	})
})

describe("/api/security-audit findings", () => {
	it("hides rejected findings unless asked, and records a dismissal with its reason", async () => {
		const harness = makeHarness()
		try {
			const target = await harness.call("POST", "/targets", { body: TARGET })
			const run = await harness.call("POST", `/targets/${target.body.id}/runs`, { body: {} })
			const fingerprint = "authz/rollKey:missing-org"
			await harness.withStore((store) =>
				store.forOrg(ORG_A).saveFindings(run.body.id, [confirmed(fingerprint), rejected("f2")]),
			)
			const findingsPath = `/targets/${target.body.id}/findings`
			const findingPath = `${findingsPath}/${encodeURIComponent(fingerprint)}`

			const visible = await harness.call("GET", findingsPath)
			const all = await harness.call("GET", `${findingsPath}?includeRejected=true`)
			const dismiss = await harness.call("PATCH", findingPath, {
				body: { status: "dismissed", reason: "fixture data, not reachable" },
			})
			const missingReason = await harness.call("PATCH", findingPath, {
				body: { status: "accepted_risk" },
			})
			const after = await harness.call("GET", findingsPath)
			const audit = await Effect.runPromise(
				harness.auditLog.list(ORG_A, {
					action: "security_audit_finding.triaged",
					limit: 10,
					offset: 0,
				}),
			)

			const fingerprints = (body: { findings: ReadonlyArray<{ fingerprint: string }> }) =>
				body.findings.map((f) => f.fingerprint)
			expect([fingerprints(visible.body), fingerprints(all.body)]).toEqual([
				[fingerprint],
				[fingerprint, "f2"],
			])
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
			expect(audit.map((entry) => [entry.userId, entry.metadata])).toEqual([
				[
					USER,
					{
						targetId: target.body.id,
						fingerprint,
						status: "dismissed",
						reason: "fixture data, not reachable",
					},
				],
			])
		} finally {
			await harness.dispose()
		}
	})
})

describe("/api/security-audit run cancellation", () => {
	it("terminates the workflow, marks the run cancelled, and records the event and audit entry", async () => {
		const harness = makeHarness()
		try {
			const target = await harness.call("POST", "/targets", { body: TARGET })
			const run = await harness.call("POST", `/targets/${target.body.id}/runs`, { body: {} })
			const asMember = await harness.call("POST", `/runs/${run.body.id}/cancel`, {
				as: `${ORG_A}|org:member`,
			})
			const cancel = await harness.call("POST", `/runs/${run.body.id}/cancel`)
			const again = await harness.call("POST", `/runs/${run.body.id}/cancel`)
			const events = await harness.call("GET", `/runs/${run.body.id}/events`)
			const next = await harness.call("POST", `/targets/${target.body.id}/runs`, { body: {} })
			const audit = await Effect.runPromise(
				harness.auditLog.list(ORG_A, {
					action: "security_audit_run.cancelled",
					limit: 10,
					offset: 0,
				}),
			)

			expect([asMember.status, cancel.status, again.status, again.body._tag]).toEqual([
				403,
				200,
				409,
				tag("SecurityAuditRunNotInProgressError"),
			])
			expect([cancel.body.status, cancel.body.incompleteReason, cancel.body.finishedAt > 0]).toEqual([
				"incomplete",
				"cancelled",
				true,
			])
			// Terminated once; the second call found the run finished and never reached the workflow.
			expect(harness.cancelled).toEqual([run.body.id])
			expect(
				events.body.events.map((e: { kind: string; message: string }) => [e.kind, e.message]),
			).toEqual([["Note", `Run cancelled by ${USER}`]])
			// The cancelled run frees the target.
			expect(next.status).toBe(200)
			expect(audit.map((entry) => [entry.userId, entry.metadata])).toEqual([
				[USER, { targetId: target.body.id, runId: run.body.id }],
			])
		} finally {
			await harness.dispose()
		}
	})

	it("refuses a run that already finished, and a run of another org, without touching the workflow", async () => {
		const harness = makeHarness()
		try {
			const target = await harness.call("POST", "/targets", { body: TARGET })
			const run = await harness.call("POST", `/targets/${target.body.id}/runs`, { body: {} })
			const foreign = await harness.call("POST", `/runs/${run.body.id}/cancel`, {
				as: `${ORG_B}|org:admin`,
			})
			await harness.withStore((store) =>
				store.forOrg(ORG_A).finishRun(run.body.id, { status: "complete" }),
			)
			const finished = await harness.call("POST", `/runs/${run.body.id}/cancel`)
			const detail = await harness.call("GET", `/runs/${run.body.id}`)

			expect([foreign.status, foreign.body._tag, finished.status, finished.body._tag]).toEqual([
				404,
				tag("SecurityAuditRunNotFoundError"),
				409,
				tag("SecurityAuditRunNotInProgressError"),
			])
			expect([detail.body.status, detail.body.incompleteReason, harness.cancelled]).toEqual([
				"complete",
				null,
				[],
			])
		} finally {
			await harness.dispose()
		}
	})

	it("leaves the run running when its workflow cannot be terminated", async () => {
		const harness = makeHarness({ cancelFails: true })
		try {
			const target = await harness.call("POST", "/targets", { body: TARGET })
			const run = await harness.call("POST", `/targets/${target.body.id}/runs`, { body: {} })
			const cancel = await harness.call("POST", `/runs/${run.body.id}/cancel`)
			const detail = await harness.call("GET", `/runs/${run.body.id}`)

			expect([cancel.status, cancel.body._tag, detail.body.status]).toEqual([
				503,
				tag("SecurityAuditPersistenceError"),
				"in_progress",
			])
		} finally {
			await harness.dispose()
		}
	})
})

describe("/api/security-audit run units", () => {
	it("lists the run's units leanly, keeps a malformed stored unit, and is admin and org scoped", async () => {
		const harness = makeHarness()
		try {
			const target = await harness.call("POST", "/targets", { body: TARGET })
			const run = await harness.call("POST", `/targets/${target.body.id}/runs`, { body: {} })
			await harness.sql(
				`INSERT INTO security_audit_units (run_id, coverage_id, org_id, status, wave, agent_id, unit)
				 VALUES ($1, 'u1', $2, 'candidate', 2, 'hunter-1', $3::jsonb),
				        ($1, 'u2', $2, 'blocked', 1, null, '{"coverage_id":"u2"}'::jsonb)`,
				[
					run.body.id,
					ORG_A,
					JSON.stringify({
						coverage_id: "u1",
						canonical_refs: { surface: "s", boundary: "b", subsystem: "sub", attack_class: "ac" },
						surface: "POST /keys",
						boundary: "org scope",
						subsystem: "src",
						attack_class: "Access control",
						starting_paths: ["src/routes/keys.ts"],
						ordinary_attack_class_block: null,
						selected_companion_blocks: [],
						excluded_blocks: [],
						prior_status: "none",
						attempts: [],
						wave: 2,
						status: "candidate",
						agent_id: "hunter-1",
						reviewed_paths: [],
						local_checks: [],
						result_fingerprints: ["keys/roll"],
						unresolved: ["x".repeat(500)],
						priority: 1,
					}),
				],
			)
			const units = await harness.call("GET", `/runs/${run.body.id}/units`)
			const member = await harness.call("GET", `/runs/${run.body.id}/units`, {
				as: `${ORG_A}|org:member`,
			})
			const foreign = await harness.call("GET", `/runs/${run.body.id}/units`, {
				as: `${ORG_B}|org:admin`,
			})

			expect(units.status).toBe(200)
			expect(units.body.units).toEqual([
				{
					coverageId: "u1",
					status: "candidate",
					wave: 2,
					agentId: "hunter-1",
					stale: false,
					subsystem: "src",
					surface: "POST /keys",
					boundary: "org scope",
					attackClass: "Access control",
					priorStatus: "none",
					priority: 1,
					failedAttempts: null,
					resultFingerprints: ["keys/roll"],
					carriedFingerprint: null,
					unresolved: ["x".repeat(300)],
				},
				{
					coverageId: "u2",
					status: "blocked",
					wave: 1,
					agentId: null,
					stale: true,
					subsystem: null,
					surface: null,
					boundary: null,
					attackClass: null,
					priorStatus: null,
					priority: null,
					failedAttempts: null,
					resultFingerprints: [],
					carriedFingerprint: null,
					unresolved: [],
				},
			])
			expect([member.status, foreign.status, foreign.body._tag]).toEqual([
				403,
				404,
				tag("SecurityAuditRunNotFoundError"),
			])
		} finally {
			await harness.dispose()
		}
	})
})

describe("/api/security-audit cancellation of an unsettled run", () => {
	it("cancels a run the engine already marked complete before settle, and reports its spend", async () => {
		const harness = makeHarness()
		try {
			const target = await harness.call("POST", "/targets", { body: TARGET })
			const run = await harness.call("POST", `/targets/${target.body.id}/runs`, { body: {} })
			await harness.withStore((store) =>
				store.forOrg(ORG_A).recordEvent(run.body.id, {
					_tag: "Agent",
					role: "hunter",
					agentId: "hunter-1",
					outcome: "ok",
					usage: { inputTokens: 120, outputTokens: 12, costUsd: 0.4 },
				}),
			)
			// The engine's own status, written before its settle step runs.
			await harness.sql(`UPDATE security_audit_runs SET status = 'complete' WHERE id = $1`, [
				run.body.id,
			])
			const whileUnsettled = await harness.call("POST", `/targets/${target.body.id}/runs`, { body: {} })
			const cancel = await harness.call("POST", `/runs/${run.body.id}/cancel`)

			expect([whileUnsettled.status, whileUnsettled.body._tag]).toEqual([
				409,
				tag("SecurityAuditRunInProgressError"),
			])
			expect([
				cancel.status,
				cancel.body.incompleteReason,
				cancel.body.invocationsSpent,
				cancel.body.inputTokens,
				cancel.body.outputTokens,
				cancel.body.costUsd,
			]).toEqual([200, "cancelled", 1, 120, 12, 0.4])
		} finally {
			await harness.dispose()
		}
	})
})

describe("/api/security-audit unit payload", () => {
	it("caps a unit's result fingerprints", async () => {
		const harness = makeHarness()
		try {
			const target = await harness.call("POST", "/targets", { body: TARGET })
			const run = await harness.call("POST", `/targets/${target.body.id}/runs`, { body: {} })
			const fingerprints = Array.from({ length: 25 }, (_, i) => `f${i}`)
			await harness.sql(
				`INSERT INTO security_audit_units (run_id, coverage_id, org_id, status, wave, agent_id, unit)
				 VALUES ($1, 'u1', $2, 'candidate', 1, null, $3::jsonb)`,
				[
					run.body.id,
					ORG_A,
					JSON.stringify({
						subsystem: "src",
						surface: "POST /keys",
						boundary: "org scope",
						attack_class: "Access control",
						prior_status: "none",
						result_fingerprints: fingerprints,
						unresolved: [],
					}),
				],
			)
			const units = await harness.call("GET", `/runs/${run.body.id}/units`)

			expect([units.body.units[0].stale, units.body.units[0].resultFingerprints]).toEqual([
				false,
				fingerprints.slice(0, 20),
			])
		} finally {
			await harness.dispose()
		}
	})
})
