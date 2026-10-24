import { afterEach, assert, describe, it } from "@effect/vitest"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { durableStep } from "@maple/backend/platform/durable-step"
import { SandboxTimeoutError } from "@maple/backend/sandbox/contract"
import { REPO_SANDBOX_IMPLEMENTATION } from "@maple/backend/services/sandbox/repo-mount"
import {
	RepoSandboxService,
	type RepoSandboxServiceApi,
} from "@maple/backend/services/sandbox/RepoSandboxService"
import { SecurityAuditStore } from "@maple/backend/services/security-audit/SecurityAuditStore"
import { OrgId as OrgIdSchema } from "@maple/domain/http"
import { UserId } from "@maple/domain/primitives"
import type { SecurityAuditWorkflowPayload } from "@maple/domain/security-audit"
import { type AgentInvocation, type AuditAgentsApi, coverageId, type Finding } from "@maple/security-audit"
import * as Cloudflare from "alchemy/Cloudflare"
import { Cause, Duration, Effect, Exit, Layer, Option, Schema } from "effect"
import { auditWithAgents, toSandboxStepError } from "./workflow.run"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const SHA = "a".repeat(40)
const refs = {
	surface: "src/routes/keys.ts#POST /keys",
	boundary: "src/auth.ts#requireOrg",
	subsystem: "src",
	attack_class: "ATTACK-CLASSES.md#Access control",
}
const unitId = coverageId(refs)

/** A deep run's agents, answering from the role alone; records who was called. */
const scriptedAgents = (calls: Array<string>): AuditAgentsApi => ({
	run: (invocation: AgentInvocation) =>
		Effect.sync(() => {
			calls.push(invocation.agentId)
			const text =
				invocation.role === "recon"
					? "facts"
					: invocation.role === "synthesis"
						? JSON.stringify({
								architecture_md: "An API with org-scoped keys.",
								units: [
									{
										canonical_refs: refs,
										surface: "POST /keys",
										boundary: "org scope",
										subsystem: "src",
										attack_class: "Access control",
										starting_paths: ["src/routes/keys.ts"],
										ordinary_attack_class_block: "ATTACK-CLASSES.md#Access control",
										selected_companion_blocks: [],
										excluded_blocks: [],
									},
								],
							})
						: invocation.role === "hunter"
							? JSON.stringify({
									units: [
										{
											coverage_id: unitId,
											disposition: "covered",
											reviewed_paths: ["src/routes/keys.ts"],
											checks: [
												{
													agent_id: invocation.agentId,
													reviewed_paths: ["src/routes/keys.ts"],
													invariant: "org scope",
													method: "source",
													result: "scoped by requireOrg",
													artifact: null,
												},
											],
											candidate_fingerprints: [],
											unresolved: [],
										},
									],
									candidates: [],
									hardening: [],
									uncovered: [],
								})
							: JSON.stringify({
									missing_units: [],
									reassign_ids: [],
									resolved_prior_leads: [],
									stop: true,
								})
			return { text }
		}),
})

const sandbox = (commands: Array<string>): RepoSandboxServiceApi => {
	const ok = (stdout: string) =>
		Effect.succeed({ exitCode: 0, stdout, stderr: "", wallTimeMs: 1, truncated: false })
	return {
		prepare: () => Effect.void,
		exec: (_org, _target, options) =>
			Effect.suspend(() => {
				commands.push([options.command, ...options.args].join(" "))
				return ok(options.args[0] === "rev-parse" ? `${SHA}\n` : "src/routes/keys.ts\n")
			}),
		grep: () => ok(""),
		listFiles: () => ok(""),
		readFile: () => ok(""),
	}
}

