import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import {
	OrgId,
	PrReviewId,
	PrReviewRepositoryConfig,
	VcsRepositoryId,
	mergePrReviewConfig,
} from "@maple/domain/http"
import { prReviewFindings, prReviews, vcsRepositories } from "@maple/db"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { PrReviewAnalyticsService } from "./PrReviewAnalyticsService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeUnknownSync(OrgId)("org_review_analytics")
const OTHER_ORG = Schema.decodeUnknownSync(OrgId)("org_other")
const REPO = Schema.decodeUnknownSync(VcsRepositoryId)("00000000-0000-4000-8000-000000000001")
const OTHER_REPO = Schema.decodeUnknownSync(VcsRepositoryId)("00000000-0000-4000-8000-000000000002")
const reviewId = (n: number) =>
	Schema.decodeUnknownSync(PrReviewId)(`00000000-0000-4000-9000-${String(n).padStart(12, "0")}`)

const DAY = 86_400_000
const START = Date.UTC(2026, 8, 1)
const at = (days: number, hours = 0) => new Date(START + days * DAY + hours * 3_600_000)
const SHA = "a".repeat(40)

const report = (verdict: "clean" | "issues", confidence: number, severities: ReadonlyArray<string>) => ({
	verdict,
	summary: "Summary",
	confidence,
	coverage: [],
	findings: severities.map((severity, index) => ({
		path: "src/index.ts",
		line: index + 1,
		category: "correctness",
		severity,
		title: `Finding ${index}`,
		body: "Body",
	})),
})

const seed = Effect.gen(function* () {
	const database = yield* Database
	yield* database.execute((db) =>
		db.insert(vcsRepositories).values(
			[
				{ id: REPO, orgId: ORG, fullName: "acme/web" },
				{ id: OTHER_REPO, orgId: OTHER_ORG, fullName: "other/api" },
			].map((repo) => ({
				...repo,
				provider: "github" as const,
				installationId: "inst" as never,
				externalRepoId: repo.id,
				owner: repo.fullName.split("/")[0] ?? "",
				name: repo.fullName.split("/")[1] ?? "",
				htmlUrl: `https://github.com/${repo.fullName}`,
				createdAt: at(0),
				updatedAt: at(0),
			})),
		),
	)
	const review = (input: {
		n: number
		orgId?: OrgId
		repositoryId?: VcsRepositoryId
		number: number
		author: string
		created: Date
		status: "completed" | "failed" | "skipped"
		report?: ReturnType<typeof report>
		score?: number
		mergedAt?: Date
	}) => ({
		id: reviewId(input.n),
		orgId: input.orgId ?? ORG,
		repositoryId: input.repositoryId ?? REPO,
		number: input.number,
		headSha: SHA.slice(0, 39) + String(input.n % 10),
		url: `https://github.com/acme/web/pull/${input.number}`,
		title: `PR ${input.number}`,
		authorLogin: input.author,
		status: input.status,
		reportJson: (input.report ?? null) as never,
		score: input.score ?? null,
		inputTokens: 1_000,
		outputTokens: 100,
		finishedAt: input.status === "completed" ? new Date(input.created.getTime() + 120_000) : null,
		mergedAt: input.mergedAt ?? null,
		createdAt: input.created,
		updatedAt: input.created,
	})
	yield* database.execute((db) =>
		db.insert(prReviews).values([
			review({
				n: 1,
				number: 10,
				author: "ada",
				created: at(2),
				status: "completed",
				report: report("issues", 3, ["critical", "warn"]),
				score: 65,
				mergedAt: at(4),
			}),
			review({
				n: 2,
				number: 10,
				author: "ada",
				created: at(3),
				status: "completed",
				report: report("clean", 5, []),
				score: 100,
				mergedAt: at(4),
			}),
			review({ n: 3, number: 11, author: "lin", created: at(5), status: "failed" }),
			// The previous window, and another tenant: neither may count.
			review({
				n: 4,
				number: 9,
				author: "ada",
				created: at(-5),
				status: "completed",
				report: report("clean", 4, []),
			}),
			review({
				n: 5,
				orgId: OTHER_ORG,
				repositoryId: OTHER_REPO,
				number: 1,
				author: "eve",
				created: at(2),
				status: "completed",
				report: report("issues", 1, ["critical"]),
			}),
		]),
	)
	const finding = (n: number, severity: "critical" | "warn", status: "open" | "resolved") => ({
		id: `finding-${n}`,
		orgId: ORG,
		repositoryId: REPO,
		number: 10,
		reviewId: reviewId(1),
		handle: `F${n}`,
		path: "src/index.ts",
		line: n,
		category: "correctness" as const,
		severity,
		title: `Finding ${n}`,
		status,
		createdAt: at(2, n),
		updatedAt: at(2, n),
	})
	yield* database.execute((db) =>
		db.insert(prReviewFindings).values([finding(1, "critical", "resolved"), finding(2, "warn", "open")]),
	)
})

