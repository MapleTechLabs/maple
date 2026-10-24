import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId, UserId } from "@maple/domain/primitives"
import { VcsRepositoryId } from "@maple/domain/http/vcs"
import type { SecurityAuditRunId, SecurityAuditTargetId } from "@maple/domain/security-audit"
import type { AgentUsage, AuditEvent, CoverageUnit, Finding, RunMetadata } from "@maple/security-audit"
import { Effect, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { SecurityAuditStore, type SecurityAuditStoreApi } from "./SecurityAuditStore"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const orgA = Schema.decodeUnknownSync(OrgId)("org_a")
const orgB = Schema.decodeUnknownSync(OrgId)("org_b")
const user = Schema.decodeUnknownSync(UserId)("user_a")

const withStore = <A, E>(body: (store: SecurityAuditStoreApi) => Effect.Effect<A, E>) =>
	Effect.gen(function* () {
		const store = yield* SecurityAuditStore
		return yield* body(store)
	}).pipe(Effect.provide(SecurityAuditStore.layer.pipe(Layer.provide(createTestDb(trackedDbs).layer))))

const confirmed = (fingerprint: string, overall: "low" | "high" = "high"): Finding => ({
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
		overall_severity: overall,
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

const unit = (coverageId: string, status: CoverageUnit["status"], wave: number): CoverageUnit => ({
	coverage_id: coverageId,
	canonical_refs: { surface: "s", boundary: "b", subsystem: "sub", attack_class: "ac" },
	surface: "s",
	boundary: "b",
	subsystem: "sub",
	attack_class: "ac",
	starting_paths: ["src/a.ts"],
	ordinary_attack_class_block: null,
	selected_companion_blocks: [],
	excluded_blocks: [],
	prior_status: "none",
	attempts: [],
	wave,
	status,
	agent_id: status === "planned" ? null : `hunter-${coverageId}`,
	reviewed_paths: [],
	local_checks: [],
	result_fingerprints: [],
	unresolved: [],
})

/** A target in `org` with one run started at `sourceRef`; returns the target and run ids. */
const seedRun = (
	store: SecurityAuditStoreApi,
	org: OrgId,
	sourceRef: string,
	targetId?: SecurityAuditTargetId,
) =>
	Effect.gen(function* () {
		const scoped = store.forOrg(org)
		const target =
			targetId ??
			(yield* scoped.createTarget({ repository: "acme/api", branch: "main", createdBy: user })).id
		// One run in progress per target: the earlier one finishes before the next starts.
		const running = yield* scoped.listRuns({ targetId: target, statuses: ["in_progress"] })
		yield* Effect.forEach(running, (r) => scoped.finishRun(r.id, { status: "complete" }), {
			discard: true,
		})
		const run = yield* scoped.startRun({ targetId: target, kind: "baseline", sourceRef })
		return { targetId: target, runId: run.id }
	})

/** What a run that ran to its end leaves behind: metadata, reports and a ledger. */
const persistRunState = (
	store: SecurityAuditStoreApi,
	org: OrgId,
	runId: SecurityAuditRunId,
	scopePaths: ReadonlyArray<string> = [],
) =>
	Effect.gen(function* () {
		const scoped = store.forOrg(org)
		yield* scoped.saveMetadata({
			run_id: runId,
			repo: "acme/api",
			target: "acme/api@main",
			source_ref: "sha-1",
			profile: "deep",
			scope_paths: scopePaths,
			budget: 40,
			execution_policy: "sandboxed-source-and-local-only",
			execution: { _tag: "Unavailable", blocker: "no sandbox" },
			prior_runs: [],
			run_status: "complete",
		})
		yield* scoped.saveReports(runId, { report: "r", findingsDetail: "d", needsValidation: "n" })
		yield* scoped.saveLedger(runId, [unit("u1", "covered", 1)])
	})

describe("SecurityAuditStore ledger", () => {
	it.effect("replaces the run's units on every save, so a replayed save changes nothing", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const { runId } = yield* seedRun(store, orgA, "sha-1")
				const scoped = store.forOrg(orgA)
				yield* scoped.saveLedger(runId, [unit("u1", "planned", 1), unit("u2", "planned", 1)])
				const next = [unit("u1", "covered", 1), unit("u3", "in_progress", 2)]
				yield* scoped.saveLedger(runId, next)
				yield* scoped.saveLedger(runId, next)
				const units = yield* scoped.listUnits(runId)
				assert.deepStrictEqual(
					units.map((u) => [u.coverageId, u.status, u.wave, u.agentId]),
					[
						["u1", "covered", 1, "hunter-u1"],
						["u3", "in_progress", 2, "hunter-u3"],
					],
				)
				assert.deepStrictEqual(units[1]?.unit, next[1])
			}),
		),
	)
})

