import { afterEach, describe, expect, it } from "@effect/vitest"
import type { PullRequestCheckAnnotation } from "@maple/domain/http"
import {
	asOrgId,
	asUserId,
	testEnv,
	testRepoLayer,
	upsertReposFor,
} from "@maple/backend/services/integrations/vcs/__tests__/harness"
import type { VcsProviderClient } from "@maple/backend/services/integrations/vcs/VcsProviderClient"
import {
	VcsProviderRegistry,
	type VcsProviderRegistryApi,
} from "@maple/backend/services/integrations/vcs/VcsProviderRegistry"
import { VcsRepository } from "@maple/backend/services/integrations/vcs/VcsRepository"
import { SecurityAuditStore } from "@maple/backend/services/security-audit/SecurityAuditStore"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import type { Finding, Severity } from "@maple/security-audit"
import { Array as Arr, Effect, Layer, Stream } from "effect"
import { SecurityPrCheck } from "./pr-check"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const orgId = asOrgId("org_pr_publish")
const HEAD = "1111111111111111111111111111111111111111"
const user = asUserId("user_1")

const confirmed = (fingerprint: string, severity: Severity): Finding => ({
	verdict: "confirmed",
	fingerprint,
	title: `Finding ${fingerprint}`,
	description: "unscoped lookup",
	root_cause: "missing org predicate",
	intended_behavior: "scoped",
	trace: [{ kind: "sink", file: "src/keys.ts", line: 42, scope: "rollKey", description: "lookup" }],
	evidence: [],
	conditions: [],
	execution: { attacker_perspective: "member", payloads: [], instructions: [], observed_result: "rolled" },
	remediation: { strategy: "filter by org" },
	severity: {
		likelihood: { score: "medium", reason: "needs an id" },
		impact: { score: severity, reason: "cross-tenant" },
		overall_severity: severity,
	},
	confidence: { score: "high", reason: "reproduced" },
})

interface WrittenCheck {
	readonly headSha: string
	readonly state: string
	readonly title: string
	readonly annotations: ReadonlyArray<PullRequestCheckAnnotation>
	readonly detailsUrl: string | undefined
}

/** Only check writes are reached; any other provider call fails the test loudly. */
const providerWith = (writeCheck: VcsProviderClient["writePullRequestCheck"]): VcsProviderClient => {
	const unused = () => Effect.die("not used by the security check")
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
		fetchPullRequestFiles: unused,
		fetchReviewThreads: unused,
		hideEarlierComments: unused,
		resolveReviewThread: unused,
		fetchChangesSince: unused,
		fetchPullRequestHead: unused,
		postPullRequestReply: unused,
		reactToComment: unused,
		fetchCommenterPermission: unused,
		commitFiles: unused,
		fetchPullRequestContext: unused,
		publishPullRequestReview: unused,
		writePullRequestCheck: writeCheck,
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

const makeHarness = () => {
	const db = createTestDb(trackedDbs)
	const checks: Array<WrittenCheck> = []
	const provider = providerWith((_installation, _repo, input) =>
		Effect.sync(() => {
			checks.push({
				headSha: input.headSha,
				state: input.state.status === "completed" ? input.state.conclusion : input.state.status,
				title: input.title,
				annotations: input.annotations ?? [],
				detailsUrl: input.detailsUrl,
			})
			return { url: null }
		}),
	)
	const deps = Layer.mergeAll(
		SecurityAuditStore.layer.pipe(Layer.provide(db.layer)),
		testRepoLayer(db),
		Layer.succeed(VcsProviderRegistry, {
			ids: ["github"],
			resolve: () => Effect.succeed(provider),
		} satisfies VcsProviderRegistryApi),
		testEnv(),
	)
	const layer = Layer.effect(SecurityPrCheck, SecurityPrCheck.make).pipe(Layer.provideMerge(deps))

	/** A connected repository and its target, checking pull requests at the default threshold. */
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
			installedByUserId: user,
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
		const target = yield* store.createTarget({ repository: "octo/repo", branch: "main", createdBy: user })
		yield* store.updateTarget(target.id, { prCheckEnabled: true })
		return { store, target }
	})

	const run = <A, E>(body: Effect.Effect<A, E, Layer.Success<typeof layer>>) =>
		Effect.runPromise(body.pipe(Effect.provide(layer)))

	return { run, seeded, checks }
}

