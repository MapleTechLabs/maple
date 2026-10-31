import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import {
	GitCommitSha,
	OrgId,
	PrReviewId,
	RoleName,
	UserId,
	VcsInstallationId,
	VcsRepositoryId,
} from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import { PrReviewFindings, PrReviews, VcsRepositories } from "@maple/db/tables"
import { compiledQueryOf } from "@maple/query-engine/execution"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { CodeReviewTeamService, median } from "./CodeReviewTeamService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeUnknownSync(OrgId)("org_team")
const OTHER_ORG = Schema.decodeUnknownSync(OrgId)("org_other")
const REPO = Schema.decodeUnknownSync(VcsRepositoryId)("00000000-0000-4000-8000-000000000001")
const OTHER_REPO = Schema.decodeUnknownSync(VcsRepositoryId)("00000000-0000-4000-8000-000000000002")
const INSTALLATION = Schema.decodeUnknownSync(VcsInstallationId)("00000000-0000-4000-8000-0000000000aa")
const reviewId = (n: number) =>
	Schema.decodeUnknownSync(PrReviewId)(`00000000-0000-4000-9000-${String(n).padStart(12, "0")}`)
const tenant: TenantContext = {
	orgId: ORG,
	userId: Schema.decodeUnknownSync(UserId)("user_team"),
	roles: [Schema.decodeUnknownSync(RoleName)("org:admin")],
	authMode: "self_hosted",
}

const HOUR = 3_600_000
const START = Date.UTC(2026, 9, 1)
const at = (hours: number) => START + hours * HOUR
const window = { startTime: START, endTime: at(240) }

const postMerge = (verdict: "clean" | "regressed") => ({
	deploy: {
		service: "api",
		environment: "production",
		commitSha: "b".repeat(40),
		firstSeen: at(30),
		exact: true,
	},
	windowMinutes: 60,
	operations: [],
	newIssues: [],
	linkedIssues: [],
	missing: [],
	verdict,
})

const review = (input: {
	n: number
	number: number
	author: string
	created: number
	orgId?: OrgId
	repositoryId?: VcsRepositoryId
	mergedAt?: number
	verdict?: "clean" | "regressed"
}) => ({
	id: reviewId(input.n),
	orgId: input.orgId ?? ORG,
	repositoryId: input.repositoryId ?? REPO,
	number: input.number,
	headSha: Schema.decodeUnknownSync(GitCommitSha)("a".repeat(39) + String(input.n % 10)),
	url: `https://github.com/acme/web/pull/${input.number}`,
	authorLogin: input.author,
	status: "completed" as const,
	finishedAt: input.created + 120_000,
	mergedAt: input.mergedAt ?? null,
	postMergeStatus: input.verdict === undefined ? null : ("reported" as const),
	postMergeJson: input.verdict === undefined ? null : postMerge(input.verdict),
	createdAt: input.created,
	updatedAt: input.created,
})

const finding = (n: number, number: number, severity: "critical" | "warn", status: "open" | "resolved") => ({
	id: `finding-${n}`,
	orgId: ORG,
	repositoryId: REPO,
	number,
	reviewId: reviewId(number === 10 ? 1 : 3),
	handle: `F${n}`,
	path: "src/index.ts",
	line: n,
	category: "correctness" as const,
	severity,
	title: `Finding ${n}`,
	status,
	createdAt: at(1),
	updatedAt: at(1),
})

const seed = Effect.gen(function* () {
	const database = yield* Database
	yield* database.execute((db) =>
		db.run(
			PG.insertInto(VcsRepositories).values(
				[
					{ id: REPO, orgId: ORG, fullName: "acme/web", defaultBranch: "trunk" },
					{ id: OTHER_REPO, orgId: OTHER_ORG, fullName: "other/api", defaultBranch: "main" },
				].map((repo) => ({
					...repo,
					provider: "github" as const,
					installationId: INSTALLATION,
					externalRepoId: repo.id,
					owner: repo.fullName.split("/")[0] ?? "",
					name: repo.fullName.split("/")[1] ?? "",
					htmlUrl: `https://github.com/${repo.fullName}`,
					createdAt: START,
					updatedAt: START,
				})),
			),
		),
	)
	yield* database.execute((db) =>
		db.run(
			PG.insertInto(PrReviews).values([
				// ada: #10 reviewed twice, merged 10h after its first review, shipped clean.
				review({
					n: 1,
					number: 10,
					author: "ada",
					created: at(0),
					mergedAt: at(10),
					verdict: "clean",
				}),
				review({ n: 2, number: 10, author: "ada", created: at(4), mergedAt: at(10) }),
				// ada: #11 still open, with an open finding that did not ship.
				review({ n: 3, number: 11, author: "ada", created: at(20) }),
				// lin: #12 merged after 2h, regressed.
				review({
					n: 4,
					number: 12,
					author: "lin",
					created: at(30),
					mergedAt: at(32),
					verdict: "regressed",
				}),
				review({ n: 5, number: 13, author: "dependabot[bot]", created: at(40), mergedAt: at(41) }),
				// Before the window, and another org: neither may count.
				review({ n: 6, number: 9, author: "ada", created: at(-5) }),
				// #9 re-reviewed in the window: still not first reviewed in it.
				review({ n: 8, number: 9, author: "ada", created: at(6), mergedAt: at(7) }),
				review({
					n: 7,
					number: 1,
					author: "eve",
					created: at(5),
					orgId: OTHER_ORG,
					repositoryId: OTHER_REPO,
				}),
			]),
		),
	)
	yield* database.execute((db) =>
		db.run(
			PG.insertInto(PrReviewFindings).values([
				finding(1, 10, "critical", "resolved"),
				finding(2, 10, "warn", "open"),
				finding(3, 11, "warn", "open"),
				// Fixed on #11, which has not merged: not judged yet.
				finding(4, 11, "warn", "resolved"),
			]),
		),
	)
})