describe("SecurityAuditStore findings lifecycle", () => {
	it.effect("opens new fingerprints and keeps them open while later runs still find them", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const scoped = store.forOrg(orgA)
				const first = yield* seedRun(store, orgA, "sha-1")
				yield* scoped.saveFindings(first.runId, [confirmed("f1", "high"), rejected("f2")])
				const second = yield* seedRun(store, orgA, "sha-2", first.targetId)
				yield* scoped.saveFindings(second.runId, [confirmed("f1", "low")])

				const findings = yield* scoped.listFindings(first.targetId)
				const f1 = findings.find((f) => f.fingerprint === "f1")
				assert.deepStrictEqual(
					[
						f1?.status,
						f1?.overallSeverity,
						f1?.firstSeenRunId,
						f1?.lastSeenRunId,
						f1?.firstSeenRef,
						f1?.lastSeenRef,
					],
					["open", "low", first.runId, second.runId, "sha-1", "sha-2"],
				)
				const f2 = findings.find((f) => f.fingerprint === "f2")
				assert.deepStrictEqual(
					[f2?.verdict, f2?.overallSeverity, f2?.lastSeenRunId],
					["rejected", null, first.runId],
				)
			}),
		),
	)

	it.effect("reopens a fixed finding that comes back, but never a dismissed or accepted one", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const scoped = store.forOrg(orgA)
				const first = yield* seedRun(store, orgA, "sha-1")
				yield* scoped.saveFindings(first.runId, [
					confirmed("fixed"),
					confirmed("dismissed"),
					confirmed("accepted"),
				])
				const revalidation = yield* seedRun(store, orgA, "sha-2", first.targetId)
				const marked = yield* scoped.markFixed(
					first.targetId,
					["fixed", "dismissed"],
					revalidation.runId,
				)
				// The dismissal and the acceptance are a person's decision, made outside the engine.
				const db = trackedDbs[0]
				assert.isDefined(db)
				yield* Effect.promise(() =>
					db.pglite.query(
						`UPDATE security_audit_findings SET status = CASE fingerprint WHEN 'dismissed' THEN 'dismissed' ELSE 'accepted_risk' END WHERE fingerprint IN ('dismissed', 'accepted')`,
					),
				)
				const afterFix = yield* scoped.listFindings(first.targetId)
				assert.deepStrictEqual(
					[marked, afterFix.find((f) => f.fingerprint === "fixed")?.fixedRunId],
					[2, revalidation.runId],
				)

				const regression = yield* seedRun(store, orgA, "sha-3", first.targetId)
				yield* scoped.saveFindings(regression.runId, [
					confirmed("fixed"),
					confirmed("dismissed"),
					confirmed("accepted"),
				])
				const findings = yield* scoped.listFindings(first.targetId)
				assert.deepStrictEqual(
					Object.fromEntries(
						findings.map((f) => [f.fingerprint, [f.status, f.fixedRunId, f.lastSeenRef]]),
					),
					{
						fixed: ["open", null, "sha-3"],
						dismissed: ["dismissed", revalidation.runId, "sha-3"],
						accepted: ["accepted_risk", null, "sha-3"],
					},
				)
			}),
		),
	)

	it.effect("a resave of the run replaces its findings and drops lifecycle rows only it had opened", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const scoped = store.forOrg(orgA)
				const first = yield* seedRun(store, orgA, "sha-1")
				yield* scoped.saveFindings(first.runId, [confirmed("kept")])
				const second = yield* seedRun(store, orgA, "sha-2", first.targetId)
				yield* scoped.saveFindings(second.runId, [confirmed("kept"), confirmed("draft")])
				yield* scoped.saveFindings(second.runId, [confirmed("kept")])
				const findings = yield* scoped.listFindings(first.targetId)
				assert.deepStrictEqual(
					findings.map((f) => [f.fingerprint, f.firstSeenRunId]),
					[["kept", first.runId]],
				)
			}),
		),
	)
})

describe("SecurityAuditStore triage survives a resave", () => {
	it.effect("a resave that drops a finding this run opened keeps it once a person triaged it", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const scoped = store.forOrg(orgA)
				const run = yield* seedRun(store, orgA, "sha-1")
				yield* scoped.saveFindings(run.runId, [confirmed("triaged"), confirmed("draft")])
				const db = trackedDbs[0]
				assert.isDefined(db)
				yield* Effect.promise(() =>
					db.pglite.query(
						`UPDATE security_audit_findings SET status = 'dismissed' WHERE fingerprint = 'triaged'`,
					),
				)
				yield* scoped.saveFindings(run.runId, [])
				const findings = yield* scoped.listFindings(run.targetId)
				assert.deepStrictEqual(
					findings.map((f) => [f.fingerprint, f.status]),
					[["triaged", "dismissed"]],
				)
			}),
		),
	)
})