describe("SecurityPrCheck.publish", () => {
	it("fails the head on a new blocker, passes once a person accepts its risk, and links the run", async () => {
		const harness = makeHarness()
		await harness.run(
			Effect.gen(function* () {
				const { store, target } = yield* harness.seeded
				const checks = yield* SecurityPrCheck
				const run = yield* store.startRun({
					targetId: target.id,
					kind: "pull_request",
					prNumber: 9,
					sourceRef: HEAD,
				})
				yield* store.saveFindings(
					run.id,
					[confirmed("p1", "critical"), confirmed("p2", "medium")],
					new Map(),
				)
				yield* store.finishRun(run.id, { status: "complete" })
				yield* checks.publish(orgId, run.id)
				yield* store.setRunFindingStatus(run.id, "p1", "accepted_risk", "behind SSO", user)
				yield* checks.publish(orgId, run.id)
			}),
		)

		expect(Arr.map(harness.checks, (c) => [c.headSha, c.state, c.title])).toEqual([
			[HEAD, "failure", "1 security issue blocks this merge"],
			[HEAD, "success", "No blocking issues · 1 finding below the threshold"],
		])
		expect(Arr.map(harness.checks[0]?.annotations ?? [], (a) => a.level)).toEqual(["failure", "warning"])
		expect(harness.checks[0]?.detailsUrl).toMatch(/\/security\/code\/runs\/[0-9a-f-]{36}$/)
	})

	it("does not block on a finding the branch's own audit already follows", async () => {
		const harness = makeHarness()
		await harness.run(
			Effect.gen(function* () {
				const { store, target } = yield* harness.seeded
				const checks = yield* SecurityPrCheck
				const branchRun = yield* store.startRun({
					targetId: target.id,
					kind: "manual",
					sourceRef: "main",
				})
				yield* store.saveFindings(branchRun.id, [confirmed("old", "critical")], new Map())
				yield* store.finishRun(branchRun.id, { status: "complete" })
				const run = yield* store.startRun({
					targetId: target.id,
					kind: "pull_request",
					prNumber: 9,
					sourceRef: HEAD,
				})
				yield* store.saveFindings(run.id, [confirmed("old", "critical")], new Map())
				yield* store.finishRun(run.id, { status: "complete" })
				yield* checks.publish(orgId, run.id)
			}),
		)

		expect(Arr.map(harness.checks, (c) => [c.state, Arr.map(c.annotations, (a) => a.level)])).toEqual([
			["success", ["notice"]],
		])
	})

	it("leaves a run that is not a pull request's, or not finished, alone", async () => {
		const harness = makeHarness()
		await harness.run(
			Effect.gen(function* () {
				const { store, target } = yield* harness.seeded
				const checks = yield* SecurityPrCheck
				const manual = yield* store.startRun({
					targetId: target.id,
					kind: "manual",
					sourceRef: "main",
				})
				yield* store.finishRun(manual.id, { status: "complete" })
				const running = yield* store.startRun({
					targetId: target.id,
					kind: "pull_request",
					prNumber: 9,
					sourceRef: HEAD,
				})
				yield* checks.publish(orgId, manual.id)
				yield* checks.publish(orgId, running.id)
				yield* checks.publish(orgId, "missing-run")
			}),
		)

		expect(harness.checks).toEqual([])
	})
})

describe("SecurityPrCheck.publish branch findings and reruns", () => {
	it("keeps a branch finding from blocking even after a person reopened it", async () => {
		const harness = makeHarness()
		await harness.run(
			Effect.gen(function* () {
				const { store, target } = yield* harness.seeded
				const checks = yield* SecurityPrCheck
				const branchRun = yield* store.startRun({
					targetId: target.id,
					kind: "manual",
					sourceRef: "main",
				})
				yield* store.saveFindings(branchRun.id, [confirmed("old", "critical")], new Map())
				yield* store.finishRun(branchRun.id, { status: "complete" })
				yield* store.setFindingStatus(target.id, "old", "dismissed", "noise", user)
				yield* store.setFindingStatus(target.id, "old", "open", "real after all", user)
				const run = yield* store.startRun({
					targetId: target.id,
					kind: "pull_request",
					prNumber: 9,
					sourceRef: HEAD,
				})
				yield* store.saveFindings(run.id, [confirmed("old", "critical")], new Map())
				yield* store.finishRun(run.id, { status: "complete" })
				yield* checks.publish(orgId, run.id)
			}),
		)

		expect(Arr.map(harness.checks, (c) => c.state)).toEqual(["success"])
	})

	it("does not overwrite a newer run's check on the same head", async () => {
		const harness = makeHarness()
		await harness.run(
			Effect.gen(function* () {
				const { store, target } = yield* harness.seeded
				const checks = yield* SecurityPrCheck
				const older = yield* store.startRun({
					targetId: target.id,
					kind: "pull_request",
					prNumber: 9,
					sourceRef: HEAD,
				})
				yield* store.finishRun(older.id, { status: "complete" })
				const newer = yield* store.startRun({
					targetId: target.id,
					kind: "pull_request",
					prNumber: 9,
					sourceRef: HEAD,
				})
				yield* store.finishRun(newer.id, { status: "complete" })
				yield* checks.publish(orgId, older.id)
				yield* checks.publish(orgId, newer.id)
			}),
		)

		expect(Arr.map(harness.checks, (c) => c.state)).toEqual(["success"])
	})
})
