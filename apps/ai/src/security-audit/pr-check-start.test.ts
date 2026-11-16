import { afterEach, describe, expect, it } from "@effect/vitest"
import { GitCommitSha, type PullRequestEventJob, type PullRequestFile } from "@maple/domain/http"
import {
	DISABLED_ORGANIZATION_FEATURE_FLAGS,
	ENABLED_ORGANIZATION_FEATURE_FLAGS,
} from "@maple/domain/organization-feature-flags"
import type { SecurityAuditWorkflowPayload } from "@maple/domain/security-audit"
import { SecurityAuditWorkflowStarter, WorkflowStartError } from "@maple/backend/platform/bindings"
import { envPorts } from "@maple/backend/platform/env-ports"
import { AiCredits, AiCreditsExhausted } from "@maple/backend/services/billing/AiCredits"
import {
	asOrgId,
	asUserId,
	testRepoLayer,
	upsertReposFor,
} from "@maple/backend/services/integrations/vcs/__tests__/harness"
import type { VcsProviderClient } from "@maple/backend/services/integrations/vcs/VcsProviderClient"
import {
	VcsProviderRegistry,
	type VcsProviderRegistryApi,
} from "@maple/backend/services/integrations/vcs/VcsProviderRegistry"
import { VcsRepository } from "@maple/backend/services/integrations/vcs/VcsRepository"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { SecurityAuditStore } from "@maple/backend/services/security-audit/SecurityAuditStore"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import { Array as Arr, Effect, Layer, Order, Schema, Stream, String as Str } from "effect"
import * as SecureRandom from "effect/crypto/SecureRandom"
import { SecurityPrCheck } from "./pr-check"
import { startPullRequestCheck } from "./pr-check-start"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const orgId = asOrgId("org_pr_check")
const HEAD = Schema.decodeSync(GitCommitSha)("1111111111111111111111111111111111111111")
const NEXT_HEAD = Schema.decodeSync(GitCommitSha)("2222222222222222222222222222222222222222")

const file = (path: string, status: PullRequestFile["status"] = "modified"): PullRequestFile => ({
	path,
	previousPath: null,
	status,
	additions: 1,
	deletions: 0,
	patch: null,
})

const job = (overrides: Partial<PullRequestEventJob> = {}): PullRequestEventJob => ({
	kind: "pull-request-event",
	provider: "github",
	externalInstallationId: "42",
	externalRepoId: "7",
	repoFullName: "octo/repo",
	number: 612,
	action: "opened",
	url: "https://github.com/octo/repo/pull/612",
	title: "Add the orders route",
	body: null,
	authorLogin: "octocat",
	authorAssociation: "MEMBER",
	merged: false,
	mergeCommitSha: null,
	mergedAtMs: null,
	headSha: HEAD,
	baseRef: "main",
	headRef: "feat/orders",
	draft: false,
	...overrides,
})

/** Only the file list is read; any other provider call fails the test loudly. */
/** The pull request's head on GitHub, as a test moves it. */
const headAt = (current: { sha: GitCommitSha }) => () =>
	Effect.succeed({
		number: 612,
		title: "Add the orders route",
		url: "https://github.com/octo/repo/pull/612",
		body: null,
		authorLogin: "octocat",
		state: "open",
		draft: false,
		headSha: current.sha,
		headRef: "feat/orders",
		baseSha: HEAD,
		baseRef: "main",
		headRepoFullName: "octo/repo",
	})

const providerWith = (
	files: () => Effect.Effect<ReadonlyArray<PullRequestFile>>,
	head: VcsProviderClient["fetchPullRequestHead"],
): VcsProviderClient => {
	const unused = () => Effect.die("not used by the security check start")
	return {
		id: "github",
		reviewerMention: "@maple-review-bot",
		webhookSignatureHeader: "x-hub-signature-256",
		webhookToJobs: unused,
		fetchRepositories: unused,
		fetchCommits: unused,
		fetchBranches: unused,
		fetchCommit: unused,
		fetchPullRequests: unused,
		fetchPullRequest: unused,
		fetchPullRequestFiles: files,
		fetchReviewThreads: unused,
		hideEarlierComments: unused,
		resolveReviewThread: unused,
		fetchChangesSince: unused,
		fetchPullRequestHead: head,
		postPullRequestReply: unused,
		reactToComment: unused,
		fetchCommenterPermission: unused,
		commitFiles: unused,
		fetchPullRequestContext: unused,
		publishPullRequestReview: unused,
		writePullRequestCheck: unused,
		writePullRequestSummaryComment: unused,
		searchCode: unused,
		repositorySizeBytes: unused,
		resolveRef: unused,
		fetchCloneCredentials: unused,
		fetchTreeFiles: unused,
		fetchBlobText: unused,
		fetchSourceFile: unused,
		fetchWorkflowJobAnnotations: unused,
		streamWorkflowJobLog: () => Stream.die("not used by the security check"),
		canReadWorkflowLogs: unused,
		fetchBillingUsage: unused,
		installationSettingsUrl: () => "https://github.com/settings/installations/42",
	}
}

