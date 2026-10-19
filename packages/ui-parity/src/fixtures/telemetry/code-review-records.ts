import { DAY, FROZEN_NOW_MS, HOUR, MINUTE, fixtureUuid } from "../identity.ts"
import { CI_OWNER } from "./code-review-ci.ts"

/**
 * The code-review org's Postgres side in wire form: the GitHub App's repositories, its pull
 * request reviews over the last month, and the findings they filed.
 */

/** The org every code-review fixture belongs to; other orgs read empty. */
export const CODE_REVIEW_ORG_ID = "org_parity_code_review"

export const repoId = (index: number) => fixtureUuid(0xc01, index)

const repo = (index: number, name: string, prReviewEnabled: boolean, isPrivate = true) => ({
	id: repoId(index),
	fullName: `${CI_OWNER}/${name}`,
	htmlUrl: `https://github.com/${CI_OWNER}/${name}`,
	isPrivate,
	status: "active",
	syncStatus: "ready",
	lastSyncedAt: FROZEN_NOW_MS - 7 * MINUTE,
	lastSyncError: null,
	trackedBranch: "main",
	branches: [{ name: "main", isDefault: true }],
	prReviewEnabled,
})

export const CODE_REVIEW_REPOS = [
	repo(1, "shop", true),
	repo(2, "payments", true),
	repo(3, "infra", false),
	repo(4, "docs", false, false),
] as const

/** Repository name (without owner) by id, the lookup `resolveScope` does in Postgres. */
export const repoNameOf = (id: string) =>
	CODE_REVIEW_REPOS.find((candidate) => candidate.id === id)?.fullName.split("/")[1]

type Status = "completed" | "failed" | "skipped"
type Verdict = "clean" | "issues" | "not_applicable"

interface ReviewSpec {
	readonly repo: 1 | 2
	readonly number: number
	readonly title: string
	readonly author: string
	readonly ageMs: number
	readonly status: Status
	readonly verdict?: Verdict
	readonly score?: number
	readonly confidence?: number
	readonly merged?: boolean
	readonly skipReason?: "superseded"
	readonly error?: string
}

const SPECS: ReadonlyArray<ReviewSpec> = [
	{
		repo: 1,
		number: 482,
		title: "Retry payment capture once on pool timeout",
		author: "ada-l",
		ageMs: 3 * HOUR,
		status: "completed",
		verdict: "issues",
		score: 64,
		confidence: 5,
	},
	{
		repo: 1,
		number: 482,
		title: "Retry payment capture once on pool timeout",
		author: "ada-l",
		ageMs: 26 * HOUR,
		status: "skipped",
		skipReason: "superseded",
	},
	{
		repo: 1,
		number: 479,
		title: "Round cart totals with banker's rounding",
		author: "grace-h",
		ageMs: 2 * DAY,
		status: "completed",
		verdict: "clean",
		score: 93,
		confidence: 9,
		merged: true,
	},
	{
		repo: 1,
		number: 476,
		title: "Upgrade OpenTelemetry SDK to 2.4",
		author: "linus-t",
		ageMs: 4 * DAY,
		status: "completed",
		verdict: "issues",
		score: 71,
		confidence: 7,
		merged: true,
	},
	{
		repo: 2,
		number: 131,
		title: "Add a capture ledger table",
		author: "margaret-h",
		ageMs: 5 * DAY,
		status: "completed",
		verdict: "issues",
		score: 58,
		confidence: 4,
	},
	{
		repo: 1,
		number: 470,
		title: "Drop the legacy coupon service client",
		author: "ada-l",
		ageMs: 9 * DAY,
		status: "failed",
		error: "time_limit: review ran past 15 minutes",
	},
	{
		repo: 2,
		number: 127,
		title: "Bump stripe-go to v82",
		author: "linus-t",
		ageMs: 12 * DAY,
		status: "completed",
		verdict: "not_applicable",
		score: 100,
		confidence: 10,
		merged: true,
	},
	{
		repo: 1,
		number: 464,
		title: "Cache product pages at the edge",
		author: "grace-h",
		ageMs: 16 * DAY,
		status: "completed",
		verdict: "issues",
		score: 76,
		confidence: 6,
		merged: true,
	},
	{
		repo: 1,
		number: 459,
		title: "Add span for checkout validation",
		author: "margaret-h",
		ageMs: 21 * DAY,
		status: "completed",
		verdict: "clean",
		score: 97,
		confidence: 9,
		merged: true,
	},
	{
		repo: 2,
		number: 122,
		title: "Idempotency keys on refunds",
		author: "ada-l",
		ageMs: 26 * DAY,
		status: "completed",
		verdict: "issues",
		score: 69,
		confidence: 6,
		merged: true,
	},
]