describe("SecurityAuditStore runs and events", () => {
	it.effect("appends events in order, keeping each agent's usage", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const scoped = store.forOrg(orgA)
				const { runId } = yield* seedRun(store, orgA, "sha-1")
				yield* scoped.recordEvent(runId, { _tag: "Phase", phase: "recon", detail: "4 agents" })
				yield* TestClock.adjust("1 millis")
				yield* scoped.recordEvent(runId, {
					_tag: "Agent",
					role: "hunter",
					agentId: "hunter-u1",
					outcome: "ok",
					usage: { inputTokens: 1200, outputTokens: 300, costUsd: 0.25 },
				})
				// Events in one millisecond order by id; these are sequential in time.
				yield* TestClock.adjust("1 millis")
				yield* scoped.recordEvent(runId, { _tag: "Note", message: "budget reserved" })
				const events = yield* scoped.listEvents(runId)
				assert.deepStrictEqual(
					events.map((e) => [
						e.kind,
						e.role,
						e.agentId,
						e.outcome,
						e.inputTokens,
						e.outputTokens,
						e.detail,
					]),
					[
						[
							"Phase",
							null,
							null,
							null,
							null,
							null,
							{ message: null, phase: "recon", detail: "4 agents", costUsd: null },
						],
						[
							"Agent",
							"hunter",
							"hunter-u1",
							"ok",
							1200,
							300,
							{ message: null, phase: null, detail: null, costUsd: 0.25 },
						],
						[
							"Note",
							null,
							null,
							null,
							null,
							null,
							{ message: "budget reserved", phase: null, detail: null, costUsd: null },
						],
					],
				)
			}),
		),
	)

	it.effect("carries metadata, usage and the final status onto the run", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const scoped = store.forOrg(orgA)
				const { runId } = yield* seedRun(store, orgA, "sha-1")
				const metadata: RunMetadata = {
					run_id: runId,
					repo: "acme/api",
					target: "acme/api@main",
					source_ref: "sha-1",
					profile: "standard",
					scope_paths: ["src/auth"],
					budget: 40,
					execution_policy: "sandboxed-source-and-local-only",
					execution: { _tag: "Unavailable", blocker: "no sandbox" },
					prior_runs: [],
					run_status: "complete",
				}
				yield* scoped.saveMetadata(metadata)
				// The engine's status is its own; the row stays in progress until the run settles.
				const unsettled = Option.getOrThrow(yield* scoped.getRun(runId))
				assert.deepStrictEqual([unsettled.status, unsettled.finishedAt], ["in_progress", null])
				yield* scoped.saveArchitecture(runId, "# Architecture")
				const usage = { invocations: 3, inputTokens: 150, outputTokens: 15, costUsd: 0.5 }
				// Written twice, as a retried settle step would: totals are set, never added.
				yield* scoped.setUsage(runId, usage)
				yield* scoped.setUsage(runId, usage)
				yield* scoped.finishRun(runId, { status: "incomplete", reason: "budget exhausted" })
				const run = Option.getOrThrow(yield* scoped.getRun(runId))
				assert.deepStrictEqual(
					[run.profile, run.scopePaths, run.budget, run.metadata, run.architectureMd],
					["standard", ["src/auth"], 40, metadata, "# Architecture"],
				)
				assert.deepStrictEqual(
					[run.invocationsSpent, run.inputTokens, run.outputTokens, run.costUsd],
					[3, 150, 15, 0.5],
				)
				assert.deepStrictEqual(
					[run.status, run.incompleteReason, run.finishedAt === null],
					["incomplete", "budget exhausted", false],
				)
			}),
		),
	)

	it.effect("refuses a target that names another org's repository", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const repositoryId = Schema.decodeUnknownSync(VcsRepositoryId)(crypto.randomUUID())
				const refused = yield* Effect.flip(
					store.forOrg(orgA).createTarget({
						repository: "acme/api",
						branch: "main",
						createdBy: user,
						vcsRepositoryId: repositoryId,
					}),
				)
				assert.strictEqual(refused.message, "Repository is not connected to this org")
			}),
		),
	)

	it.effect("a store for one org cannot read or write another org's runs", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const a = yield* seedRun(store, orgA, "sha-1")
				yield* store.forOrg(orgA).saveFindings(a.runId, [confirmed("f1")])
				const other = store.forOrg(orgB)
				const run = yield* other.getRun(a.runId)
				const runs = yield* other.listRuns()
				const findings = yield* other.listFindings(a.targetId)
				const ledgerWrite = yield* Effect.flip(other.saveLedger(a.runId, [unit("u1", "planned", 1)]))
				const findingsWrite = yield* Effect.flip(other.saveFindings(a.runId, []))
				const startOnTarget = yield* Effect.flip(
					other.startRun({ targetId: a.targetId, kind: "manual", sourceRef: "x" }),
				)
				assert.deepStrictEqual([Option.isNone(run), runs.length, findings.length], [true, 0, 0])
				assert.match(ledgerWrite.message, /not found/)
				assert.match(findingsWrite.message, /not found/)
				assert.match(startOnTarget.message, /not found/)
				// Org A's run kept its finding.
				const own = yield* store.forOrg(orgA).listFindings(a.targetId)
				assert.deepStrictEqual(
					own.map((f) => f.fingerprint),
					["f1"],
				)
			}),
		),
	)
})