const makeHarness = (
	options: {
		readonly files?: () => Effect.Effect<ReadonlyArray<PullRequestFile>>
		/** Every Workflow create fails, as with the binding down or the instance limit reached. */
		readonly createFails?: boolean
		readonly enabled?: boolean
		readonly noCredits?: boolean
		readonly prCheckEnabled?: boolean
		/** The pull request's head on GitHub; the delivered head when absent. */
		readonly head?: { sha: GitCommitSha }
	} = {},
) => {
	const db = createTestDb(trackedDbs)
	const currentHead = options.head ?? { sha: HEAD }
	const rollout = { enabled: options.enabled !== false }
	const started: Array<SecurityAuditWorkflowPayload> = []
	const cancelled: Array<string> = []
	const notices: Array<string> = []
	const published: Array<string> = []
	const layer = Layer.mergeAll(
		SecurityAuditStore.layer.pipe(Layer.provide(db.layer)),
		testRepoLayer(db),
		Layer.succeed(VcsProviderRegistry, {
			ids: ["github"],
			resolve: () =>
				Effect.succeed(
					providerWith(
						options.files ?? (() => Effect.succeed([file("src/orders.ts")])),
						headAt(currentHead),
					),
				),
		} satisfies VcsProviderRegistryApi),
		Layer.succeed(SecurityAuditWorkflowStarter, {
			// One instance per run id, as Cloudflare Workflows keep them.
			create: (payload) =>
				options.createFails === true || Arr.some(started, (p) => p.runId === payload.runId)
					? Effect.fail(new WorkflowStartError({ message: "instance limit reached", cause: null }))
					: Effect.sync(() => void started.push(payload)),
			exists: (runId) => Effect.succeed(Arr.some(started, (p) => p.runId === runId)),
			cancel: (runId) => Effect.sync(() => void cancelled.push(runId)),
		}),
		Layer.succeed(SecurityPrCheck, {
			notify: (_org, _target, headSha, notice) =>
				Effect.sync(
					() =>
						void notices.push(
							notice.kind === "running"
								? `${Str.slice(0, 4)(headSha)}:running`
								: `${Str.slice(0, 4)(headSha)}:unchecked:${notice.reason}`,
						),
				),
			publish: (_org, runId) => Effect.sync(() => void published.push(runId)),
		}),
		options.noCredits === true
			? Layer.succeed(AiCredits, {
					ensure: () =>
						Effect.fail(
							new AiCreditsExhausted({
								message: "used up",
								reason: "used_up",
								resetsAt: null,
							}),
						),
				})
			: AiCredits.unmetered,
		// Read on every call, so a test can turn the rollout off between deliveries.
		Layer.succeed(OrganizationFeatureFlagsService, {
			flags: () =>
				Effect.sync(() =>
					rollout.enabled
						? ENABLED_ORGANIZATION_FEATURE_FLAGS
						: DISABLED_ORGANIZATION_FEATURE_FLAGS,
				),
		}),
		envPorts({}),
		SecureRandom.layerWebCrypto,
	)

	const seeded = Effect.gen(function* () {
		const repo = yield* VcsRepository
		yield* repo.upsertInstallation({
			orgId,
			provider: "github",
			externalInstallationId: "42",
			accountLogin: "octo",
			accountType: "organization",
			externalAccountId: "100",
			accountAvatarUrl: null,
			repositorySelection: "all",
			installedByUserId: asUserId("user_1"),
		})
		yield* upsertReposFor(repo, "42", [
			{
				externalRepoId: "7",
				owner: "octo",
				name: "repo",
				fullName: "octo/repo",
				defaultBranch: "main",
				htmlUrl: "https://github.com/octo/repo",
				isPrivate: true,
				isArchived: false,
			},
		])
		const store = (yield* SecurityAuditStore).forOrg(orgId)
		const target = yield* store.createTarget({
			repository: "octo/repo",
			branch: "main",
			createdBy: asUserId("user_1"),
		})
		yield* store.updateTarget(target.id, { prCheckEnabled: options.prCheckEnabled ?? true })
		return target
	})

	const run = <A, E>(body: Effect.Effect<A, E, Layer.Success<typeof layer>>) =>
		Effect.runPromise(body.pipe(Effect.provide(layer)))

	const runsOf = (targetId: string) =>
		Effect.gen(function* () {
			const store = (yield* SecurityAuditStore).forOrg(orgId)
			const rows = yield* store.listRuns({})
			return Arr.map(
				Arr.filter(rows, (r) => r.targetId === targetId),
				(r) => ({
					prNumber: r.prNumber,
					kind: r.kind,
					status: r.status,
					reason: r.incompleteReason,
				}),
			)
		})

	return { run, seeded, started, cancelled, notices, published, runsOf, currentHead, rollout }
}