type Severity = "critical" | "warn" | "info"
type Category =
	| "correctness"
	| "security"
	| "performance"
	| "observability"
	| "convention"
	| "tests"
	| "maintainability"

interface FindingSpec {
	readonly review: number
	readonly path: string
	readonly line: number
	readonly category: Category
	readonly severity: Severity
	readonly title: string
	readonly status: "open" | "resolved" | "dismissed"
	readonly up?: number
	readonly down?: number
}

const FINDING_SPECS: ReadonlyArray<FindingSpec> = [
	{
		review: 0,
		path: "services/payment/capture.go",
		line: 88,
		category: "correctness",
		severity: "critical",
		title: "Retry re-sends the capture without an idempotency key",
		status: "open",
		up: 2,
	},
	{
		review: 0,
		path: "services/payment/capture.go",
		line: 104,
		category: "observability",
		severity: "warn",
		title: "Retry attempt is not recorded on the capture span",
		status: "open",
	},
	{
		review: 0,
		path: "services/payment/pool.go",
		line: 31,
		category: "performance",
		severity: "info",
		title: "Pool size read on every request",
		status: "open",
	},
	{
		review: 3,
		path: "packages/telemetry/src/sdk.ts",
		line: 17,
		category: "observability",
		severity: "critical",
		title: "Renamed span `checkout.submit` breaks the Checkout error rate alert",
		status: "resolved",
		up: 3,
	},
	{
		review: 3,
		path: "packages/telemetry/src/sdk.ts",
		line: 52,
		category: "convention",
		severity: "info",
		title: "Resource attribute should use `deployment.environment.name`",
		status: "dismissed",
		down: 1,
	},
	{
		review: 4,
		path: "migrations/0042_capture_ledger.sql",
		line: 12,
		category: "correctness",
		severity: "critical",
		title: "Index built without CONCURRENTLY locks the captures table",
		status: "open",
		up: 1,
	},
	{
		review: 4,
		path: "internal/ledger/writer.go",
		line: 63,
		category: "tests",
		severity: "warn",
		title: "No test covers a duplicate ledger entry",
		status: "open",
	},
	{
		review: 4,
		path: "internal/ledger/writer.go",
		line: 90,
		category: "security",
		severity: "warn",
		title: "Card fingerprint written to logs",
		status: "open",
	},
	{
		review: 7,
		path: "apps/storefront/src/cache.ts",
		line: 40,
		category: "correctness",
		severity: "warn",
		title: "Cache key ignores the currency cookie",
		status: "resolved",
	},
	{
		review: 7,
		path: "apps/storefront/src/cache.ts",
		line: 71,
		category: "maintainability",
		severity: "info",
		title: "TTL duplicated in three places",
		status: "dismissed",
	},
	{
		review: 9,
		path: "internal/refunds/handler.go",
		line: 28,
		category: "correctness",
		severity: "warn",
		title: "Idempotency key compared case-sensitively",
		status: "resolved",
	},
	{
		review: 9,
		path: "internal/refunds/handler.go",
		line: 55,
		category: "observability",
		severity: "info",
		title: "Refund outcome missing from the span status",
		status: "resolved",
	},
]

const reviewId = (index: number) => fixtureUuid(0xc02, index + 1)

const repoOf = (spec: ReviewSpec) => CODE_REVIEW_REPOS[spec.repo - 1]

