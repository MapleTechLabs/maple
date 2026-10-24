import { afterEach, assert, describe, it } from "@effect/vitest"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { durableStep } from "@maple/backend/platform/durable-step"
import { SandboxTimeoutError } from "@maple/backend/sandbox/contract"
import { REPO_SANDBOX_IMPLEMENTATION } from "@maple/backend/services/sandbox/repo-mount"
import {
	RepoSandboxService,
	type RepoSandboxServiceApi,
} from "@maple/backend/services/sandbox/RepoSandboxService"
import {
	SecurityAuditStore,
	type SecurityAuditOrgStore,
} from "@maple/backend/services/security-audit/SecurityAuditStore"
import { OrgId as OrgIdSchema } from "@maple/domain/http"
import { UserId } from "@maple/domain/primitives"
import type { SecurityAuditTargetId, SecurityAuditWorkflowPayload } from "@maple/domain/security-audit"
import { type AgentInvocation, type AuditAgentsApi, coverageId, type Finding } from "@maple/security-audit"
import * as Cloudflare from "alchemy/Cloudflare"
import { Cause, ConfigProvider, Duration, Effect, Exit, Layer, Option, Schema } from "effect"
import { HttpClient } from "effect/http"
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

/** `<commits> <files> <bytes> <lfs files>`, as the size probe prints it: a small repository. */
const SMALL_REPO = "120 40 81920 0\n"