describe("startPullRequestCheck", () => {
	it("starts a quick run of the changed files at the head and reports it running", async () => {
		const harness = makeHarness({
			files: () => Effect.succeed([file("src/orders.ts", "added"), file("src/old.ts", "removed")]),
		})
		const outcome = await harness.run(
			Effect.gen(function* () {
				yield* harness.seeded
				return yield* startPullRequestCheck(orgId, job())
			}),
		)

		expect(outcome).toEqual({ outcome: "started" })
		expect(
			Arr.map(harness.started, (p) => [
				p.ref,
				p.profile,
				p.scopePaths,
				p.budget,
				p.priorRunId,
				p.repository,
			]),
		).toEqual([[HEAD, "quick", ["src/orders.ts"], 30, null, "octo/repo"]])
		expect(harness.notices).toEqual(["1111:running"])
	})

	it("posts nothing for a pull request no target checks, a draft or a closed one; not blocking outside the rollout", async () => {
		const harness = makeHarness()
		const outcomes = await harness.run(
			Effect.gen(function* () {
				yield* harness.seeded
				return [
					yield* startPullRequestCheck(orgId, job({ baseRef: "release" })),
					yield* startPullRequestCheck(orgId, job({ draft: true })),
					yield* startPullRequestCheck(orgId, job({ action: "closed" })),
				]
			}),
		)
		const disabled = makeHarness({ enabled: false })
		const outside = await disabled.run(
			Effect.gen(function* () {
				yield* disabled.seeded
				return yield* startPullRequestCheck(orgId, job())
			}),
		)
		const off = makeHarness({ prCheckEnabled: false })
		const notTurnedOn = await off.run(
			Effect.gen(function* () {
				yield* off.seeded
				return yield* startPullRequestCheck(orgId, job())
			}),
		)

		expect(Arr.map(outcomes, (o) => o.reason)).toEqual(["no_target", "draft", "action"])
		expect([outside.outcome, notTurnedOn.reason]).toEqual(["reported", "no_target"])
		// A target that expects the check gets one, as not blocking, even when the flags read as off.
		expect(disabled.notices).toEqual([
			"1111:unchecked:security audits are not enabled for this organization",
		])
		expect([harness.notices, harness.started, disabled.started, off.started]).toEqual([[], [], [], []])
	})

	it("stops the pull request's unfinished run when a newer push arrives", async () => {
		const harness = makeHarness()
		const runs = await harness.run(
			Effect.gen(function* () {
				const target = yield* harness.seeded
				yield* startPullRequestCheck(orgId, job())
				harness.currentHead.sha = NEXT_HEAD
				yield* startPullRequestCheck(orgId, job({ action: "synchronize", headSha: NEXT_HEAD }))
				return yield* harness.runsOf(target.id)
			}),
		)

		expect(harness.cancelled).toEqual([harness.started[0]?.runId])
		expect(Arr.map(harness.started, (p) => p.ref)).toEqual([HEAD, NEXT_HEAD])
		expect(
			Arr.sort(
				Arr.map(
					runs,
					(r) =>
						`${r.kind}:${r.prNumber}:${r.status}:${r.reason === null ? "" : Str.slice(0, 11)(r.reason)}`,
				),
				Order.String,
			),
		).toEqual(["pull_request:612:in_progress:", "pull_request:612:incomplete:superseded:"])
	})

	it("reports the check as not blocking when it cannot audit, instead of leaving it pending", async () => {
		const broke = makeHarness({ noCredits: true })
		const noCredits = await broke.run(
			Effect.gen(function* () {
				yield* broke.seeded
				return yield* startPullRequestCheck(orgId, job())
			}),
		)
		const removals = makeHarness({ files: () => Effect.succeed([file("src/old.ts", "removed")]) })
		const nothing = await removals.run(
			Effect.gen(function* () {
				yield* removals.seeded
				return yield* startPullRequestCheck(orgId, job())
			}),
		)
		const down = makeHarness({ files: () => Effect.die("GitHub is down") })
		const failed = await down.run(
			Effect.gen(function* () {
				yield* down.seeded
				return yield* startPullRequestCheck(orgId, job())
			}),
		)

		expect([noCredits.outcome, nothing.outcome, failed.outcome]).toEqual([
			"reported",
			"reported",
			"reported",
		])
		expect([...broke.notices, ...removals.notices, ...down.notices]).toEqual([
			"1111:unchecked:the organization has no AI credits left for security audits",
			"1111:unchecked:the pull request changes no file to audit",
			"1111:unchecked:an error stopped the check from starting",
		])
		expect([broke.started, removals.started, down.started]).toEqual([[], [], []])
	})
})

