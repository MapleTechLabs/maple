/**
 * The post-merge tick over a real PGlite: a due row is looked at once however many ticks overlap,
 * and a read that fails is retried rather than reported as a clean deploy.
 */
import { afterEach, assert, describe, it } from "@effect/vitest"
import {
	GitCommitSha,
	PrReviewHotFile,
	PrReviewId,
	PrReviewOperationTraffic,
	PrReviewTelemetry,
} from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import { PrReviews } from "@maple/db/tables"
import { DateTime, Effect, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/platform/test-pglite"
import {
	asOrgId,
	asUserId,
	testRepoLayer,
	upsertReposFor,
} from "@maple/backend/services/integrations/vcs/__tests__/harness"
import type { VcsProviderClient } from "@maple/backend/services/integrations/vcs/VcsProviderClient"
import { VcsProviderRegistry } from "@maple/backend/services/integrations/vcs/VcsProviderRegistry"
import { VcsRepository } from "@maple/backend/services/integrations/vcs/VcsRepository"
import { PrReviewPostMergeService } from "./PrReviewPostMergeService"
import {
	PrReviewTelemetryReadError,
	PrReviewTelemetryService,
	type PrReviewTelemetryServiceApi,
} from "./telemetry/PrReviewTelemetryService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const orgId = asOrgId("org_post_merge")
const reviewId = Schema.decodeSync(PrReviewId)("6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7")
const HEAD = Schema.decodeSync(GitCommitSha)("1111111111111111111111111111111111111111")
const MERGED_AT = Date.parse("2026-10-01T10:00:00Z")
const DEPLOYED_AT = MERGED_AT + 20 * 60_000

const facts = new PrReviewTelemetry({
	windowDays: 7,
	services: ["api"],
	contractBreaks: [],
	hotFiles: [
		new PrReviewHotFile({
			path: "src/checkout.ts",
			perDay: 24_000,
			operations: [
				new PrReviewOperationTraffic({
					service: "api",
					spanName: "POST /checkout",
					perDay: 24_000,
					errorRate: 0,
					p95Ms: 200,
				}),
			],
		}),
	],
	linkedIssues: [],
	costNotes: [],
	added: [],
	removed: [],
})

const telemetryFake = (options: { readonly failOperations: boolean }): PrReviewTelemetryServiceApi => ({
	analyze: () => Effect.succeed(undefined),
	commitTimes: () => Effect.succeed(new Map()),
	deploymentsSince: () =>
		Effect.succeed([
			{
				service: "api",
				environment: "production",
				commitSha: "ccc",
				firstSeen: DateTime.makeUnsafe(DEPLOYED_AT),
			},
		]),
	operationsIn: () =>
		options.failOperations
			? Effect.fail(new PrReviewTelemetryReadError({ message: "could not read operation window" }))
			: Effect.succeed([
					{ service: "api", spanName: "POST /checkout", count: 1_000, errorCount: 0, p95Ms: 200 },
				]),
	issueCountsIn: () => Effect.succeed(new Map()),
	issuesFirstSeenSince: () => Effect.succeed([]),
	attributeKeysIn: () => Effect.succeed(new Set(["http.route"])),
})

const layerFor = (
	testDb: TestDb,
	posted: Array<string>,
	options: { readonly failOperations: boolean },
	telemetry: PrReviewTelemetryServiceApi = telemetryFake(options),
) => {
	const unused = () => Effect.die("not used by the post-merge tick")
	const provider: VcsProviderClient = {
		id: "github",
		reviewerMention: "@maple-review-bot",
		webhookToJobs: unused,
		fetchRepositories: unused,
		fetchCommits: unused,
		fetchBranches: unused,
		fetchCommit: unused,
		fetchPullRequests: unused,
		fetchPullRequest: unused,
		fetchPullRequestFiles: unused,
		fetchReviewThreads: unused,
		resolveReviewThread: unused,
		fetchChangesSince: unused,
		fetchPullRequestHead: unused,
		postPullRequestReply: (_installation, _repo, input) =>
			Effect.sync(() => {
				posted.push(input.body)
				return { url: "https://github.com/octo/repo/pull/612#issuecomment-2" }
			}),
		reactToComment: unused,
		fetchCommenterPermission: unused,
		commitFiles: unused,
		fetchPullRequestContext: unused,
		publishPullRequestReview: unused,
		writePullRequestCheck: unused,
		writePullRequestSummaryComment: unused,
		searchCode: unused,
		resolveRef: unused,
		fetchCloneCredentials: unused,
		fetchSourceFile: unused,
	}
	return Layer.effect(PrReviewPostMergeService, PrReviewPostMergeService.make).pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				testRepoLayer(testDb),
				testDb.layer,
				Layer.succeed(VcsProviderRegistry, {
					ids: ["github"],
					resolve: () => Effect.succeed(provider),
				}),
				Layer.succeed(PrReviewTelemetryService, telemetry),
			),
		),
	)
}