/** A step service that records names and replays a recorded result, as Cloudflare does after a restart. */
const replayingStep = (recorded: Map<string, unknown>): Cloudflare.WorkflowStep["Service"] => ({
	do: <T>(options: Cloudflare.WorkflowTaskOptions<T, any, any>) =>
		Effect.suspend(() => {
			// SAFETY: a name is only ever recorded with the value its own step produced, as in Cloudflare.
			if (recorded.has(options.name)) return Effect.succeed(recorded.get(options.name) as T)
			// SAFETY: alchemy's own step wrapper makes the same narrowing before it runs the Effect.
			return (options.effect as Effect.Effect<T>).pipe(
				Effect.tap((value) => Effect.sync(() => recorded.set(options.name, value))),
			)
		}),
	sleep: () => Effect.void,
	sleepUntil: () => Effect.void,
	waitForEvent: () => Effect.die("unused"),
})

const setup = Effect.gen(function* () {
	const store = (yield* SecurityAuditStore).forOrg(Schema.decodeUnknownSync(OrgIdSchema)("org_a"))
	const target = yield* store.createTarget({
		repository: "acme/api",
		branch: "main",
		createdBy: Schema.decodeUnknownSync(UserId)("user_a"),
	})
	return { store, target }
})

const payloadFor = (runId: string, priorRunId: string | null = null): SecurityAuditWorkflowPayload => ({
	orgId: "org_a",
	runId,
	repository: "acme/api",
	ref: "main",
	profile: "deep",
	scopePaths: [],
	budget: null,
	priorRunId,
})

describe("auditWithAgents", () => {
	it.effect("pins the commit, records it on the run, runs the engine and finishes the run", () =>
		Effect.gen(function* () {
			const { store, target } = yield* setup
			const run = yield* store.startRun({ targetId: target.id, kind: "manual", sourceRef: "main" })
			const calls: Array<string> = []
			const commands: Array<string> = []
			const result = yield* auditWithAgents(payloadFor(run.id), () =>
				Effect.succeed(scriptedAgents(calls)),
			).pipe(
				Effect.provideService(RepoSandboxService, sandbox(commands)),
				Effect.provideService(Cloudflare.WorkflowStep, replayingStep(new Map())),
			)
			const finished = yield* store.getRun(run.id)
			const units = yield* store.listUnits(run.id)
			assert.deepStrictEqual(
				[
					result.status,
					Option.map(finished, (r) => [r.status, r.sourceRef]),
					units.map((u) => u.status),
				],
				// The row records the pinned commit, which the next run diffs against.
				["complete", Option.some(["complete", SHA]), ["covered"]],
			)
			assert.deepStrictEqual(commands, ["git rev-parse HEAD"])
		}).pipe(Effect.provide(SecurityAuditStore.layer.pipe(Layer.provide(createTestDb(trackedDbs).layer)))),
	)

	it.effect("marks the run failed when the sandbox cannot pin the commit", () =>
		Effect.gen(function* () {
			const { store, target } = yield* setup
			const run = yield* store.startRun({ targetId: target.id, kind: "manual", sourceRef: "main" })
			const broken: RepoSandboxServiceApi = {
				...sandbox([]),
				prepare: () => Effect.die("repository sandbox is not available on this stage"),
			}
			const exit = yield* Effect.exit(
				auditWithAgents(payloadFor(run.id), () => Effect.succeed(scriptedAgents([]))).pipe(
					Effect.provideService(RepoSandboxService, broken),
					Effect.provideService(Cloudflare.WorkflowStep, replayingStep(new Map())),
				),
			)
			const row = yield* store.getRun(run.id)
			assert.deepStrictEqual(
				[
					exit._tag,
					Option.map(row, (r) => [r.status, r.error?.includes("not available on this stage")]),
				],
				["Failure", Option.some(["failed", true])],
			)
		}).pipe(Effect.provide(SecurityAuditStore.layer.pipe(Layer.provide(createTestDb(trackedDbs).layer)))),
	)

	it.effect("replays recorded agent steps instead of running those agents again", () =>
		Effect.gen(function* () {
			const { store, target } = yield* setup
			const run = yield* store.startRun({ targetId: target.id, kind: "manual", sourceRef: "main" })
			const recorded = new Map<string, unknown>()
			const first: Array<string> = []
			const second: Array<string> = []
			const step = replayingStep(recorded)
			const once = (calls: Array<string>) =>
				auditWithAgents(payloadFor(run.id), () => Effect.succeed(scriptedAgents(calls))).pipe(
					Effect.provideService(RepoSandboxService, sandbox([])),
					Effect.provideService(Cloudflare.WorkflowStep, step),
				)
			yield* once(first)
			const replay = yield* once(second)
			assert.isTrue(first.length >= 8)
			assert.deepStrictEqual(
				[second, replay.status, [...recorded.keys()].filter((k) => k.startsWith("agent:")).length],
				[[], "complete", first.length],
			)
		}).pipe(Effect.provide(SecurityAuditStore.layer.pipe(Layer.provide(createTestDb(trackedDbs).layer)))),
	)

	it.effect("diffs against the prior run's commit and hands the engine its ledger", () =>
		Effect.gen(function* () {
			const { store, target } = yield* setup
			const prior = yield* store.startRun({ targetId: target.id, kind: "manual", sourceRef: SHA })
			yield* auditWithAgents(payloadFor(prior.id), () => Effect.succeed(scriptedAgents([]))).pipe(
				Effect.provideService(RepoSandboxService, sandbox([])),
				Effect.provideService(Cloudflare.WorkflowStep, replayingStep(new Map())),
			)
			const next = yield* store.startRun({
				targetId: target.id,
				kind: "revalidation",
				sourceRef: "main",
			})
			const commands: Array<string> = []
			yield* auditWithAgents(payloadFor(next.id, prior.id), () =>
				Effect.succeed(scriptedAgents([])),
			).pipe(
				Effect.provideService(RepoSandboxService, sandbox(commands)),
				Effect.provideService(Cloudflare.WorkflowStep, replayingStep(new Map())),
			)
			const units = yield* store.listUnits(next.id)
			assert.deepStrictEqual(
				[commands, units.map((u) => u.unit.prior_status)],
				[
					[
						"git rev-parse HEAD",
						`git --no-optional-locks -c core.quotePath=false diff --name-only --no-renames ${SHA} HEAD --`,
					],
					["prior_covered_changed_source"],
				],
			)
		}).pipe(Effect.provide(SecurityAuditStore.layer.pipe(Layer.provide(createTestDb(trackedDbs).layer)))),
	)
})

