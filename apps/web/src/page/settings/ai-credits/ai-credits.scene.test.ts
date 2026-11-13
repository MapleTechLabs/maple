import { OrgId } from "@maple/domain"
import { AiCreditUsageResponse } from "@maple/domain/http"
import { Result, Schema, Array as Arr } from "effect"
import { expect as expectView, given, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "@maple/views/data/load-failure"
import type { PageContext } from "../../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_ai"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const step = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)
const entered = () => init({ _tag: "BillingAiCredits" }, context)

const REPO = "00000000-0000-4000-8000-000000000001"
const usage = (overrides: Readonly<Record<string, unknown>> = {}) =>
	Schema.decodeSync(AiCreditUsageResponse)({
		cycleStartMs: Date.UTC(2026, 10, 8),
		cycleEndMs: Date.UTC(2026, 11, 8),
		bySource: [{ source: "review", credits: 14.08 }],
		days: [],
		byModel: [{ model: "openrouter/deepseek/deepseek-v4.1-flash", credits: 13 }],
		codeReview: {
			reviews: 230,
			pullRequests: 160,
			credits: 14.08,
			unpricedReviews: 12,
			reReviews: 70,
			reReviewCredits: 5.2,
			repositories: [
				{ repositoryId: REPO, fullName: "acme/web", pullRequests: 160, reviews: 230, credits: 14.08 },
			],
			topPullRequests: [
				{
					repositoryId: REPO,
					fullName: "acme/web",
					number: 2210,
					title: "Faster sync",
					url: "https://github.com/acme/web/pull/2210",
					reviews: 7,
					credits: 0.78,
				},
			],
		},
		...overrides,
	})

describe("AI credits page", () => {
	test("reads this cycle's AI credit usage on entry", () => {
		expect(names(entered().commands)).toEqual(["FetchAiCreditUsage"])
	})

	test("shows code review spend by repository and pull request, and what no model was named on", () => {
		scene(
			{ update: step, view },
			given(
				step(entered().model, Message.CompletedFetchUsage({ result: Result.succeed(usage()) })).model,
			),
			expectView(text("Since Nov 8")).toExist(),
			expectView(text("Code review by repository")).toExist(),
			expectView(text("acme/web")).toExist(),
			expectView(text("#2210")).toExist(),
			expectView(text("Reviewed 7×")).toExist(),
			expectView(text("deepseek/deepseek-v4.1-flash")).toExist(),
			expectView(text("Unattributed")).toExist(),
			expectView(text(/12 of this cycle's reviews have no recorded cost/u)).toExist(),
		)
	})

	test("says nothing was spent rather than drawing empty tables", () => {
		scene(
			{ update: step, view },
			given(
				step(
					entered().model,
					Message.CompletedFetchUsage({
						result: Result.succeed(usage({ bySource: [], byModel: [], codeReview: null })),
					}),
				).model,
			),
			expectView(text(/No AI credits spent this cycle yet/u)).toExist(),
			expectView(text("By model")).not.toExist(),
		)
	})

	test("a failed read offers a retry that reads again", () => {
		const failed = step(
			entered().model,
			Message.CompletedFetchUsage({ result: Result.fail(toLoadFailure(new Error("boom"))) }),
		)
		scene(
			{ update: step, view },
			given(failed.model),
			expectView(text("Couldn't load your AI credits")).toExist(),
		)
		expect(names(step(failed.model, Message.ClickedRetry()).commands)).toEqual(["FetchAiCreditUsage"])
	})
})