const ciRow = (actor: string, extra: Record<string, number> = {}) => ({
	actor,
	runs: 10,
	firstTryRuns: 8,
	firstTryGreen: 6,
	reruns: 1,
	cancelledRuns: 2,
	runnerMs: 600_000,
	defaultBranchRuns: 4,
	defaultBranchFailed: 1,
	...extra,
})

const withService = <A, E>(
	rows: Record<string, ReadonlyArray<Record<string, unknown>>>,
	body: (
		service: CodeReviewTeamService["Service"],
		reads: Array<{ context: string; sql: string }>,
	) => Effect.Effect<A, E, Database>,
) =>
	Effect.gen(function* () {
		const testDb = createTestDb(trackedDbs)
		const reads: Array<{ context: string; sql: string }> = []
		const warehouse = makeWarehouseServiceStub({
			compiledQuery: (_tenant, compiled, options) => {
				const query = compiledQueryOf(compiled)
				const context = options?.context ?? ""
				reads.push({ context, sql: query.sql })
				return query.decodeRows(rows[context] ?? []).pipe(Effect.orDie)
			},
		})
		return yield* Effect.gen(function* () {
			yield* seed
			const service = yield* CodeReviewTeamService
			return yield* body(service, reads)
		}).pipe(
			Effect.provide(
				Layer.effect(CodeReviewTeamService, CodeReviewTeamService.make).pipe(
					Layer.provideMerge(
						Layer.mergeAll(testDb.layer, Layer.succeed(WarehouseQueryService, warehouse)),
					),
				),
			),
		)
	})

describe("CodeReviewTeamService.team", () => {
	it.effect("folds reviews, findings and CI runs into one row per person, bots left out", () =>
		withService(
			{
				ciActorStats: [
					ciRow("ada"),
					ciRow("JeremyFunk", { runs: 3, runnerMs: 60_000 }),
					ciRow("dependabot[bot]", {
						runnerMs: 30_000,
						defaultBranchRuns: 0,
						defaultBranchFailed: 0,
					}),
				],
				ciQueueTotals: [{ jobs: 40, p50QueueMs: 2_000, p95QueueMs: 9_000 }],
			},
			(service) =>
				Effect.gen(function* () {
					const team = yield* service.team(tenant, window)
					assert.deepStrictEqual(
						team.members.map((member) => member.login),
						["ada", "JeremyFunk", "lin"],
					)
					const [ada, jeremy, lin] = team.members
					assert.strictEqual(ada?.pullRequests, 2)
					assert.strictEqual(ada?.mergedPullRequests, 1)
					assert.strictEqual(ada?.medianMergeSeconds, 10 * 3_600)
					assert.strictEqual(ada?.findings, 4)
					assert.strictEqual(ada?.criticalFindings, 1)
					// Fix rate is judged at the merge: #10 alone, one fixed and one shipped open.
					assert.strictEqual(ada?.resolvedFindings, 1)
					assert.strictEqual(ada?.openAtMergeFindings, 1)
					assert.strictEqual(ada?.shippedClean, 1)
					assert.strictEqual(ada?.ciRuns, 10)
					assert.strictEqual(ada?.firstTryGreen, 6)
					// A CI actor without a reviewed pull request still has a row.
					assert.strictEqual(jeremy?.pullRequests, 0)
					assert.strictEqual(jeremy?.ciRuns, 3)
					assert.strictEqual(lin?.shippedRegressed, 1)
					assert.strictEqual(lin?.shippedClean, 0)
					assert.strictEqual(lin?.ciRuns, 0)

					assert.strictEqual(team.totals.pullRequests, 3)
					assert.strictEqual(team.totals.mergedPullRequests, 2)
					assert.strictEqual(team.totals.medianMergeSeconds, 6 * 3_600)
					assert.strictEqual(team.totals.medianFirstReviewSeconds, 120)
					// Runner time and the default branch count bots too: they share the runners.
					assert.strictEqual(team.totals.runnerMs, 690_000)
					assert.strictEqual(team.totals.defaultBranchRuns, 8)
					assert.strictEqual(team.totals.defaultBranchFailed, 2)
					assert.strictEqual(team.totals.p95QueueMs, 9_000)
				}),
		),
	)

	it.effect("judges default-branch runs by each repository's own default branch", () =>
		withService({}, (_service, reads) =>
			Effect.gen(function* () {
				const service = yield* CodeReviewTeamService
				yield* service.team(tenant, { ...window, repositoryId: REPO })
				const sql = reads.find((read) => read.context === "ciActorStats")?.sql ?? ""
				assert.include(sql, "ci_runs.Owner = 'acme' AND ci_runs.Repository = 'web'")
				assert.include(sql, "ci_runs.Branch = 'trunk'")
				assert.notInclude(sql, "'main'")
			}),
		),
	)

	it.effect("reads nothing for a repository id that is not the org's", () =>
		withService({ ciActorStats: [ciRow("eve")] }, (service, reads) =>
			Effect.gen(function* () {
				const team = yield* service.team(tenant, { ...window, repositoryId: OTHER_REPO })
				assert.deepStrictEqual(team.members, [])
				assert.strictEqual(team.totals.pullRequests, 0)
				assert.deepStrictEqual(reads, [])
			}),
		),
	)
})

describe("median", () => {
	it("is the middle value, or the mean of the two middle ones", () => {
		assert.strictEqual(median([5, 1, 3]), 3)
		assert.strictEqual(median([4, 1, 3, 2]), 2.5)
		assert.strictEqual(median([]), null)
	})
})