export const CODE_REVIEWS = SPECS.map((spec, index) => {
	const created = FROZEN_NOW_MS - spec.ageMs
	const findings = FINDING_SPECS.filter((finding) => finding.review === index)
	const repository = repoOf(spec)
	return {
		id: reviewId(index),
		repositoryId: repository.id,
		repositoryFullName: repository.fullName,
		number: spec.number,
		title: spec.title,
		url: `${repository.htmlUrl}/pull/${spec.number}`,
		authorLogin: spec.author,
		headSha: `${(index + 10).toString(16)}${"3f9c2a7b1e".repeat(4)}`.slice(0, 40),
		status: spec.status,
		skipReason: spec.skipReason ?? null,
		verdict: spec.verdict ?? null,
		score: spec.score ?? null,
		confidence: spec.confidence ?? null,
		findings: findings.length,
		criticalFindings: findings.filter((finding) => finding.severity === "critical").length,
		commentUrl:
			spec.status === "completed"
				? `${repository.htmlUrl}/pull/${spec.number}#issuecomment-${7_000 + index}`
				: null,
		publishError: null,
		error: spec.error ?? null,
		model: spec.status === "skipped" ? null : "anthropic/claude-sonnet-5.5",
		createdAt: created,
		finishedAt: spec.status === "skipped" ? null : created + (4 + index) * MINUTE,
		mergedAt: spec.merged === true ? created + 6 * HOUR : null,
	}
})

export type CodeReviewItem = (typeof CODE_REVIEWS)[number]

export const CODE_REVIEW_FINDINGS = FINDING_SPECS.map((spec, index) => {
	const review = CODE_REVIEWS[spec.review] ?? CODE_REVIEWS[0]
	return {
		id: fixtureUuid(0xc03, index + 1),
		reviewId: review.id,
		repositoryId: review.repositoryId,
		repositoryFullName: review.repositoryFullName,
		number: review.number,
		pullRequestTitle: review.title,
		pullRequestUrl: review.url,
		handle: `F${index + 1}`,
		path: spec.path,
		line: spec.line,
		category: spec.category,
		severity: spec.severity,
		title: spec.title,
		status: spec.status,
		reactionsUp: spec.up ?? 0,
		reactionsDown: spec.down ?? 0,
		createdAt: (review.finishedAt ?? review.createdAt) + index * 1000,
	}
})

export type CodeReviewFindingItem = (typeof CODE_REVIEW_FINDINGS)[number]

/** The stored report of a completed review: summary, coverage and its findings. */
export const reportOf = (review: CodeReviewItem) => {
	const index = CODE_REVIEWS.indexOf(review)
	const spec = SPECS[index]
	if (review.status !== "completed" || spec === undefined) return null
	const findings = FINDING_SPECS.filter((finding) => finding.review === index)
	return {
		verdict: review.verdict ?? "clean",
		summary: `${spec.title}. ${findings.length === 0 ? "No issues found." : `${findings.length} issues, ${review.criticalFindings} critical.`}`,
		keyChanges: [`Changes ${findings[0]?.path ?? "the service"}`, "Updates the tests that cover it"],
		checked: ["Tenant isolation on every new query", "Error paths keep their span status"],
		tests: findings.some((finding) => finding.category === "tests") ? "partial" : "covered",
		risk: review.criticalFindings > 0 ? "high" : "low",
		confidence: review.confidence ?? 8,
		confidenceReason:
			review.criticalFindings > 0 ? "A critical issue is still open." : "Small change with tests.",
		coverage: [
			{
				unit: "POST /checkout/capture",
				kind: "endpoint",
				instrumented: true,
				evidence: "span `payment.capture`",
			},
			{
				unit: "retryCapture",
				kind: "function",
				instrumented: findings.length < 2,
				evidence: "no span or attribute",
			},
		],
		findings: findings.map((finding) => ({
			path: finding.path,
			line: finding.line,
			category: finding.category,
			severity: finding.severity,
			title: finding.title,
			body: `${finding.title}. Seen at ${finding.path}:${finding.line}.`,
			handle: `F${FINDING_SPECS.indexOf(finding) + 1}`,
		})),
	}
}