describe("startPullRequestCheck deliveries", () => {
	it("lets a redelivery of the same head leave the running check alone", async () => {
		const harness = makeHarness()
		const outcomes = await harness.run(
			Effect.gen(function* () {
				yield* harness.seeded
				return [
					yield* startPullRequestCheck(orgId, job()),
					yield* startPullRequestCheck(orgId, job({ action: "synchronize" })),
				]
			}),
		)

		expect(Arr.map(outcomes, (o) => o.reason ?? o.outcome)).toEqual(["started", "already_checking"])
		expect([harness.started.length, harness.cancelled, harness.notices]).toEqual([
			1,
			[],
			["1111:running"],
		])
	})

	it("settles a superseded run's own check, since its stopped Workflow never reports", async () => {
		const harness = makeHarness()
		await harness.run(
			Effect.gen(function* () {
				yield* harness.seeded
				yield* startPullRequestCheck(orgId, job())
				harness.currentHead.sha = NEXT_HEAD
				yield* startPullRequestCheck(orgId, job({ action: "synchronize", headSha: NEXT_HEAD }))
			}),
		)

		expect(harness.published).toEqual([harness.started[0]?.runId])
		expect(harness.notices).toEqual(["1111:running", "2222:running"])
	})

	it("audits the whole repository when a changed path cannot be scoped", async () => {
		const harness = makeHarness({ files: () => Effect.succeed([file("con.ts"), file("src/ok.ts")]) })
		await harness.run(
			Effect.gen(function* () {
				yield* harness.seeded
				yield* startPullRequestCheck(orgId, job())
			}),
		)

		expect(Arr.map(harness.started, (p) => p.scopePaths)).toEqual([[]])
	})
})

describe("startPullRequestCheck ordering and recovery", () => {
	it("ignores a late delivery for a head the pull request has moved past", async () => {
		const harness = makeHarness({ head: { sha: NEXT_HEAD } })
		const outcome = await harness.run(
			Effect.gen(function* () {
				yield* harness.seeded
				return yield* startPullRequestCheck(orgId, job())
			}),
		)

		expect(outcome.reason).toBe("stale_head")
		expect([harness.started, harness.notices, harness.cancelled]).toEqual([[], [], []])
	})

	it("starts the Workflow of a run whose first delivery was cut off before it", async () => {
		const harness = makeHarness()
		const orphan = await harness.run(
			Effect.gen(function* () {
				const target = yield* harness.seeded
				const store = (yield* SecurityAuditStore).forOrg(orgId)
				return yield* store.startRun({
					targetId: target.id,
					kind: "pull_request",
					prNumber: 612,
					sourceRef: HEAD,
					scopePaths: ["src/orders.ts"],
					discoveryModel: "discovery/model",
					validationModel: "validation/model",
				})
			}),
		)
		const outcome = await harness.run(startPullRequestCheck(orgId, job({ action: "synchronize" })))

		expect(outcome.reason).toBe("already_checking")
		expect(Arr.map(harness.started, (p) => [p.runId, p.scopePaths])).toEqual([
			[orphan.id, ["src/orders.ts"]],
		])
		expect(harness.notices).toEqual(["1111:running"])
	})
})