describe("auditWithAgents, prior runs", () => {
	it.effect("ignores a prior run that has not finished", () =>
		Effect.gen(function* () {
			const { store, target } = yield* setup
			const unfinished = yield* store.startRun({ targetId: target.id, kind: "manual", sourceRef: SHA })
			const run = yield* store.startRun({ targetId: target.id, kind: "manual", sourceRef: "main" })
			const commands: Array<string> = []
			yield* auditWithAgents(payloadFor(run.id, unfinished.id), () =>
				Effect.succeed(scriptedAgents([])),
			).pipe(
				Effect.provideService(RepoSandboxService, sandbox(commands)),
				Effect.provideService(Cloudflare.WorkflowStep, replayingStep(new Map())),
			)
			const units = yield* store.listUnits(run.id)
			assert.deepStrictEqual(
				[commands, units.map((u) => u.unit.prior_status)],
				[["git rev-parse HEAD"], ["none"]],
			)
		}).pipe(Effect.provide(SecurityAuditStore.layer.pipe(Layer.provide(createTestDb(trackedDbs).layer)))),
	)

	it.effect("treats a failed diff against the prior commit as everything changed", () =>
		Effect.gen(function* () {
			const { store, target } = yield* setup
			const prior = yield* store.startRun({ targetId: target.id, kind: "manual", sourceRef: SHA })
			yield* auditWithAgents(payloadFor(prior.id), () => Effect.succeed(scriptedAgents([]))).pipe(
				Effect.provideService(RepoSandboxService, sandbox([])),
				Effect.provideService(Cloudflare.WorkflowStep, replayingStep(new Map())),
			)
			const next = yield* store.startRun({
				targetId: target.id,
				kind: "revalidation",
				sourceRef: "main",
			})
			const unreachable: RepoSandboxServiceApi = {
				...sandbox([]),
				exec: (_org, _target, options) =>
					Effect.succeed(
						options.args[0] === "rev-parse"
							? { exitCode: 0, stdout: `${SHA}\n`, stderr: "", wallTimeMs: 1, truncated: false }
							: {
									exitCode: 128,
									stdout: "",
									stderr: "fatal: bad object",
									wallTimeMs: 1,
									truncated: false,
								},
					),
			}
			yield* auditWithAgents(payloadFor(next.id, prior.id), () =>
				Effect.succeed(scriptedAgents([])),
			).pipe(
				Effect.provideService(RepoSandboxService, unreachable),
				Effect.provideService(Cloudflare.WorkflowStep, replayingStep(new Map())),
			)
			const units = yield* store.listUnits(next.id)
			assert.deepStrictEqual(
				units.map((u) => u.unit.prior_status),
				["prior_covered_changed_source"],
			)
		}).pipe(Effect.provide(SecurityAuditStore.layer.pipe(Layer.provide(createTestDb(trackedDbs).layer)))),
	)
})

