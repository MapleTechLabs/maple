import { afterEach, assert, describe, it } from "@effect/vitest"
import { DependencyFindingId } from "@maple/domain/dependency-scan"
import { GitCommitSha, VcsRepositoryId, type VcsSyncJob } from "@maple/domain/http"
import { OrgId, UserId } from "@maple/domain/primitives"
import { Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { VcsRepository } from "@maple/backend/services/integrations/vcs/VcsRepository"
import {
	recordingQueueLayer,
	testRepoLayer,
} from "@maple/backend/services/integrations/vcs/__tests__/harness"
import { systemTenant } from "@maple/backend/services/alerts/system-tenant"
import {
	DependencyScanService,
	PRODUCTION_SCANS_PER_READ,
	type RunningCommitRow,
	RunningCommits,
	RunningCommitsReadError,
} from "./DependencyScanService"
import { DependencyScanStore } from "./DependencyScanStore"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const org = Schema.decodeSync(OrgId)("org_deps")
const admin = Schema.decodeSync(UserId)("user_admin")
const sha = (digit: string) => Schema.decodeSync(GitCommitSha)(digit.repeat(40))

const tenant = systemTenant(org)

/** What telemetry says services ran; `undefined` makes the read fail. */
interface Telemetry {
	rows: ReadonlyArray<RunningCommitRow> | undefined
}

const serviceFor = (sent: Array<VcsSyncJob>, telemetry: Telemetry = { rows: [] }) => {
	const db = createTestDb(trackedDbs)
	const store = DependencyScanStore.layer.pipe(Layer.provide(db.layer))
	const vcs = testRepoLayer(db)
	const running = Layer.succeed(RunningCommits, {
		read: () =>
			telemetry.rows === undefined
				? Effect.fail(new RunningCommitsReadError({ message: "warehouse down", cause: undefined }))
				: Effect.succeed(telemetry.rows),
	})
	return Layer.effect(DependencyScanService, DependencyScanService.make).pipe(
		Layer.provideMerge(Layer.mergeAll(store, vcs, recordingQueueLayer(sent), running)),
	)
}

/** One active installation with two repositories; returns the first one's id. */
const seed = Effect.gen(function* () {
	const vcs = yield* VcsRepository
	const installation = yield* vcs.upsertInstallation({
		orgId: org,
		provider: "github",
		externalInstallationId: "42",
		accountLogin: "octo",
		accountType: "organization",
		externalAccountId: "100",
		accountAvatarUrl: null,
		repositorySelection: "all",
		installedByUserId: admin,
	})
	const repo = (externalRepoId: string, name: string) => ({
		externalRepoId,
		owner: "octo",
		name,
		fullName: `octo/${name}`,
		defaultBranch: "main",
		htmlUrl: `https://github.com/octo/${name}`,
		isPrivate: true,
		isArchived: false,
	})
	yield* vcs.upsertRepositories(installation, [repo("8", "web"), repo("7", "api")])
	const repositories = yield* vcs.listRepositoriesByInstallation(installation.id, "active")
	const api = repositories.find((repository) => repository.fullName === "octo/api")
	if (api === undefined) return yield* Effect.die("seeding did not store octo/api")
	return api
})

const recordScan = (repositoryId: VcsRepositoryId, commit: string, defaultBranchHead: boolean) =>
	Effect.gen(function* () {
		const store = yield* DependencyScanStore
		// Scans of one repository start at distinct times; "latest" is by start time.
		yield* TestClock.adjust("1 second")
		const scan = yield* store.startScan({
			orgId: org,
			repositoryId,
			commitSha: sha(commit),
			ref: defaultBranchHead ? "main" : null,
			trigger: defaultBranchHead ? "schedule" : "production",
			defaultBranchHead,
		})
		return yield* store.completeScan({
			orgId: org,
			scanId: scan.id,
			lockfiles: [
				{
					path: "bun.lock",
					kind: "bun-lock",
					blobSha: commit,
					packageCount: 1,
					status: "parsed",
					message: null,
				},
			],
			packageCount: 1,
			matches: [
				{
					lockfilePath: "bun.lock",
					ecosystem: "npm",
					packageName: "lodash",
					version: "4.17.15",
					relation: "direct",
					advisoryId: "GHSA-p6mc-m468-83gw",
					aliases: ["CVE-2020-8203"],
					severity: "high",
					summary: "Prototype pollution in lodash",
					fixedIn: "4.17.19",
				},
			],
		})
	})

describe("DependencyScanService", () => {
	it.effect("lists every connected repository with its latest tracked-branch scan", () => {
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const service = yield* DependencyScanService
			const api = yield* seed
			const before = yield* service.listRepositories(tenant)
			assert.deepStrictEqual(
				before.repositories.map((repository) => [repository.fullName, repository.latestScan]),
				[
					["octo/api", null],
					["octo/web", null],
				],
			)
			yield* recordScan(api.id, "a", true)
			const latest = yield* recordScan(api.id, "b", true)
			// An older commit scanned because it runs in production is not the branch's latest scan.
			yield* recordScan(api.id, "c", false)
			const after = yield* service.listRepositories(tenant)
			assert.strictEqual(after.repositories[0]?.latestScan?.id, latest.id)
			assert.strictEqual(after.repositories[0]?.latestScan?.vulnerableCount, 1)
		}).pipe(Effect.provide(serviceFor(sent)))
	})

	it.effect("queues a manual scan for a connected repository and refuses an unknown one", () => {
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const service = yield* DependencyScanService
			const api = yield* seed
			assert.deepStrictEqual(yield* service.requestScan(org, api.id), { queued: true })
			assert.deepStrictEqual(sent, [
				{
					kind: "dependency-scan",
					provider: "github",
					externalInstallationId: "42",
					externalRepoId: "7",
					trigger: "manual",
				},
			])
			const unknown = Schema.decodeSync(VcsRepositoryId)("00000000-0000-4000-8000-0000000000ff")
			const error = yield* Effect.flip(service.requestScan(org, unknown))
			assert.strictEqual(
				error._tag,
				"@maple/http/dependency-scan/DependencyScanRepositoryNotFoundError",
			)
		}).pipe(Effect.provide(serviceFor(sent)))
	})

	it.effect("names each finding's repository and records who dismissed it and why", () => {
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const service = yield* DependencyScanService
			const api = yield* seed
			yield* recordScan(api.id, "a", true)
			const { findings } = yield* service.listFindings(tenant, {})
			assert.deepStrictEqual(
				findings.map((finding) => [finding.repositoryFullName, finding.packageName, finding.status]),
				[["octo/api", "lodash", "open"]],
			)
			const [finding] = findings
			if (finding === undefined) return
			const dismissed = yield* service.updateFinding(org, admin, finding.id, {
				status: "dismissed",
				reason: "Only used in a build script",
			})
			assert.deepStrictEqual(
				[dismissed.status, dismissed.statusReason, dismissed.statusChangedBy],
				["dismissed", "Only used in a build script", admin],
			)
			assert.deepStrictEqual((yield* service.listFindings(tenant, { status: "open" })).findings, [])

			const missing = Schema.decodeSync(DependencyFindingId)("0".repeat(32))
			const error = yield* Effect.flip(service.updateFinding(org, admin, missing, { status: "open" }))
			assert.strictEqual(error._tag, "@maple/http/dependency-scan/DependencyFindingNotFoundError")
		}).pipe(Effect.provide(serviceFor(sent)))
	})
})