describe("SecurityAuditStore replays", () => {
	it.effect("a clean resave of a run removes its findings and only the lifecycle rows it opened", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const scoped = store.forOrg(orgA)
				const first = yield* seedRun(store, orgA, "sha-1")
				yield* scoped.saveFindings(first.runId, [confirmed("earlier")])
				const second = yield* seedRun(store, orgA, "sha-2", first.targetId)
				yield* scoped.saveFindings(second.runId, [confirmed("earlier"), confirmed("new")])
				yield* scoped.saveFindings(second.runId, [])
				const db = trackedDbs[0]
				assert.isDefined(db)
				const perRun = yield* Effect.promise(() =>
					db.pglite.query<{ run_id: string; fingerprint: string }>(
						"SELECT run_id, fingerprint FROM security_audit_run_findings ORDER BY run_id, fingerprint",
					),
				)
				const findings = yield* scoped.listFindings(first.targetId)
				assert.deepStrictEqual(
					perRun.rows.map((r) => [r.run_id, r.fingerprint]),
					[[first.runId, "earlier"]],
				)
				assert.deepStrictEqual(
					findings.map((f) => [f.fingerprint, f.firstSeenRunId]),
					[["earlier", first.runId]],
				)
			}),
		),
	)

	it.effect("recording the same event twice, as a replayed step does, stores it once", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const scoped = store.forOrg(orgA)
				const { runId } = yield* seedRun(store, orgA, "sha-1")
				const agent = (outcome: "ok" | "failed"): AuditEvent => ({
					_tag: "Agent",
					role: "critic",
					agentId: "critic-w1",
					outcome,
					usage: { inputTokens: 10, outputTokens: 2 },
				})
				const note: AuditEvent = { _tag: "Note", message: "budget reserved" }
				yield* scoped.recordEvent(runId, agent("ok"))
				// Events in one millisecond order by id; these are sequential in time.
				yield* TestClock.adjust("1 millis")
				yield* scoped.recordEvent(runId, note)
				// Events in one millisecond order by id; these are sequential in time.
				yield* TestClock.adjust("1 millis")
				yield* scoped.recordEvent(runId, agent("ok"))
				// Events in one millisecond order by id; these are sequential in time.
				yield* TestClock.adjust("1 millis")
				yield* scoped.recordEvent(runId, note)
				// Events in one millisecond order by id; these are sequential in time.
				yield* TestClock.adjust("1 millis")
				yield* scoped.recordEvent(runId, agent("failed"))
				const events = yield* scoped.listEvents(runId)
				assert.deepStrictEqual(
					events.map((e) => [e.kind, e.agentId, e.outcome]),
					[
						["Agent", "critic-w1", "ok"],
						["Note", null, null],
						["Agent", "critic-w1", "failed"],
					],
				)
			}),
		),
	)
})

describe("SecurityAuditStore triage", () => {
	it.effect("a dismissal keeps its reason and actor, survives the next run, and is org-scoped", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const scoped = store.forOrg(orgA)
				const first = yield* seedRun(store, orgA, "sha-1")
				yield* scoped.saveFindings(first.runId, [confirmed("f1"), confirmed("f2")])

				const foreign = yield* store
					.forOrg(orgB)
					.setFindingStatus(first.targetId, "f1", "accepted_risk", "not ours", user)
				const dismissed = yield* scoped.setFindingStatus(
					first.targetId,
					"f1",
					"dismissed",
					"test fixture only",
					user,
				)
				const missing = yield* scoped.setFindingStatus(first.targetId, "nope", "dismissed", "x", user)

				const next = yield* seedRun(store, orgA, "sha-2", first.targetId)
				yield* scoped.saveFindings(next.runId, [confirmed("f1"), confirmed("f2")])
				const findings = yield* scoped.listFindings(first.targetId)

				assert.deepStrictEqual(
					[Option.isNone(foreign), Option.isNone(missing), Option.map(dismissed, (f) => f.status)],
					[true, true, Option.some("dismissed")],
				)
				assert.deepStrictEqual(
					findings.map((f) => [f.fingerprint, f.status, f.statusReason, f.statusChangedBy]),
					[
						["f1", "dismissed", "test fixture only", user],
						["f2", "open", null, null],
					],
				)
			}),
		),
	)

	it.effect("reopening a fixed finding drops the run that fixed it", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const scoped = store.forOrg(orgA)
				const first = yield* seedRun(store, orgA, "sha-1")
				yield* scoped.saveFindings(first.runId, [confirmed("f1")])
				const revalidation = yield* seedRun(store, orgA, "sha-2", first.targetId)
				yield* scoped.markFixed(first.targetId, ["f1"], revalidation.runId)

				yield* scoped.setFindingStatus(first.targetId, "f1", "open", "still reproduces", user)
				const findings = yield* scoped.listFindings(first.targetId)

				assert.deepStrictEqual(
					findings.map((f) => [f.fingerprint, f.status, f.fixedRunId]),
					[["f1", "open", null]],
				)
			}),
		),
	)

	it.effect("lists the org's targets and runs by status, never another org's", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const scoped = store.forOrg(orgA)
				// Each run settles before the next starts: a settled run keeps its first outcome.
				const done = yield* seedRun(store, orgA, "sha-1")
				yield* scoped.finishRun(done.runId, { status: "complete" })
				const failed = yield* seedRun(store, orgA, "sha-2", done.targetId)
				yield* scoped.finishRun(failed.runId, { status: "failed", error: "boom" })
				yield* seedRun(store, orgA, "sha-3", done.targetId)
				const other = yield* seedRun(store, orgB, "sha-1")

				const finished = yield* scoped.listRuns({
					targetId: done.targetId,
					statuses: ["complete", "incomplete"],
				})
				const targets = yield* scoped.listTargets()
				const foreignTarget = yield* scoped.getTarget(other.targetId)

				assert.deepStrictEqual(
					[finished.map((r) => r.id), targets.map((t) => t.id), Option.isNone(foreignTarget)],
					[[done.runId], [done.targetId], true],
				)
			}),
		),
	)
})