const keysFinding: Finding = {
	verdict: "confirmed",
	fingerprint: "keys/roll-missing-org-scope",
	title: "Any org member can roll another org's API key",
	description: "rollKey looks the key up by id alone.",
	root_cause: "rollKey omits the org_id predicate.",
	intended_behavior: "A key is only rolled within the caller's org.",
	trace: [
		{
			kind: "entrypoint",
			file: "src/routes/keys.ts",
			line: 12,
			scope: "POST /keys",
			description: "takes a key id",
		},
		{ kind: "sink", file: "src/routes/keys.ts", line: 40, scope: "rollKey", description: "no org check" },
	],
	evidence: [{ file: "src/routes/keys.ts", line: 40, description: "lookup by id only" }],
	conditions: [{ kind: "authentication_level", description: "any org member" }],
	execution: {
		attacker_perspective: "member of org A",
		payloads: ["POST /keys/<org B key>/roll"],
		instructions: ["call the route"],
		observed_result: "source trace reaches rollKey",
	},
	remediation: { strategy: "filter by org" },
	severity: {
		likelihood: { score: "medium", reason: "needs an id" },
		impact: { score: "high", reason: "cross-tenant write" },
		overall_severity: "high",
	},
	confidence: { score: "medium", reason: "source trace complete" },
}

