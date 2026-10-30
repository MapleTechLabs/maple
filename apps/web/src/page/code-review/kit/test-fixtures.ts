import { OrgId } from "@maple/domain"
import { CodeReviewAnalytics, GithubIntegrationStatus, VcsRepositoryId } from "@maple/domain/http"
import { Schema } from "effect"
import type { PageContext } from "../../contract"

// Shared fixtures for the Code Review scene tests.

export const orgId = Schema.decodeSync(OrgId)("org_acme")
export const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
export const NOW = Date.UTC(2026, 9, 1, 12)
export const window = { startTime: "2026-09-01 12:00:00", endTime: "2026-10-01 12:00:00" }
export const PAYMENTS = Schema.decodeSync(VcsRepositoryId)("00000c01-0000-4000-8000-000000000002")

const totals = (reviews: number) => ({
	pullRequests: reviews,
	reviews,
	completedReviews: reviews,
	failedReviews: 0,
	skippedReviews: 0,
	findings: reviews,
	criticalFindings: 0,
	resolvedFindings: 0,
	dismissedFindings: 0,
	repositoriesWithFindings: reviews > 0 ? 1 : 0,
	mergedPullRequests: 0,
	avgReviewSeconds: null,
	avgMergeSeconds: null,
	avgConfidence: null,
	avgScore: null,
	inputTokens: 0,
	outputTokens: 0,
})

/** `reviews` reviews by `authors`, one bucket. */
export const analyticsOf = (reviews: number, authors: ReadonlyArray<string> = []): CodeReviewAnalytics =>
	Schema.decodeUnknownSync(CodeReviewAnalytics)({
		bucketSeconds: 86_400,
		current: totals(reviews),
		previous: totals(0),
		series: [{ bucket: NOW - 86_400_000, reviews, pullRequests: reviews, critical: 0, warn: 0, info: 0 }],
		categories: [],
		verdicts: { clean: reviews, issues: 0, notApplicable: 0 },
		repositories: [],
		authors: authors.map((author) => ({ author, pullRequests: 1, findings: 0 })),
	})

export const githubStatusOf = (repositories: ReadonlyArray<{ name: string; reviewed: boolean }>) =>
	Schema.decodeUnknownSync(GithubIntegrationStatus)({
		connected: true,
		state: "connected",
		accountLogin: "acme-shop",
		accountType: "organization",
		repositorySelection: "selected",
		ciTracesEnabled: true,
		repositoryDiscovery: null,
		repositories: repositories.map((repo, index) => ({
			id: `00000c01-0000-4000-8000-00000000000${index + 1}`,
			fullName: `acme-shop/${repo.name}`,
			htmlUrl: `https://github.com/acme-shop/${repo.name}`,
			isPrivate: true,
			status: "active",
			syncStatus: "ready",
			lastSyncedAt: null,
			lastSyncError: null,
			trackedBranch: null,
			branches: [],
			prReviewEnabled: repo.reviewed,
		})),
	})

export const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)