const provide = <A, E>(effect: Effect.Effect<A, E, PrReviewAnalyticsService | Database>) => {
	const db = createTestDb(trackedDbs).layer
	return effect.pipe(
		Effect.provide(Layer.merge(PrReviewAnalyticsService.layer.pipe(Layer.provide(db)), db)),
	)
}

const window = { startTime: START, endTime: START + 10 * DAY }

describe("PrReviewAnalyticsService", () => {
	it.effect("totals the window for the org alone, against the window before it", () =>
		provide(
			Effect.gen(function* () {
				yield* seed
				const service = yield* PrReviewAnalyticsService
				const analytics = yield* service.analytics(ORG, window)
				const { current, previous } = analytics

				assert.strictEqual(current.reviews, 3)
				assert.strictEqual(current.pullRequests, 2)
				assert.strictEqual(current.completedReviews, 2)
				assert.strictEqual(current.failedReviews, 1)
				assert.strictEqual(current.findings, 2)
				assert.strictEqual(current.criticalFindings, 1)
				assert.strictEqual(current.resolvedFindings, 1)
				assert.strictEqual(current.repositoriesWithFindings, 1)
				assert.strictEqual(current.mergedPullRequests, 1)
				// First review (day 2) to merge (day 4).
				assert.strictEqual(current.avgMergeSeconds, 2 * 86_400)
				assert.strictEqual(current.avgReviewSeconds, 120)
				assert.strictEqual(current.avgConfidence, 4)
				assert.strictEqual(current.avgScore, 82.5)
				assert.strictEqual(current.inputTokens, 3_000)
				assert.strictEqual(previous.reviews, 1)

				assert.strictEqual(analytics.bucketSeconds, 86_400)
				assert.strictEqual(analytics.series.length, 10)
				assert.strictEqual(analytics.series[2]?.reviews, 1)
				assert.strictEqual(analytics.series[2]?.critical, 1)
				assert.strictEqual(analytics.series[2]?.warn, 1)
				assert.deepStrictEqual({ ...analytics.verdicts }, { clean: 1, issues: 1, notApplicable: 0 })
				assert.deepStrictEqual(
					analytics.repositories.map((repo) => [repo.fullName, repo.reviews, repo.findings]),
					[["acme/web", 3, 2]],
				)
				assert.deepStrictEqual(
					analytics.authors.map((row) => [row.author, row.pullRequests, row.findings]),
					[
						["ada", 1, 2],
						["lin", 1, 0],
					],
				)
			}),
		),
	)

	it.effect("caps the window, so an unbounded range cannot build an unbounded series", () =>
		provide(
			Effect.gen(function* () {
				yield* seed
				const service = yield* PrReviewAnalyticsService
				const analytics = yield* service.analytics(ORG, { startTime: 0, endTime: START + 10 * DAY })
				assert.strictEqual(analytics.bucketSeconds, 7 * 86_400)
				assert.isAtMost(analytics.series.length, 54)
				assert.strictEqual(analytics.current.reviews, 4)
			}),
		),
	)

	it.effect("filters by author", () =>
		provide(
			Effect.gen(function* () {
				yield* seed
				const service = yield* PrReviewAnalyticsService
				const analytics = yield* service.analytics(ORG, { ...window, author: "lin" })
				assert.strictEqual(analytics.current.reviews, 1)
				assert.strictEqual(analytics.current.findings, 0)
			}),
		),
	)

	it.effect("lists reviews newest first with their report counts, paging by cursor", () =>
		provide(
			Effect.gen(function* () {
				yield* seed
				const service = yield* PrReviewAnalyticsService
				const first = yield* service.listReviews(ORG, { ...window, limit: 2 })
				assert.deepStrictEqual(
					first.reviews.map((review) => [review.number, review.status]),
					[
						[11, "failed"],
						[10, "completed"],
					],
				)
				assert.strictEqual(first.reviews[1]?.verdict, "clean")
				assert.notStrictEqual(first.nextCursor, null)
				const second = yield* service.listReviews(ORG, {
					...window,
					limit: 2,
					cursor: first.nextCursor ?? undefined,
				})
				assert.deepStrictEqual(
					second.reviews.map((review) => [
						review.findings,
						review.criticalFindings,
						review.repositoryFullName,
					]),
					[[2, 1, "acme/web"]],
				)
				assert.strictEqual(second.nextCursor, null)
			}),
		),
	)

	it.effect("opens one review with its pull request's history and tracked findings", () =>
		provide(
			Effect.gen(function* () {
				yield* seed
				const service = yield* PrReviewAnalyticsService
				const detail = yield* service.getReview(ORG, reviewId(1))
				assert.strictEqual(detail.report?.findings.length, 2)
				assert.strictEqual(detail.history.length, 2)
				assert.deepStrictEqual(
					detail.findings.map((finding) => [finding.handle, finding.status]),
					[
						["F1", "resolved"],
						["F2", "open"],
					],
				)
				const missing = yield* service.getReview(OTHER_ORG, reviewId(1)).pipe(Effect.flip)
				assert.strictEqual(missing._tag, "@maple/http/pr-review/PrReviewNotFoundError")
			}),
		),
	)

	it.effect("lists findings filtered by severity", () =>
		provide(
			Effect.gen(function* () {
				yield* seed
				const service = yield* PrReviewAnalyticsService
				const response = yield* service.listFindings(ORG, { ...window, severity: "critical" })
				assert.deepStrictEqual(
					response.findings.map((finding) => [finding.handle, finding.pullRequestTitle]),
					[["F1", "PR 10"]],
				)
			}),
		),
	)
})

describe("mergePrReviewConfig", () => {
	it("lets the repository override field by field, and adds instructions and ignored paths", () => {
		const merged = mergePrReviewConfig(
			new PrReviewRepositoryConfig({
				instructions: "Org rule",
				ignorePaths: ["dist/"],
				minInlineSeverity: "critical",
				dailyLimit: 20,
				reviewDrafts: true,
			}),
			new PrReviewRepositoryConfig({
				instructions: "Repo rule",
				ignorePaths: ["dist/", "gen/"],
				dailyLimit: 5,
			}),
		)
		assert.strictEqual(merged.instructions, "Org rule\n\nRepo rule")
		assert.deepStrictEqual(merged.ignorePaths, ["dist/", "gen/"])
		assert.strictEqual(merged.minInlineSeverity, "critical")
		assert.strictEqual(merged.dailyLimit, 5)
		assert.strictEqual(merged.reviewDrafts, true)
		assert.strictEqual(merged.feedbackScope, undefined)
	})

	it("returns the repository's config when the organization has no defaults", () => {
		const repository = new PrReviewRepositoryConfig({ dailyLimit: 3 })
		assert.strictEqual(mergePrReviewConfig(undefined, repository), repository)
	})
})