describe("SecurityAuditStore tolerant readers", () => {
	it.effect("skips stored units and findings an older schema wrote, keeping the rest", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const scoped = store.forOrg(orgA)
				const { targetId, runId } = yield* seedRun(store, orgA, "sha-1")
				yield* scoped.saveLedger(runId, [unit("u1", "covered", 1)])
				yield* scoped.saveFindings(runId, [confirmed("f1"), confirmed("f2")])
				const db = trackedDbs[0]
				assert.isDefined(db)
				// Shapes an earlier skill version wrote: a unit without its refs, a finding without a verdict.
				yield* Effect.promise(() =>
					db.pglite.query(
						`INSERT INTO security_audit_units (run_id, coverage_id, org_id, status, wave, agent_id, unit)
						 VALUES ($1, 'u0', $2, 'covered', 1, null, '{"coverage_id":"u0"}'::jsonb)`,
						[runId, orgA],
					),
				)
				yield* Effect.promise(() =>
					db.pglite.query(
						`INSERT INTO security_audit_run_findings (run_id, fingerprint, org_id, verdict, overall_severity, record)
						 VALUES ($1, 'f0', $2, 'confirmed', 'high', '{"fingerprint":"f0","title":"old"}'::jsonb)`,
						[runId, orgA],
					),
				)
				yield* Effect.promise(() =>
					db.pglite.query(
						`UPDATE security_audit_findings SET record = '{"fingerprint":"f2"}'::jsonb WHERE fingerprint = 'f2'`,
					),
				)

				const units = yield* scoped.listUnits(runId)
				const runFindings = yield* scoped.listRunFindings(runId)
				const findings = yield* scoped.listFindings(targetId)

				assert.deepStrictEqual(
					[
						units.map((u) => u.coverageId),
						runFindings.map((f) => f.fingerprint),
						findings.map((f) => f.fingerprint),
					],
					[["u1"], ["f1", "f2"], ["f1"]],
				)
			}),
		),
	)
})

describe("SecurityAuditStore large ledgers", () => {
	it.effect("saves and resaves a ledger beyond one statement's bind limit", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const scoped = store.forOrg(orgA)
				const { runId } = yield* seedRun(store, orgA, "sha-1")
				const ledger = Array.from({ length: 1_200 }, (_, i) => unit(`u${i}`, "planned", 1))
				yield* scoped.saveLedger(runId, ledger)
				yield* scoped.saveLedger(
					runId,
					ledger.map((u) => unit(u.coverage_id, "covered", 1)),
				)
				const units = yield* scoped.listUnits(runId)
				assert.deepStrictEqual(
					[units.length, new Set(units.map((u) => u.status))],
					[1_200, new Set(["covered"])],
				)
			}),
		),
	)
})

/** Raw SQL against the store's database, for rows an older schema or a person wrote. */
const rawSql = (sql: string, params: Array<unknown> = []) =>
	Effect.promise(() => trackedDbs[0]?.pglite.query(sql, params) ?? Promise.resolve(undefined))

