import { Result } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ResolveThemeColors, ThemeMessage } from "../../../charts/theme-colors"
import { FrameMessage } from "../kit/frame"
import { analyticsOf, context, names, NOW, PAYMENTS, window } from "../kit/test-fixtures"
import { Message } from "./message"
import type { Model } from "./model"
import { init, routeChanged, update } from "./update"
import { view as pageView } from "./view"

type Search = Parameters<typeof init>[0]["search"]

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const frame = (message: FrameMessage) => Message.GotFrameMessage({ message })
const resolved = frame(FrameMessage.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }))

const windowed = (search: Search = {}) => pageUpdate(init({ search }, context).model, resolved)

const answered = (model: Model, reviews: number, authors: ReadonlyArray<string> = []) =>
	pageUpdate(
		model,
		Message.CompletedFetchAnalytics({
			key: model.analytics.key ?? "",
			result: Result.succeed(analyticsOf(reviews, authors)),
		}),
	).model

/** Search changed: the page re-resolves its window, then reads. */
const navigated = (model: Model, search: Search) =>
	pageUpdate(routeChanged(model, { search }, context).model, resolved)

const themeResolved = () => Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))

describe("code review analytics", () => {
	test("entry resolves the window and reads GitHub, then sends one analytics read for page and authors", () => {
		expect(names(init({ search: {} }, context).commands)).toEqual(
			expect.arrayContaining(["ResolveCodeReviewWindow", "FetchCodeReviewGithubStatus"]),
		)
		const first = windowed()
		expect(names(first.commands)).toEqual(["FetchCodeReviewAnalytics"])
		expect(first.model.analytics.key).toBe(first.model.authors.key)
	})

	test("picking an author reads the page only; undoing it within a minute reads nothing", () => {
		const loaded = answered(windowed().model, 3, ["ada-l"])
		const filtered = navigated(loaded, { author: "ada-l" })
		expect(names(filtered.commands)).toEqual(["FetchCodeReviewAnalytics"])
		const back = navigated(answered(filtered.model, 1, ["ada-l"]), {})
		expect(names(back.commands)).toEqual([])
		expect(back.model.analytics.data._tag).toBe("Success")
	})

	test("an answer for a superseded filter is dropped", () => {
		const first = windowed().model
		const second = navigated(first, { repo: PAYMENTS }).model
		const dropped = pageUpdate(
			second,
			Message.CompletedFetchAnalytics({
				key: first.analytics.key ?? "",
				result: Result.succeed(analyticsOf(9)),
			}),
		).model
		expect(dropped.analytics).toEqual(second.analytics)
	})

	test("a filtered window with nothing in it offers to clear the filters", () => {
		const model = answered(windowed({ author: "grace-h" }).model, 0)
		scene(
			{ update: pageUpdate, view },
			given(model),
			themeResolved(),
			expectView(text("No reviews in this window")).toExist(),
			expectView(role("button", { name: "Clear filters" })).toExist(),
		)
		const cleared = pageUpdate(model, Message.ClickedClearFilters())
		expect(cleared.outMessage).toMatchObject({ _tag: "RequestedNavigation", url: "/code-review" })
	})

	test("an unfiltered empty window points at Settings, with nothing to clear", () => {
		scene(
			{ update: pageUpdate, view },
			given(answered(windowed().model, 0)),
			themeResolved(),
			expectView(text(/Turn on reviews for a repository in Settings/)).toExist(),
			expectView(role("button", { name: "Clear filters" })).toBeAbsent(),
		)
	})
})