describe("auditWithAgents, settling", () => {
	it.effect("never marks a finding fixed when the diff against the prior run could not be read", () =>
		Effect.gen(function* () {
			const { store, target } = yield* setup
			const prior = yield* store.startRun({ targetId: target.id, kind: "manual", sourceRef: SHA })
			yield* auditWithAgents(payloadFor(prior.id), () => Effect.succeed(scriptedAgents([]))).pipe(
				Effect.provideService(RepoSandboxService, sandbox([])),
				Effect.provideService(Cloudflare.WorkflowStep, replayingStep(new Map())),
			)
			yield* store.saveFindings(prior.id, [keysFinding])
			const next = yield* store.startRun({
				targetId: target.id,
				kind: "revalidation",
				sourceRef: "main",
			})
			const unreadable: RepoSandboxServiceApi = {
				...sandbox([]),
				exec: (_org, _target, options) =>
					Effect.succeed(
						options.args[0] === "rev-parse"
							? { exitCode: 0, stdout: `${SHA}\n`, stderr: "", wallTimeMs: 1, truncated: false }
							: {
									exitCode: 0,
									stdout: "src/a.ts\n",
									stderr: "",
									wallTimeMs: 1,
									truncated: true,
								},
					),
			}
			yield* auditWithAgents(payloadFor(next.id, prior.id), () =>
				Effect.succeed(scriptedAgents([])),
			).pipe(
				Effect.provideService(RepoSandboxService, unreadable),
				Effect.provideService(Cloudflare.WorkflowStep, replayingStep(new Map())),
			)
			const findings = yield* store.listFindings(target.id)
			assert.deepStrictEqual(
				findings.map((f) => f.status),
				["open"],
			)
		}).pipe(Effect.provide(SecurityAuditStore.layer.pipe(Layer.provide(createTestDb(trackedDbs).layer)))),
	)

	it.effect("does nothing for a run its starter already marked failed", () =>
		Effect.gen(function* () {
			const { store, target } = yield* setup
			const run = yield* store.startRun({ targetId: target.id, kind: "manual", sourceRef: "main" })
			yield* store.finishRun(run.id, { status: "failed", error: "workflow create failed" })
			const calls: Array<string> = []
			const commands: Array<string> = []
			yield* auditWithAgents(payloadFor(run.id), () => Effect.succeed(scriptedAgents(calls))).pipe(
				Effect.provideService(RepoSandboxService, sandbox(commands)),
				Effect.provideService(Cloudflare.WorkflowStep, replayingStep(new Map())),
			)
			const row = yield* store.getRun(run.id)
			assert.deepStrictEqual(
				[calls, commands, Option.map(row, (r) => r.status)],
				[[], [], Option.some("failed")],
			)
		}).pipe(Effect.provide(SecurityAuditStore.layer.pipe(Layer.provide(createTestDb(trackedDbs).layer)))),
	)

	it.effect(
		"marks an open finding fixed when a complete run no longer reports it and its files changed",
		() =>
			Effect.gen(function* () {
				const { store, target } = yield* setup
				const prior = yield* store.startRun({ targetId: target.id, kind: "manual", sourceRef: SHA })
				yield* auditWithAgents(payloadFor(prior.id), () => Effect.succeed(scriptedAgents([]))).pipe(
					Effect.provideService(RepoSandboxService, sandbox([])),
					Effect.provideService(Cloudflare.WorkflowStep, replayingStep(new Map())),
				)
				yield* store.saveFindings(prior.id, [keysFinding])
				const next = yield* store.startRun({
					targetId: target.id,
					kind: "revalidation",
					sourceRef: "main",
				})
				yield* auditWithAgents(payloadFor(next.id, prior.id), () =>
					Effect.succeed(scriptedAgents([])),
				).pipe(
					Effect.provideService(RepoSandboxService, sandbox([])),
					Effect.provideService(Cloudflare.WorkflowStep, replayingStep(new Map())),
				)
				const findings = yield* store.listFindings(target.id)
				assert.deepStrictEqual(
					findings.map((f) => [f.fingerprint, f.status]),
					[["keys/roll-missing-org-scope", "fixed"]],
				)
			}).pipe(
				Effect.provide(SecurityAuditStore.layer.pipe(Layer.provide(createTestDb(trackedDbs).layer))),
			),
	)
})

interface StepRetries {
	readonly retries?: { readonly limit: number }
}

interface StepAttempt {
	readonly step: { readonly name: string; readonly count: number }
	readonly attempt: number
	readonly config: StepRetries
}

interface NativeStep {
	readonly do: <T>(
		name: string,
		config: StepRetries,
		callback: (context: StepAttempt) => Promise<T>,
	) => Promise<T>
}

/**
 * alchemy exports only the whole bridge; its step wrapper holds the failure encoder under test. A
 * computed specifier keeps the typecheck out of alchemy's sources.
 */
const BRIDGE = new URL(
	"../../../../node_modules/alchemy/src/Cloudflare/Workflows/WorkflowBridge.ts",
	import.meta.url,
).href
const loadBridge = Effect.promise(
	(): Promise<{
		readonly wrapWorkflowStep: (
			step: NativeStep,
			identity: { readonly workflow: string; readonly instanceId: string },
		) => Cloudflare.WorkflowStep["Service"]
	}> => import(BRIDGE),
)