describe("SecurityAuditStore run admission", () => {
	it.effect("runs one at a time per target, replays a start, and refuses a disabled target", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const scoped = store.forOrg(orgA)
				const { targetId, runId } = yield* seedRun(store, orgA, "sha-1")
				const replay = yield* scoped.startRun({ runId, targetId, kind: "manual", sourceRef: "x" })
				const second = yield* Effect.flip(
					scoped.startRun({ targetId, kind: "manual", sourceRef: "sha-2" }),
				)
				yield* scoped.finishRun(runId, { status: "complete" })
				yield* rawSql(`UPDATE security_audit_targets SET enabled = false WHERE id = $1`, [targetId])
				const disabled = yield* Effect.flip(
					scoped.startRun({ targetId, kind: "manual", sourceRef: "sha-3" }),
				)
				assert.deepStrictEqual(
					[replay.id, replay.sourceRef, second._tag, disabled._tag],
					[
						runId,
						"sha-1",
						"@maple/backend/security-audit/RunInProgress",
						"@maple/backend/security-audit/TargetDisabled",
					],
				)
			}),
		),
	)

	it.effect("frees a target whose running run was abandoned for more than 48 hours", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const scoped = store.forOrg(orgA)
				const { targetId, runId } = yield* seedRun(store, orgA, "sha-1")
				yield* TestClock.adjust("47 hours")
				const early = yield* Effect.flip(
					scoped.startRun({ targetId, kind: "manual", sourceRef: "sha-2" }),
				)
				yield* TestClock.adjust("2 hours")
				const next = yield* scoped.startRun({ targetId, kind: "manual", sourceRef: "sha-3" })
				const abandoned = Option.getOrThrow(yield* scoped.getRun(runId))
				assert.deepStrictEqual(
					[early._tag, next.status, abandoned.status, abandoned.finishedAt === null],
					["@maple/backend/security-audit/RunInProgress", "in_progress", "failed", false],
				)
			}),
		),
	)

	it.effect("keeps a long run that is still recording events", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const scoped = store.forOrg(orgA)
				const { targetId, runId } = yield* seedRun(store, orgA, "sha-1")
				yield* TestClock.adjust("47 hours")
				yield* scoped.recordEvent(runId, { _tag: "Note", message: "still hunting" })
				yield* TestClock.adjust("2 hours")
				const refused = yield* Effect.flip(
					scoped.startRun({ targetId, kind: "manual", sourceRef: "sha-2" }),
				)
				const live = Option.getOrThrow(yield* scoped.getRun(runId))
				assert.deepStrictEqual(
					[refused._tag, live.status, live.finishedAt],
					["@maple/backend/security-audit/RunInProgress", "in_progress", null],
				)
			}),
		),
	)

	it.effect("refuses a second target for the same repository branch in the org only", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const input = { repository: "acme/api", branch: "main", createdBy: user }
				yield* store.forOrg(orgA).createTarget(input)
				const duplicate = yield* Effect.flip(store.forOrg(orgA).createTarget(input))
				const otherBranch = yield* store.forOrg(orgA).createTarget({ ...input, branch: "next" })
				const otherOrg = yield* store.forOrg(orgB).createTarget(input)
				assert.deepStrictEqual(
					[duplicate._tag, otherBranch.branch, otherOrg.orgId],
					["@maple/backend/security-audit/TargetExists", "next", orgB],
				)
			}),
		),
	)

	it.effect("carries forward the latest unscoped finished run, else the latest finished", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const scoped = store.forOrg(orgA)
				const target = yield* scoped.createTarget({
					repository: "acme/api",
					branch: "main",
					createdBy: user,
				})
				const start = (scopePaths: ReadonlyArray<string>, finish: boolean) =>
					Effect.gen(function* () {
						const run = yield* scoped.startRun({
							targetId: target.id,
							kind: "manual",
							sourceRef: "main",
							scopePaths,
						})
						if (finish) {
							yield* persistRunState(store, orgA, run.id, scopePaths)
							yield* scoped.finishRun(run.id, { status: "complete" })
						}
						return run.id
					})
				const none = yield* scoped.latestPriorRun(target.id)
				const scopedOnly = yield* start(["apps/api"], true)
				const onlyScoped = yield* scoped.latestPriorRun(target.id)
				const whole = yield* start([], true)
				yield* start(["apps/web"], true)
				yield* start([], false)
				const preferred = yield* scoped.latestPriorRun(target.id)
				assert.deepStrictEqual(
					[
						Option.isNone(none),
						Option.map(onlyScoped, (r) => r.id),
						Option.map(preferred, (r) => r.id),
					],
					[true, Option.some(scopedOnly), Option.some(whole)],
				)
			}),
		),
	)

	it.effect("skips cancelled runs and runs that never saved a ledger or reports", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const scoped = store.forOrg(orgA)
				const usable = yield* seedRun(store, orgA, "sha-1")
				yield* persistRunState(store, orgA, usable.runId)
				yield* scoped.finishRun(usable.runId, { status: "complete" })
				// Partial state, then cancelled: newer, but its ledger says nothing about what is fixed.
				const cancelled = yield* seedRun(store, orgA, "sha-2", usable.targetId)
				yield* persistRunState(store, orgA, cancelled.runId)
				yield* scoped.cancelRun(cancelled.runId, user)
				// Finished without ever saving its ledger or reports.
				const empty = yield* seedRun(store, orgA, "sha-3", usable.targetId)
				yield* scoped.finishRun(empty.runId, { status: "incomplete", reason: "budget_exhausted" })
				const prior = yield* scoped.latestPriorRun(usable.targetId)
				assert.deepStrictEqual(
					Option.map(prior, (r) => r.id),
					Option.some(usable.runId),
				)
			}),
		),
	)
})

