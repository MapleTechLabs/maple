import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId, UserId } from "@maple/domain/primitives"
import { VcsRepositoryId } from "@maple/domain/http/vcs"
import type { SecurityAuditTargetId } from "@maple/domain/security-audit"
import type { AuditEvent, CoverageUnit, Finding, RunMetadata } from "@maple/security-audit"
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
		const run = yield* scoped.startRun({ targetId: target, kind: "baseline", sourceRef })
		return { targetId: target, runId: run.id }
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
					run_status: "in_progress",
				}
				yield* scoped.saveMetadata(metadata)
				yield* scoped.saveArchitecture(runId, "# Architecture")
				yield* scoped.addUsage(runId, {
					invocations: 2,
					inputTokens: 100,
					outputTokens: 10,
					costUsd: 0.5,
				})
				yield* scoped.addUsage(runId, { invocations: 1, inputTokens: 50, outputTokens: 5 })
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
					store
						.forOrg(orgA)
						.createTarget({
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