describe("startPullRequestCheck races and failed recovery", () => {
	it("stands down when a newer push started its run while this delivery was reading", async () => {
		const hook = { onFiles: Effect.void }
		const harness = makeHarness({
			files: () => hook.onFiles.pipe(Effect.as([file("src/orders.ts")])),
		})
		const result = await harness.run(
			Effect.gen(function* () {
				const target = yield* harness.seeded
				const store = (yield* SecurityAuditStore).forOrg(orgId)
				// While delivery A reads its files, push B lands and its run starts.
				hook.onFiles = store
					.startRun({
						targetId: target.id,
						kind: "pull_request",
						prNumber: 612,
						sourceRef: NEXT_HEAD,
					})
					.pipe(
						Effect.tap(() => Effect.sync(() => (harness.currentHead.sha = NEXT_HEAD))),
						Effect.asVoid,
						Effect.orDie,
					)
				const outcome = yield* startPullRequestCheck(orgId, job())
				return { outcome, runs: yield* harness.runsOf(target.id) }
			}),
		)

		expect(result.outcome.reason).toBe("stale_head")
		expect(harness.cancelled).toEqual([])
		expect(Arr.map(result.runs, (r) => r.status)).toEqual(["in_progress"])
	})

	it("settles an orphaned run whose Workflow cannot be started, instead of answering for it", async () => {
		const harness = makeHarness({ createFails: true })
		const result = await harness.run(
			Effect.gen(function* () {
				const target = yield* harness.seeded
				const store = (yield* SecurityAuditStore).forOrg(orgId)
				const orphan = yield* store.startRun({
					targetId: target.id,
					kind: "pull_request",
					prNumber: 612,
					sourceRef: HEAD,
					discoveryModel: "discovery/model",
					validationModel: "validation/model",
				})
				yield* startPullRequestCheck(orgId, job({ action: "synchronize" }))
				return { orphan, runs: yield* harness.runsOf(target.id) }
			}),
		)

		expect(harness.published).toEqual([result.orphan.id])
		expect(Arr.map(result.runs, (r) => r.status)).toEqual(["failed"])
	})
})

describe("startPullRequestCheck redelivery after a finished audit", () => {
	it("re-reports a finished audit of the same head instead of paying for another", async () => {
		const harness = makeHarness()
		const result = await harness.run(
			Effect.gen(function* () {
				const target = yield* harness.seeded
				yield* startPullRequestCheck(orgId, job())
				const store = (yield* SecurityAuditStore).forOrg(orgId)
				const first = harness.started[0]?.runId ?? ""
				yield* store.finishRun(first, { status: "complete" })
				const outcome = yield* startPullRequestCheck(orgId, job({ action: "reopened" }))
				return { outcome, first, runs: yield* harness.runsOf(target.id) }
			}),
		)

		expect(result.outcome.reason).toBe("already_checked")
		expect(harness.started.length).toBe(1)
		expect(harness.published).toEqual([result.first])
		expect(result.runs.length).toBe(1)
	})
})

describe("startPullRequestCheck edits and stale supersedes", () => {
	it("checks a pull request moved onto a checked branch by an edit, without a new push", async () => {
		const harness = makeHarness()
		const outcome = await harness.run(
			Effect.gen(function* () {
				yield* harness.seeded
				return yield* startPullRequestCheck(orgId, job({ action: "edited" }))
			}),
		)

		expect(outcome).toEqual({ outcome: "started" })
	})

	it("never stops another head's run once the delivery's own head is no longer current", async () => {
		// The head reads as this delivery's at first, then a newer push lands before it supersedes.
		const reads = { n: 0 }
		const head = {
			get sha() {
				reads.n += 1
				return reads.n === 1 ? HEAD : NEXT_HEAD
			},
		}
		const harness = makeHarness({ head })
		const result = await harness.run(
			Effect.gen(function* () {
				const target = yield* harness.seeded
				const store = (yield* SecurityAuditStore).forOrg(orgId)
				yield* store.startRun({
					targetId: target.id,
					kind: "pull_request",
					prNumber: 612,
					sourceRef: NEXT_HEAD,
				})
				const outcome = yield* startPullRequestCheck(orgId, job())
				return { outcome, runs: yield* harness.runsOf(target.id) }
			}),
		)

		expect(result.outcome.reason).toBe("stale_head")
		expect(harness.cancelled).toEqual([])
		expect(Arr.map(result.runs, (r) => r.status)).toEqual(["in_progress"])
	})
})