describe("SecurityAuditStore lenient run and event reads", () => {
	it.effect("reads an older metadata, reports or event detail shape as null instead of failing", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const scoped = store.forOrg(orgA)
				const { targetId, runId } = yield* seedRun(store, orgA, "sha-1")
				yield* scoped.saveReports(runId, { report: "r", findingsDetail: "d", needsValidation: "n" })
				yield* scoped.recordEvent(runId, { _tag: "Note", message: "kept" })
				yield* scoped.recordEvent(runId, { _tag: "Note", message: "old" })
				yield* rawSql(
					`UPDATE security_audit_runs SET metadata = '{"run_id":1}'::jsonb, reports = '{"report":["old"]}'::jsonb WHERE id = $1`,
					[runId],
				)
				yield* rawSql(
					`UPDATE security_audit_events SET detail = '{"text":"old"}'::jsonb WHERE detail->>'message' = 'old'`,
				)
				const run = yield* scoped.getRun(runId)
				const runs = yield* scoped.listRuns({ targetId })
				const events = yield* scoped.listEvents(runId)
				assert.deepStrictEqual(
					[
						Option.map(run, (r) => [r.metadata, r.reports]),
						runs.map((r) => r.reports),
						events.map((e) => e.detail?.message ?? null).toSorted(),
					],
					[Option.some([null, null]), [null], ["kept", null]],
				)
			}),
		),
	)

	it.effect("triages a finding whose stored record predates the current schema", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const scoped = store.forOrg(orgA)
				const { targetId, runId } = yield* seedRun(store, orgA, "sha-1")
				yield* scoped.saveFindings(runId, [confirmed("f1")])
				yield* rawSql(
					`UPDATE security_audit_findings SET record = '{"old":true}'::jsonb WHERE fingerprint = 'f1'`,
				)
				const triaged = yield* scoped.setFindingStatus(
					targetId,
					"f1",
					"dismissed",
					"duplicate of f0",
					user,
				)
				const missing = yield* scoped.setFindingStatus(targetId, "nope", "dismissed", "x", user)
				assert.deepStrictEqual(
					[Option.map(triaged, (t) => [t.status, t.statusReason]), Option.isNone(missing)],
					[Option.some(["dismissed", "duplicate of f0"]), true],
				)
			}),
		),
	)

	it.effect("pages events newest first by `beforeAt` and counts units by status in SQL", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const scoped = store.forOrg(orgA)
				const { runId } = yield* seedRun(store, orgA, "sha-1")
				yield* Effect.forEach(
					[1, 2, 3, 4, 5],
					(i) =>
						rawSql(
							`INSERT INTO security_audit_events (id, run_id, org_id, at, kind, detail)
							 VALUES ($1, $2, $3, to_timestamp($4), 'Note', $5::jsonb)`,
							[
								`e${i}`,
								runId,
								orgA,
								i,
								JSON.stringify({
									message: `m${i}`,
									phase: null,
									detail: null,
									costUsd: null,
								}),
							],
						),
					{ discard: true },
				)
				yield* scoped.saveLedger(runId, [
					unit("u1", "covered", 1),
					unit("u2", "covered", 1),
					unit("u3", "planned", 1),
				])
				const newest = yield* scoped.listEvents(runId, { limit: 2 })
				const older = yield* scoped.listEvents(runId, { limit: 2, beforeAt: newest[0]?.at ?? 0 })
				const counts = yield* scoped.countUnits(runId)
				assert.deepStrictEqual(
					[newest.map((e) => e.id), older.map((e) => e.id), counts],
					[["e4", "e5"], ["e2", "e3"], { covered: 2, planned: 1 }],
				)
			}),
		),
	)
})

describe("SecurityAuditStore cancellation", () => {
	it.effect("cancels an in-progress run once, records who did it, and refuses a finished run", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const scoped = store.forOrg(orgA)
				const done = yield* seedRun(store, orgA, "sha-1")
				yield* scoped.finishRun(done.runId, { status: "complete" })
				const { runId } = yield* seedRun(store, orgA, "sha-2", done.targetId)

				const cancelled = yield* scoped.cancelRun(runId, user)
				const again = yield* scoped.cancelRun(runId, user)
				const finished = yield* scoped.cancelRun(done.runId, user)
				const foreign = yield* store.forOrg(orgB).cancelRun(done.runId, user)
				const events = yield* scoped.listEvents(runId)

				assert.deepStrictEqual(
					Option.map(cancelled, (r) => [r.status, r.incompleteReason, r.finishedAt === null]),
					Option.some(["incomplete", "cancelled", false]),
				)
				assert.deepStrictEqual(
					[Option.isNone(again), Option.isNone(finished), Option.isNone(foreign)],
					[true, true, true],
				)
				assert.deepStrictEqual(
					events.map((e) => [e.kind, e.detail?.message]),
					[["Note", `Run cancelled by ${user}`]],
				)
			}),
		),
	)

	it.effect("keeps a cancelled run cancelled when a late settle or metadata write arrives", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const scoped = store.forOrg(orgA)
				const { runId } = yield* seedRun(store, orgA, "sha-1")
				yield* scoped.cancelRun(runId, user)
				yield* scoped.saveMetadata({
					run_id: runId,
					repo: "acme/api",
					target: "acme/api@main",
					source_ref: "sha-1",
					profile: "deep",
					scope_paths: [],
					budget: 40,
					execution_policy: "sandboxed-source-and-local-only",
					execution: { _tag: "Unavailable", blocker: "no sandbox" },
					prior_runs: [],
					run_status: "complete",
				})
				yield* scoped.finishRun(runId, { status: "complete" })
				yield* scoped.finishRun(runId, { status: "failed", error: "interrupted" })
				const missing = yield* Effect.flip(
					scoped.finishRun(crypto.randomUUID(), { status: "complete" }),
				)

				const run = Option.getOrThrow(yield* scoped.getRun(runId))
				assert.deepStrictEqual(
					[run.status, run.incompleteReason, run.error, run.metadata],
					["incomplete", "cancelled", null, null],
				)
				assert.include(missing.message, "not found")
			}),
		),
	)
})