const sandbox = (
	commands: Array<string>,
	size: string = SMALL_REPO,
	/** The manifests and config files the checkout tracks, by path. */
	tree: Record<string, string> = {},
): RepoSandboxServiceApi => {
	const ok = (stdout: string) =>
		Effect.succeed({ exitCode: 0, stdout, stderr: "", wallTimeMs: 1, truncated: false })
	return {
		prepare: () => Effect.void,
		exec: (_org, _target, options) =>
			Effect.suspend(() => {
				if (options.command === "bash") {
					commands.push("measure size")
					return ok(size)
				}
				if (options.args.includes("ls-files")) {
					commands.push("list manifests")
					return ok(Object.keys(tree).join("\n"))
				}
				const shown = options.args.find((arg) => arg.startsWith("HEAD:"))?.slice("HEAD:".length)
				if (shown !== undefined) return ok(tree[shown] ?? "")
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

/** The store over a fresh database, and an HTTP client no test reaches: billing is unconfigured. */
const testLayer = () =>
	Layer.mergeAll(
		SecurityAuditStore.layer.pipe(Layer.provide(createTestDb(trackedDbs).layer)),
		Layer.succeed(
			HttpClient.HttpClient,
			HttpClient.make(() => Effect.die("no network in tests")),
		),
	)

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
	budget: 400,
	priorRunId,
	orgBudget: { period: "2026-10", limit: 20_000 },
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
			assert.deepStrictEqual(commands, ["git rev-parse HEAD", "measure size", "list manifests"])
		}).pipe(Effect.provide(testLayer())),
	)

	it.effect("stops launching agents once the org's month is spent, ending incomplete within it", () =>
		Effect.gen(function* () {
			const { store, target } = yield* setup
			const run = yield* store.startRun({ targetId: target.id, kind: "manual", sourceRef: "main" })
			// Other runs of the org spent 3 of its 9 after this one started with a budget of 400.
			yield* Effect.forEach([1, 2, 3], (i) =>
				store.reserveOrgInvocation(run.id, `other-${i}`, "2026-10", 9),
			)
			const calls: Array<string> = []
			const result = yield* auditWithAgents(
				{ ...payloadFor(run.id), orgBudget: { period: "2026-10", limit: 9 } },
				() => Effect.succeed(scriptedAgents(calls)),
			).pipe(
				Effect.provideService(RepoSandboxService, sandbox([])),
				Effect.provideService(Cloudflare.WorkflowStep, replayingStep(new Map())),
			)
			const row = yield* store.getRun(run.id)
			assert.deepStrictEqual(
				{
					status: result.status,
					agents: calls.length,
					orgSpent: yield* store.orgInvocationsSpent("2026-10"),
					row: Option.map(row, (r) => [
						r.status,
						r.invocationsSpent,
						r.incompleteReason?.split("; ").includes("org_budget_exhausted"),
					]),
				},
				{ status: "incomplete", agents: 6, orgSpent: 9, row: Option.some(["incomplete", 6, true]) },
			)
		}).pipe(Effect.provide(testLayer())),
	)

	it.effect(
		"refuses a repository over a size limit before any agent, marking the run failed with why",
		() =>
			Effect.gen(function* () {
				const { store, target } = yield* setup
				const run = yield* store.startRun({ targetId: target.id, kind: "manual", sourceRef: "main" })
				const calls: Array<string> = []
				// 250,000 tracked files, 3 of them in Git LFS.
				const exit = yield* Effect.exit(
					auditWithAgents(payloadFor(run.id), () => Effect.succeed(scriptedAgents(calls))).pipe(
						Effect.provideService(RepoSandboxService, sandbox([], "5000 250000 524288000 3\n")),
						Effect.provideService(Cloudflare.WorkflowStep, replayingStep(new Map())),
					),
				)
				const row = yield* store.getRun(run.id)
				assert.deepStrictEqual(
					{
						exit: exit._tag,
						agents: calls.length,
						orgSpent: yield* store.orgInvocationsSpent("2026-10"),
						row: Option.map(row, (r) => [r.status, r.error, r.invocationsSpent]),
					},
					{
						exit: "Failure",
						agents: 0,
						orgSpent: 0,
						row: Option.some([
							"failed",
							"repository_refused: the repository was not audited because it tracks 250000 files, over the 100000 limit; it stores 3 files in Git LFS, whose content the checkout does not hold (limit 0).",
							0,
						]),
					},
				)
			}).pipe(Effect.provide(testLayer())),
	)

	it.effect(
		"labels the run source-only with its ecosystems and private dependencies, in row and report",
		() =>
			Effect.gen(function* () {
				const { store, target } = yield* setup
				const run = yield* store.startRun({ targetId: target.id, kind: "manual", sourceRef: "main" })
				const tree = {
					"package.json": "{}",
					".npmrc": "@acme:registry=https://npm.pkg.github.com",
					"tools/go.mod": "module acme.dev/tools\n",
				}
				yield* auditWithAgents(payloadFor(run.id), () => Effect.succeed(scriptedAgents([]))).pipe(
					Effect.provideService(RepoSandboxService, sandbox([], SMALL_REPO, tree)),
					Effect.provideService(Cloudflare.WorkflowStep, replayingStep(new Map())),
				)
				const row = yield* store.getRun(run.id)
				const line =
					"Source-only review: no execution sandbox for Node.js, Go yet; private dependencies detected, which cannot be installed without credentials (.npmrc: private source npm.pkg.github.com)"
				assert.deepStrictEqual(
					Option.map(row, (r) => ({
						mode: r.executionProfile?.mode ?? "none",
						ecosystems: r.executionProfile?.ecosystems.join(",") ?? "none",
						inReport: r.reports?.report.includes(`- ${line}.`) ?? false,
						inNeedsValidation: r.reports?.needsValidation.includes(line) ?? false,
					})),
					Option.some({
						mode: "source_only",
						ecosystems: "node,go",
						inReport: true,
						inNeedsValidation: true,
					}),
				)
			}).pipe(Effect.provide(testLayer())),
	)

	it.effect("keeps a recorded size verdict on replay when the limits changed since", () =>
		Effect.gen(function* () {
			const { store, target } = yield* setup
			// A deploy lowered the file limit below this repository's 40 files after the step recorded.
			const lowered = ConfigProvider.layer(
				ConfigProvider.fromUnknown({ SECURITY_AUDIT_MAX_FILES: "10" }),
			)
			const replayed = yield* store.startRun({ targetId: target.id, kind: "manual", sourceRef: "main" })
			const recorded = new Map<string, unknown>([["repo-size", { violations: [] }]])
			const replay = yield* auditWithAgents(payloadFor(replayed.id), () =>
				Effect.succeed(scriptedAgents([])),
			).pipe(
				Effect.provideService(RepoSandboxService, sandbox([])),
				Effect.provideService(Cloudflare.WorkflowStep, replayingStep(recorded)),
				Effect.provide(lowered),
			)
			// A fresh run under the new limit is refused, so the limit itself is in force.
			const fresh = yield* store.startRun({ targetId: target.id, kind: "manual", sourceRef: "main" })
			const freshExit = yield* Effect.exit(
				auditWithAgents(payloadFor(fresh.id), () => Effect.succeed(scriptedAgents([]))).pipe(
					Effect.provideService(RepoSandboxService, sandbox([])),
					Effect.provideService(Cloudflare.WorkflowStep, replayingStep(new Map())),
					Effect.provide(lowered),
				),
			)
			assert.deepStrictEqual([replay.status, freshExit._tag], ["complete", "Failure"])
		}).pipe(Effect.provide(testLayer())),
	)

	it.effect("refuses a repository whose size cannot be measured", () =>
		Effect.gen(function* () {
			const { store, target } = yield* setup
			const run = yield* store.startRun({ targetId: target.id, kind: "manual", sourceRef: "main" })
			const calls: Array<string> = []
			yield* Effect.exit(
				auditWithAgents(payloadFor(run.id), () => Effect.succeed(scriptedAgents(calls))).pipe(
					Effect.provideService(RepoSandboxService, sandbox([], "")),
					Effect.provideService(Cloudflare.WorkflowStep, replayingStep(new Map())),
				),
			)
			const row = yield* store.getRun(run.id)
			assert.deepStrictEqual(
				[
					calls.length,
					Option.map(row, (r) => [r.status, r.error?.includes("could not be measured")]),
				],
				[0, Option.some(["failed", true])],
			)
		}).pipe(Effect.provide(testLayer())),
	)

	it.effect("settles the run incomplete when its org-budget step dies, launching no agent", () =>
		Effect.gen(function* () {
			const { store, target } = yield* setup
			const run = yield* store.startRun({ targetId: target.id, kind: "manual", sourceRef: "main" })
			const replaying = replayingStep(new Map())
			// The reservation step times out, which the step surfaces as a defect.
			const step: Cloudflare.WorkflowStep["Service"] = {
				...replaying,
				do: (options) =>
					options.name.startsWith("org-budget:")
						? Effect.die(new Error("step timed out after 30 seconds"))
						: replaying.do(options),
			}
			const calls: Array<string> = []
			const result = yield* auditWithAgents(payloadFor(run.id), () =>
				Effect.succeed(scriptedAgents(calls)),
			).pipe(
				Effect.provideService(RepoSandboxService, sandbox([])),
				Effect.provideService(Cloudflare.WorkflowStep, step),
			)
			const row = yield* store.getRun(run.id)
			assert.deepStrictEqual(
				{
					status: result.status,
					agents: calls.length,
					row: Option.map(row, (r) => [
						r.status,
						r.finishedAt !== null,
						r.incompleteReason?.split("; ").includes("org_budget_unavailable"),
					]),
				},
				{ status: "incomplete", agents: 0, row: Option.some(["incomplete", true, true]) },
			)
		}).pipe(Effect.provide(testLayer())),
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
		}).pipe(Effect.provide(testLayer())),
	)

	it.effect("replays recorded agent steps instead of running those agents again", () =>
		Effect.gen(function* () {
			const { store, target } = yield* setup
			const run = yield* store.startRun({ targetId: target.id, kind: "manual", sourceRef: "main" })
			const recorded = new Map<string, unknown>()
			const first: Array<string> = []
			const second: Array<string> = []
			const replaying = replayingStep(recorded)
			// The first pass is evicted at settle, so the run is still open when it replays.
			const evictions = { settle: 1 }
			const step: Cloudflare.WorkflowStep["Service"] = {
				...replaying,
				do: (options) => {
					if (options.name !== "settle" || evictions.settle === 0) return replaying.do(options)
					evictions.settle -= 1
					return Effect.interrupt
				},
			}
			const once = (calls: Array<string>) =>
				auditWithAgents(payloadFor(run.id), () => Effect.succeed(scriptedAgents(calls))).pipe(
					Effect.provideService(RepoSandboxService, sandbox([])),
					Effect.provideService(Cloudflare.WorkflowStep, step),
				)
			const evicted = yield* Effect.exit(once(first))
			const spentBefore = yield* store.orgInvocationsSpent("2026-10")
			const replay = yield* once(second)
			assert.isTrue(Exit.hasInterrupts(evicted))
			assert.isTrue(first.length >= 8)
			assert.deepStrictEqual(
				[
					second,
					replay.status,
					[...recorded.keys()].filter((k) => k.startsWith("agent:")).length,
					spentBefore,
					yield* store.orgInvocationsSpent("2026-10"),
				],
				[[], "complete", first.length, first.length, first.length],
			)
		}).pipe(Effect.provide(testLayer())),
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
						"measure size",
						"list manifests",
						`git --no-optional-locks -c core.quotePath=false diff --name-only --no-renames ${SHA} HEAD --`,
					],
					["prior_covered_changed_source"],
				],
			)
		}).pipe(Effect.provide(testLayer())),
	)
})