describe("startPullRequestCheck edits after an unfinished audit", () => {
	it("does not start another run when a title edit follows a cancelled run at the same head", async () => {
		const harness = makeHarness()
		const result = await harness.run(
			Effect.gen(function* () {
				const target = yield* harness.seeded
				yield* startPullRequestCheck(orgId, job())
				const store = (yield* SecurityAuditStore).forOrg(orgId)
				const first = harness.started[0]?.runId ?? ""
				yield* store.finishRun(first, { status: "incomplete", reason: "cancelled" })
				const outcome = yield* startPullRequestCheck(orgId, job({ action: "edited" }))
				return { outcome, runs: yield* harness.runsOf(target.id) }
			}),
		)

		expect(result.outcome.reason).toBe("already_checked")
		expect([harness.started.length, result.runs.length]).toEqual([1, 1])
		// The cancelled run's result is said again, in case its earlier write never landed.
		expect(harness.published).toEqual([harness.started[0]?.runId])
	})
})

describe("startPullRequestCheck flags read as off mid-audit", () => {
	it("leaves a running audit's check alone when a redelivery reads the rollout as off", async () => {
		const harness = makeHarness()
		const outcome = await harness.run(
			Effect.gen(function* () {
				yield* harness.seeded
				yield* startPullRequestCheck(orgId, job())
				harness.rollout.enabled = false
				return yield* startPullRequestCheck(orgId, job({ action: "synchronize" }))
			}),
		)

		expect(outcome.reason).toBe("already_checking")
		expect(harness.notices).toEqual(["1111:running"])
	})
})

describe("startPullRequestCheck fail-open reports", () => {
	it("reports not blocking once the org's monthly audit spend limit is reached", async () => {
		const harness = makeHarness()
		const outcome = await harness.run(
			Effect.gen(function* () {
				const target = yield* harness.seeded
				const store = (yield* SecurityAuditStore).forOrg(orgId)
				yield* store.saveSettings({
					monthlySpendLimitUsd: 1,
					discoveryModel: "discovery/model",
					validationModel: "validation/model",
					updatedBy: asUserId("user_1"),
				})
				// A branch audit already spent past the limit this month.
				const branch = yield* store.startRun({
					targetId: target.id,
					kind: "manual",
					sourceRef: "main",
				})
				yield* store.reserveOrgInvocation(branch.id, "hunter-1", {
					since: 0,
					limitUsd: 1000,
					sandboxFeeUsd: 5,
				})
				yield* store.finishRun(branch.id, { status: "complete" })
				return yield* startPullRequestCheck(orgId, job())
			}),
		)

		expect(outcome.outcome).toBe("reported")
		expect(harness.notices).toEqual([
			"1111:unchecked:the organization reached its monthly security audit spend limit",
		])
		expect(harness.started).toEqual([])
	})

	it("settles a fresh run whose Workflow cannot start and reports not blocking", async () => {
		const harness = makeHarness({ createFails: true })
		const result = await harness.run(
			Effect.gen(function* () {
				const target = yield* harness.seeded
				const outcome = yield* startPullRequestCheck(orgId, job())
				return { outcome, runs: yield* harness.runsOf(target.id) }
			}),
		)

		expect(result.outcome.outcome).toBe("reported")
		expect(harness.notices).toEqual(["1111:running", "1111:unchecked:the audit could not start"])
		expect(Arr.map(result.runs, (r) => r.status)).toEqual(["failed"])
	})
})

describe("startPullRequestCheck flags read as off after a finished audit", () => {
	it("re-reports the head's finished run instead of a not-blocking check", async () => {
		const harness = makeHarness()
		const outcome = await harness.run(
			Effect.gen(function* () {
				yield* harness.seeded
				yield* startPullRequestCheck(orgId, job())
				const store = (yield* SecurityAuditStore).forOrg(orgId)
				yield* store.finishRun(harness.started[0]?.runId ?? "", { status: "complete" })
				harness.rollout.enabled = false
				return yield* startPullRequestCheck(orgId, job({ action: "synchronize" }))
			}),
		)

		expect(outcome.reason).toBe("already_checking")
		expect(harness.published).toEqual([harness.started[0]?.runId])
		expect(harness.notices).toEqual(["1111:running"])
	})
})