describe("SecurityAuditStore unit summaries", () => {
	it.effect("lists every unit leanly, keeping one stored under an older shape with null fields", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const scoped = store.forOrg(orgA)
				const { runId } = yield* seedRun(store, orgA, "sha-1")
				yield* scoped.saveLedger(runId, [
					{ ...unit("u1", "candidate", 2), priority: 3, result_fingerprints: ["f1"] },
				])
				const db = trackedDbs[0]
				assert.isDefined(db)
				yield* Effect.promise(() =>
					db.pglite.query(
						`INSERT INTO security_audit_units (run_id, coverage_id, org_id, status, wave, agent_id, unit)
						 VALUES ($1, 'u0', $2, 'blocked', 1, null, '{"coverage_id":"u0"}'::jsonb),
						        ($1, 'u9', $2, 'not-a-status', 1, null, '{"coverage_id":"u9"}'::jsonb)`,
						[runId, orgA],
					),
				)

				const units = yield* scoped.listUnitSummaries(runId)
				const foreign = yield* store.forOrg(orgB).listUnitSummaries(runId)

				assert.deepStrictEqual(
					units.map((u) => [u.coverageId, u.status, u.wave, u.fields?.subsystem ?? null]),
					[
						["u0", "blocked", 1, null],
						["u1", "candidate", 2, "sub"],
					],
				)
				assert.deepStrictEqual(
					[units[1]?.fields?.priority, units[1]?.fields?.result_fingerprints, foreign],
					[3, ["f1"], []],
				)
			}),
		),
	)
})

describe("SecurityAuditStore writes after a run finished", () => {
	it.effect("turns every engine write to a cancelled run into a no-op, never an error", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const scoped = store.forOrg(orgA)
				const prior = yield* seedRun(store, orgA, "sha-1")
				yield* scoped.saveFindings(prior.runId, [confirmed("f1")])
				yield* scoped.finishRun(prior.runId, { status: "complete" })
				const { runId } = yield* seedRun(store, orgA, "sha-2", prior.targetId)
				yield* scoped.cancelRun(runId, user)

				// A replayed or still-running Workflow keeps writing after the cancel landed.
				yield* scoped.saveLedger(runId, [unit("u1", "covered", 1)])
				yield* scoped.saveFindings(runId, [confirmed("f1", "low"), confirmed("f2")])
				yield* scoped.saveArchitecture(runId, "# late")
				yield* scoped.saveReports(runId, { report: "late", findingsDetail: "", needsValidation: "" })
				yield* scoped.setUsage(runId, {
					invocations: 99,
					inputTokens: 1,
					outputTokens: 1,
					costUsd: 9,
				})
				yield* scoped.recordEvent(runId, { _tag: "Phase", phase: "late", detail: "after cancel" })
				const fixed = yield* scoped.markFixed(prior.targetId, ["f1"], runId)

				const run = Option.getOrThrow(yield* scoped.getRun(runId))
				const findings = yield* scoped.listFindings(prior.targetId)
				assert.deepStrictEqual(
					[
						fixed,
						run.architectureMd,
						run.reports,
						run.invocationsSpent,
						(yield* scoped.listUnits(runId)).length,
						(yield* scoped.listEvents(runId)).map((e) => e.kind),
					],
					[0, null, null, 0, 0, ["Note"]],
				)
				assert.deepStrictEqual(
					findings.map((f) => [f.fingerprint, f.status, f.lastSeenRunId, f.overallSeverity]),
					[["f1", "open", prior.runId, "high"]],
				)
			}),
		),
	)

	it.effect("records a cancelled run's spend from its agents' events", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const scoped = store.forOrg(orgA)
				const { runId } = yield* seedRun(store, orgA, "sha-1")
				const agent = (agentId: string, usage: AgentUsage): AuditEvent => ({
					_tag: "Agent",
					role: "hunter",
					agentId,
					outcome: "ok",
					usage,
				})
				const tokens = { inputTokens: 100, outputTokens: 10 }
				yield* scoped.recordEvent(runId, agent("hunter-1", { ...tokens, costUsd: 0.25 }))
				yield* scoped.recordEvent(runId, agent("hunter-2", { ...tokens, costUsd: 0.5 }))
				// An agent whose price is unknown still counts its invocation and tokens.
				yield* scoped.recordEvent(runId, agent("hunter-3", tokens))
				yield* scoped.recordEvent(runId, { _tag: "Phase", phase: "wave", detail: "1" })

				const cancelled = yield* scoped.cancelRun(runId, user)
				assert.deepStrictEqual(
					Option.map(cancelled, (r) => [
						r.invocationsSpent,
						r.inputTokens,
						r.outputTokens,
						r.costUsd,
					]),
					Option.some([3, 300, 30, 0.75]),
				)
			}),
		),
	)

	it.effect("treats a run the engine marked complete but that has not settled as unfinished", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const scoped = store.forOrg(orgA)
				const { targetId, runId } = yield* seedRun(store, orgA, "sha-1")
				yield* scoped.saveMetadata({
					run_id: runId,
					repo: "acme/api",
					target: "acme/api@main",
					source_ref: "sha-1",
					profile: "deep",
					scope_paths: [],
					budget: 40,
					execution_policy: "sandboxed-source-and-local-only",
					execution: { _tag: "Unavailable", blocker: "no sandbox" },
					prior_runs: [],
					run_status: "complete",
				})
				const second = yield* Effect.flip(
					scoped.startRun({ targetId, kind: "manual", sourceRef: "main" }),
				)
				const prior = yield* scoped.latestPriorRun(targetId)
				const cancelled = yield* scoped.cancelRun(runId, user)

				assert.deepStrictEqual(
					[second._tag, Option.isNone(prior), Option.map(cancelled, (r) => r.incompleteReason)],
					["@maple/backend/security-audit/RunInProgress", true, Option.some("cancelled")],
				)
			}),
		),
	)
})
