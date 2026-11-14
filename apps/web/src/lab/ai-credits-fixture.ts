import { AiCreditUsageResponse } from "@maple/domain/http"
import { Schema } from "effect"

// The AI credits fixtures `/lab/ai-credits` and `/lab/billing-orgs` share.

const DAY = 86_400_000
const CYCLE_START = Date.UTC(2026, 9, 1)

const REPO = "00000000-0000-4000-8000-000000000001"
const API_REPO = "00000000-0000-4000-8000-000000000002"
const pullRequest = (number: number, title: string, reviews: number, credits: number, repo = REPO) => ({
	repositoryId: repo,
	fullName: repo === REPO ? "acme/web" : "acme/api",
	number,
	title,
	url: `https://github.com/acme/${repo === REPO ? "web" : "api"}/pull/${number}`,
	reviews,
	credits,
})

export type AiCreditsFixture = "code-review" | "chat" | "empty"

/** This cycle's AI credits: an org whose spend is mostly code review, one that only chats, and none. */
export const aiCreditUsageFixture = (fixture: AiCreditsFixture) =>
	Schema.decodeSync(AiCreditUsageResponse)({
		cycleStartMs: CYCLE_START,
		cycleEndMs: CYCLE_START + 31 * DAY,
		...(fixture === "code-review"
			? {
					bySource: [
						{ source: "review", credits: 14.08 },
						{ source: "chat", credits: 1.42 },
						{ source: "triage", credits: 0.61 },
					],
					days: [],
					byModel: [
						{ model: "openrouter/deepseek/deepseek-v4.1-flash-1017", credits: 14.11 },
						{ model: "openrouter/anthropic/claude-sonnet-5.5", credits: 2 },
					],
					codeReview: {
						reviews: 230,
						pullRequests: 160,
						credits: 14.08,
						unpricedReviews: 0,
						reReviews: 70,
						reReviewCredits: 5.2,
						repositories: [
							{
								repositoryId: REPO,
								fullName: "acme/web",
								pullRequests: 141,
								reviews: 204,
								credits: 12.31,
							},
							{
								repositoryId: API_REPO,
								fullName: "acme/api",
								pullRequests: 19,
								reviews: 26,
								credits: 1.77,
							},
						],
						topPullRequests: [
							pullRequest(2288, "Move session sync onto the job queue", 3, 0.92),
							pullRequest(2210, "Retry webhook delivery with backoff", 7, 0.78),
							pullRequest(2224, "Paginate the contacts export", 7, 0.67),
							pullRequest(311, "Rate limit the public API per key", 1, 0.5, API_REPO),
							pullRequest(2146, "Cache the inbox counts", 6, 0.49),
							pullRequest(2223, "Split the billing worker", 4, 0.47),
							pullRequest(2111, "Store attachments in R2", 3, 0.41),
							pullRequest(2289, "Fix the flaky threads test", 5, 0.38),
						],
					},
				}
			: fixture === "chat"
				? {
						bySource: [
							{ source: "chat", credits: 3.4 },
							{ source: "triage", credits: 1.15 },
						],
						days: [],
						byModel: [{ model: "openrouter/anthropic/claude-sonnet-5.5", credits: 4.55 }],
						codeReview: null,
					}
				: { bySource: [], days: [], byModel: [], codeReview: null }),
	})
