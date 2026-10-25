import { Result } from "effect"
import type { HtmlBuilder } from "foldkit/html"
import { all, expect as expectView, expectAll, given, role, scene } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { AppRoute } from "../../route"
import * as AnalyticsMessage from "./analytics/message"
import { FrameMessage } from "./kit/frame"
import { type CodeReviewTab, codeReviewLayout } from "./kit/layout"
import { analyticsOf, context, githubStatusOf, names, NOW, window } from "./kit/test-fixtures"
import * as PullRequests from "./pull-requests/model"
import { Message, type Model } from "./tabs"
import { init, routeChanged, update } from "./tabs-update"

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const resolved = FrameMessage.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" })

/** Analytics with its window, its read and the GitHub status answered. */
const analyticsLoaded = (): Model => {
	const entry = init(AppRoute.CodeReview({ search: {} }), context).model
	const windowed = pageUpdate(
		entry,
		Message.GotAnalyticsMessage({
			message: AnalyticsMessage.Message.GotFrameMessage({ message: resolved }),
		}),
	).model
	if (windowed.tab._tag !== "Analytics") return windowed
	const { analytics, frame } = windowed.tab.model
	return [
		AnalyticsMessage.Message.CompletedFetchAnalytics({
			key: analytics.key ?? "",
			result: Result.succeed(analyticsOf(3, ["ada-l"])),
		}),
		AnalyticsMessage.Message.GotFrameMessage({
			message: FrameMessage.CompletedFetchGithubStatus({
				key: frame.githubStatus.key ?? "",
				result: Result.succeed(githubStatusOf([{ name: "shop", reviewed: true }])),
			}),
		}),
	].reduce((model, message) => pageUpdate(model, Message.GotAnalyticsMessage({ message })).model, windowed)
}

describe("code review tabs", () => {
	test("a tab change keeps the instance: the GitHub status is not read again", () => {
		const moved = routeChanged(
			analyticsLoaded(),
			AppRoute.CodeReviewPullRequests({ search: {} }),
			context,
		)
		expect(moved.model.tab._tag).toBe("PullRequests")
		expect(names(moved.commands)).toEqual(["ResolveCodeReviewWindow"])
	})

	test("the author list the analytics read serves the next tab", () => {
		const moved = routeChanged(
			analyticsLoaded(),
			AppRoute.CodeReviewPullRequests({ search: {} }),
			context,
		).model
		const windowed = pageUpdate(
			moved,
			Message.GotPullRequestsMessage({
				message: PullRequests.Message.GotFrameMessage({ message: resolved }),
			}),
		)
		expect(names(windowed.commands)).toEqual(["FetchCodeReviewReviews"])
	})

	test("an answer for a tab already left is dropped", () => {
		const moved = routeChanged(analyticsLoaded(), AppRoute.CodeReviewCi({ search: {} }), context).model
		const late = pageUpdate(
			moved,
			Message.GotAnalyticsMessage({
				message: AnalyticsMessage.Message.CompletedFetchAnalytics({
					key: "late",
					result: Result.succeed(analyticsOf(1)),
				}),
			}),
		)
		expect(late.model).toBe(moved)
	})
})

describe("code review tab strip", () => {
	const config = {
		update: (active: CodeReviewTab, _message: never) => ({ model: active }),
		view: (active: CodeReviewTab, h: HtmlBuilder<never>) => codeReviewLayout({ h, active, search: {} }, []),
	}

	test("exactly one tab link is the current page", () => {
		scene(
			config,
			given<CodeReviewTab>("pull-requests"),
			expectAll(all.role("link", { current: "page" })).toHaveCount(1),
			expectView(role("link", { name: "Pull requests", current: "page" })).toExist(),
		)
		scene(
			config,
			given<CodeReviewTab>("analytics"),
			expectAll(all.role("link", { current: "page" })).toHaveCount(1),
			expectView(role("link", { name: "Analytics", current: "page" })).toExist(),
		)
	})
})