/**
 * Cloudflare's native step under alchemy's real wrapper: retried per its config while the callback
 * rejects with an encoded application failure, and terminal on anything else.
 */
const nativeStep = (attempts: Array<string>) =>
	Effect.map(loadBridge, ({ wrapWorkflowStep }) => {
		const attempt = <T>(
			name: string,
			config: StepRetries,
			callback: (context: StepAttempt) => Promise<T>,
			n: number,
		): Promise<T> => {
			attempts.push(name)
			return callback({ step: { name, count: 1 }, attempt: n, config }).catch((error: unknown) =>
				error instanceof Error &&
				error.message.startsWith("[alchemy-workflow-failure:v1]") &&
				n <= (config.retries?.limit ?? 0)
					? attempt(name, config, callback, n + 1)
					: Promise.reject(error),
			)
		}
		return wrapWorkflowStep(
			{ do: (name, config, callback) => attempt(name, config, callback, 1) },
			{ workflow: "security-audit", instanceId: "run" },
		)
	})

const timeout = new SandboxTimeoutError({
	implementation: REPO_SANDBOX_IMPLEMENTATION,
	maxWallTime: Duration.seconds(30),
})
const retries = { retries: { limit: 2, delay: "1 second", backoff: "constant" } } as const

describe("sandbox failures across a step", () => {
	it.effect("a raw sandbox timeout cannot be encoded, so the step is terminal", () =>
		Effect.gen(function* () {
			const attempts: Array<string> = []
			const exit = yield* Effect.exit(
				durableStep("s", Effect.fail(timeout), retries).pipe(
					Effect.provideServiceEffect(Cloudflare.WorkflowStep, nativeStep(attempts)),
				),
			)
			assert.deepStrictEqual(
				[attempts.length, Exit.isFailure(exit) && Cause.hasDies(exit.cause)],
				[1, true],
			)
		}),
	)

	it.effect("a mapped sandbox timeout is retried and reaches the run as a typed failure", () =>
		Effect.gen(function* () {
			const attempts: Array<string> = []
			const exit = yield* Effect.exit(
				durableStep(
					"s",
					Effect.fail(timeout).pipe(Effect.mapError(toSandboxStepError("s"))),
					retries,
				).pipe(Effect.provideServiceEffect(Cloudflare.WorkflowStep, nativeStep(attempts))),
			)
			const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()
			assert.deepStrictEqual(
				[attempts.length, Option.map(failure, (e) => [e._tag, e.message])],
				[
					3,
					Option.some(["@maple/ai/security-audit/SandboxStepError", "s: timed out after 30000 ms"]),
				],
			)
		}),
	)

	it.effect("retries a run whose commit lookup times out, then marks it failed", () =>
		Effect.gen(function* () {
			const { store, target } = yield* setup
			const run = yield* store.startRun({ targetId: target.id, kind: "manual", sourceRef: "main" })
			const attempts: Array<string> = []
			const slow: RepoSandboxServiceApi = { ...sandbox([]), prepare: () => Effect.fail(timeout) }
			const exit = yield* Effect.exit(
				auditWithAgents(payloadFor(run.id), () => Effect.succeed(scriptedAgents([]))).pipe(
					Effect.provideService(RepoSandboxService, slow),
					Effect.provideServiceEffect(Cloudflare.WorkflowStep, nativeStep(attempts)),
				),
			)
			const row = yield* store.getRun(run.id)
			assert.deepStrictEqual(
				[
					attempts,
					Exit.isFailure(exit) && !Cause.hasDies(exit.cause),
					Option.map(row, (r) => r.status),
				],
				[
					["resolve-commit", "resolve-commit", "resolve-commit", "resolve-commit"],
					true,
					Option.some("failed"),
				],
			)
		}).pipe(Effect.provide(SecurityAuditStore.layer.pipe(Layer.provide(createTestDb(trackedDbs).layer)))),
	)
})