describe("auditWithAgents, prior runs", () => {
	it.effect("ignores a prior run that has not finished", () =>
		Effect.gen(function* () {
			const { store, target } = yield* setup
			// One target holds one running run, so the unfinished prior run belongs to a sibling branch target.
			const sibling = yield* store.createTarget({
				repository: "acme/api",
				branch: "release",
				createdBy: Schema.decodeUnknownSync(UserId)("user_a"),
			})
			const unfinished = yield* store.startRun({ targetId: sibling.id, kind: "manual", sourceRef: SHA })
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
				[["git rev-parse HEAD", "measure size", "list manifests"], ["none"]],
			)
		}).pipe(Effect.provide(testLayer())),
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
				exec: (org, target, options) =>
					options.command === "bash"
						? sandbox([]).exec(org, target, options)
						: Effect.succeed(
								options.args[0] === "rev-parse"
									? {
											exitCode: 0,
											stdout: `${SHA}\n`,
											stderr: "",
											wallTimeMs: 1,
											truncated: false,
										}
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
		}).pipe(Effect.provide(testLayer())),
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

/** An open finding on the target, opened by an earlier settled run (a finished run takes no writes). */
const seedOpenFinding = (store: SecurityAuditOrgStore, targetId: SecurityAuditTargetId) =>
	Effect.gen(function* () {
		const seed = yield* store.startRun({ targetId, kind: "manual", sourceRef: SHA })
		yield* store.saveFindings(seed.id, [keysFinding])
		yield* store.finishRun(seed.id, { status: "complete" })
	})

describe("auditWithAgents, settling", () => {
	it.effect("never marks a finding fixed when the diff against the prior run could not be read", () =>
		Effect.gen(function* () {
			const { store, target } = yield* setup
			yield* seedOpenFinding(store, target.id)
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
			const unreadable: RepoSandboxServiceApi = {
				...sandbox([]),
				exec: (org, target, options) =>
					options.command === "bash"
						? sandbox([]).exec(org, target, options)
						: Effect.succeed(
								options.args[0] === "rev-parse"
									? {
											exitCode: 0,
											stdout: `${SHA}\n`,
											stderr: "",
											wallTimeMs: 1,
											truncated: false,
										}
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
		}).pipe(Effect.provide(testLayer())),
	)

	it.effect("leaves a finding open when the run that missed it was only a quick pass", () =>
		Effect.gen(function* () {
			const { store, target } = yield* setup
			yield* seedOpenFinding(store, target.id)
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
			yield* auditWithAgents({ ...payloadFor(next.id, prior.id), profile: "quick" }, () =>
				Effect.succeed(scriptedAgents([])),
			).pipe(
				Effect.provideService(RepoSandboxService, sandbox([])),
				Effect.provideService(Cloudflare.WorkflowStep, replayingStep(new Map())),
			)
			const findings = yield* store.listFindings(target.id)
			assert.deepStrictEqual(
				findings.map((f) => f.status),
				["open"],
			)
		}).pipe(Effect.provide(testLayer())),
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
		}).pipe(Effect.provide(testLayer())),
	)

	it.effect(
		"keeps a run cancelled mid-flight cancelled, admits no agent after it, and marks nothing fixed",
		() =>
			Effect.gen(function* () {
				const { store, target } = yield* setup
				yield* seedOpenFinding(store, target.id)
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
				const calls: Array<string> = []
				const scripted = scriptedAgents(calls)
				// An admin cancels while the first agent is in flight; the run still settles after.
				const cancelling: AuditAgentsApi = {
					run: (invocation) =>
						store
							.cancelRun(next.id, Schema.decodeUnknownSync(UserId)("user_admin"))
							.pipe(Effect.orDie, Effect.andThen(scripted.run(invocation))),
				}
				const result = yield* auditWithAgents(payloadFor(next.id, prior.id), () =>
					Effect.succeed(cancelling),
				).pipe(
					Effect.provideService(RepoSandboxService, sandbox([])),
					Effect.provideService(Cloudflare.WorkflowStep, replayingStep(new Map())),
				)
				const row = yield* store.getRun(next.id)
				const findings = yield* store.listFindings(target.id)
				assert.deepStrictEqual(
					[
						result.status,
						calls.every((id) => id.startsWith("recon-")),
						Option.map(row, (r) => [r.status, r.incompleteReason]),
						findings.map((f) => f.status),
					],
					// Only the reconnaissance already admitted alongside the first agent ran; nothing after.
					["incomplete", true, Option.some(["incomplete", "cancelled"]), ["open"]],
				)
			}).pipe(Effect.provide(testLayer())),
	)

	it.effect(
		"marks an open finding fixed when a complete run no longer reports it and its files changed",
		() =>
			Effect.gen(function* () {
				const { store, target } = yield* setup
				yield* seedOpenFinding(store, target.id)
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
			}).pipe(Effect.provide(testLayer())),
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
		}).pipe(Effect.provide(testLayer())),
	)
})