const commitOf = (digit: string) => ({
	sha: digit.repeat(40),
	message: `commit ${digit}`,
	authorName: null,
	authorEmail: null,
	authorLogin: null,
	authorAvatarUrl: null,
	authoredAt: null,
	committedAt: 1,
	htmlUrl: `https://github.com/octo/api/commit/${digit.repeat(40)}`,
})

const running = (
	serviceName: string,
	environment: string,
	commit: string,
	spanCount: number,
): RunningCommitRow => ({
	serviceName,
	environment,
	commitSha: commit.length === 1 ? commit.repeat(40) : commit,
	spanCount,
})

describe("DependencyScanService production", () => {
	it.effect(
		"joins findings to the services running a commit whose scan matched them, and queues unscanned commits",
		() => {
			const sent: Array<VcsSyncJob> = []
			const telemetry: Telemetry = {
				rows: [
					running("api-server", "production", "c", 9000),
					running("worker", "production", "d", 50),
					running("api-server", "staging", "a", 100),
					// Not a commit of a connected repository, and a placeholder revision.
					running("billing", "production", "f", 400),
					running("legacy", "production", "unknown", 10),
				],
			}
			return Effect.gen(function* () {
				const service = yield* DependencyScanService
				const vcs = yield* VcsRepository
				const api = yield* seed
				yield* vcs.upsertCommits(api, [commitOf("a"), commitOf("c"), commitOf("d")])
				yield* recordScan(api.id, "c", false)
				yield* recordScan(api.id, "a", true)

				const { findings, production } = yield* service.listFindings(tenant, {})
				// Services, not rows: api-server runs two commits and counts once.
				assert.deepStrictEqual(production, { available: true, runningServices: 4, linkedServices: 2 })
				assert.deepStrictEqual(
					findings[0]?.production?.map((s) => [
						s.serviceName,
						s.environment,
						s.commitSha.slice(0, 1),
						s.spanCount,
					]),
					[
						["api-server", "production", "c", 9000],
						["api-server", "staging", "a", 100],
					],
				)
				assert.deepStrictEqual(
					sent.map((job) =>
						job.kind === "dependency-scan" ? [job.trigger, job.commitSha] : [job.kind],
					),
					[["production", sha("d")]],
				)

				const { repositories } = yield* service.listRepositories(tenant)
				assert.deepStrictEqual(
					repositories[0]?.runningCommits?.map((commit) => [
						commit.commitSha.slice(0, 1),
						commit.scanStatus,
					]),
					[
						["c", "completed"],
						["d", null],
						["a", "completed"],
					],
				)
			}).pipe(Effect.provide(serviceFor(sent, telemetry)))
		},
	)

	it.effect(
		"retries a running commit whose scan failed an hour ago, and keeps its older completed scan's matches",
		() => {
			const sent: Array<VcsSyncJob> = []
			const telemetry: Telemetry = { rows: [running("api-server", "production", "c", 9000)] }
			return Effect.gen(function* () {
				const service = yield* DependencyScanService
				const store = yield* DependencyScanStore
				const vcs = yield* VcsRepository
				const api = yield* seed
				yield* vcs.upsertCommits(api, [commitOf("c")])
				yield* recordScan(api.id, "a", true)
				yield* recordScan(api.id, "c", false)
				yield* TestClock.adjust("1 second")
				const failed = yield* store.startScan({
					orgId: org,
					repositoryId: api.id,
					commitSha: sha("c"),
					ref: null,
					trigger: "production",
					defaultBranchHead: false,
				})
				yield* store.failScan({ orgId: org, scanId: failed.id, error: "GitHub answered 502" })

				const { findings } = yield* service.listFindings(tenant, {})
				assert.deepStrictEqual(
					findings.map((finding) => finding.production?.map((s) => s.serviceName)),
					[["api-server"]],
				)
				assert.deepStrictEqual(sent, [])

				yield* TestClock.adjust("61 minutes")
				yield* service.listRepositories(tenant)
				assert.deepStrictEqual(
					sent.map((job) => (job.kind === "dependency-scan" ? job.commitSha : undefined)),
					[sha("c")],
				)
			}).pipe(Effect.provide(serviceFor(sent, telemetry)))
		},
	)

	it.effect("queues at most a handful of unscanned commits per read", () => {
		const sent: Array<VcsSyncJob> = []
		const digits = "0123456789abcdef".split("")
		const telemetry: Telemetry = {
			rows: digits.map((digit, i) => running(`svc-${i}`, "production", digit, 100 - i)),
		}
		return Effect.gen(function* () {
			const service = yield* DependencyScanService
			const vcs = yield* VcsRepository
			const api = yield* seed
			yield* vcs.upsertCommits(api, digits.map(commitOf))
			yield* service.listRepositories(tenant)
			assert.strictEqual(sent.length, PRODUCTION_SCANS_PER_READ)
			assert.strictEqual(sent[0]?.kind === "dependency-scan" ? sent[0].commitSha : undefined, sha("0"))
		}).pipe(Effect.provide(serviceFor(sent, telemetry)))
	})

	it.effect("still lists findings, unranked by traffic, when telemetry cannot be read", () => {
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const service = yield* DependencyScanService
			const api = yield* seed
			yield* recordScan(api.id, "a", true)
			const { findings, production } = yield* service.listFindings(tenant, {})
			assert.deepStrictEqual(production, { available: false, runningServices: 0, linkedServices: 0 })
			assert.deepStrictEqual(
				findings.map((finding) => [finding.packageName, finding.production]),
				[["lodash", []]],
			)
		}).pipe(Effect.provide(serviceFor(sent, { rows: undefined })))
	})
})