/** A connected repository with one merged, reviewed pull request whose look is due. */
const seedDueReview = Effect.gen(function* () {
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
	const repositoryId = Option.getOrThrow(yield* repo.resolveRepository(orgId, "github", "7")).id
	const db = yield* Database
	yield* db.execute((client) =>
		client.run(
			PG.insertInto(PrReviews).values({
				id: reviewId,
				orgId,
				repositoryId,
				number: 612,
				headSha: HEAD,
				url: "https://github.com/octo/repo/pull/612",
				status: "completed",
				telemetryJson: facts,
				mergedAt: MERGED_AT,
				mergeCommitSha: "ccc",
				postMergeStatus: "waiting",
				postMergeAfter: MERGED_AT,
				createdAt: MERGED_AT,
				updatedAt: MERGED_AT,
			}),
		),
	)
})

const rowState = Effect.gen(function* () {
	const db = yield* Database
	const rows = yield* db.execute((client) =>
		client.run(
			PG.from(PrReviews)
				.select(($) => ({ status: $.postMergeStatus, after: $.postMergeAfter }))
				.where(($) => [$.id.eq(reviewId)]),
		),
	)
	return rows[0]
})

describe("PrReviewPostMergeService.runTick", () => {
	it.effect("posts the follow-up once when ticks overlap", () => {
		const testDb = createTestDb(trackedDbs)
		const posted: Array<string> = []
		return Effect.gen(function* () {
			yield* seedDueReview
			yield* TestClock.setTime(DEPLOYED_AT + 70 * 60_000)
			const service = yield* PrReviewPostMergeService
			yield* Effect.all([service.runTick(), service.runTick()], { concurrency: 2 })
			assert.lengthOf(posted, 1)
			assert.include(posted[0] ?? "", "Shipped clean")
			assert.equal((yield* rowState)?.status, "reported")
		}).pipe(Effect.provide(layerFor(testDb, posted, { failOperations: false })))
	})

	it.effect("retries a failed read later instead of reporting a clean deploy", () => {
		const testDb = createTestDb(trackedDbs)
		const posted: Array<string> = []
		return Effect.gen(function* () {
			yield* seedDueReview
			const now = DEPLOYED_AT + 70 * 60_000
			yield* TestClock.setTime(now)
			const service = yield* PrReviewPostMergeService
			const result = yield* service.runTick()
			assert.equal(result.failedRows, 1)
			assert.lengthOf(posted, 0)
			assert.deepStrictEqual(yield* rowState, { status: "waiting", after: now + 30 * 60_000 })

			// Still failing two days after the merge: given up as failed, never reported clean.
			yield* TestClock.setTime(MERGED_AT + 49 * 3_600_000)
			yield* service.runTick()
			assert.lengthOf(posted, 0)
			assert.equal((yield* rowState)?.status, "failed")
		}).pipe(Effect.provide(layerFor(testDb, posted, { failOperations: true })))
	})
})

describe("PrReviewPostMergeService.runTick, stored telemetry", () => {
	it.effect("gives up on a row whose telemetry is in an older shape instead of failing the tick", () => {
		const testDb = createTestDb(trackedDbs)
		const posted: Array<string> = []
		return Effect.gen(function* () {
			yield* seedDueReview
			yield* Effect.promise(() =>
				executeSql(testDb, "update pr_reviews set telemetry_json = $1::jsonb where id = $2", [
					JSON.stringify({ services: "checkout" }),
					reviewId,
				]),
			)
			yield* TestClock.setTime(DEPLOYED_AT + 70 * 60_000)
			const result = yield* (yield* PrReviewPostMergeService).runTick()
			assert.equal(result.examined, 1)
			assert.equal(result.gaveUp, 1)
			assert.lengthOf(posted, 0)
			assert.equal((yield* rowState)?.status, "no_traffic")
		}).pipe(Effect.provide(layerFor(testDb, posted, { failOperations: false })))
	})
})

describe("PrReviewPostMergeService.runTick, lease", () => {
	it.effect("does not report when a later tick took the row while this one ran", () => {
		const testDb = createTestDb(trackedDbs)
		const posted: Array<string> = []
		// Another tick re-leases the row while this one reads the warehouse.
		const releaseRow = Effect.gen(function* () {
			const db = yield* Database
			yield* db.execute((client) =>
				client.run(
					PG.update(PrReviews)
						.set({ postMergeAfter: DEPLOYED_AT + 999 * 60_000 })
						.where(($) => [$.id.eq(reviewId)]),
				),
			)
		}).pipe(Effect.provide(testDb.layer), Effect.orDie)
		const racing: PrReviewTelemetryServiceApi = {
			...telemetryFake({ failOperations: false }),
			operationsIn: () =>
				releaseRow.pipe(
					Effect.as([
						{
							service: "api",
							spanName: "POST /checkout",
							count: 1_000,
							errorCount: 0,
							p95Ms: 200,
						},
					]),
				),
		}
		return Effect.gen(function* () {
			yield* seedDueReview
			yield* TestClock.setTime(DEPLOYED_AT + 70 * 60_000)
			const service = yield* PrReviewPostMergeService
			yield* service.runTick()
			assert.lengthOf(posted, 0)
			assert.equal((yield* rowState)?.status, "waiting")
		}).pipe(Effect.provide(layerFor(testDb, posted, { failOperations: false }, racing)))
	})
})
