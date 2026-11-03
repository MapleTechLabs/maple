import { OrgId } from "@maple/domain"
import { Option, Result, Schema } from "effect"
import { fromString } from "foldkit/url"
import { expect as expectView, given, Mount, scene, text, withViewInputs } from "foldkit/scene"
import * as Chart from "@maple/views/charts/chart"
import { MeasureChartContainer } from "@maple/views/charts/chart-mounts"
import { describe, expect, test } from "vitest"
import { StepEdit } from "../kit/funnel-steps"
import { urlToAppRoute } from "../../route"
import type { PageContext } from "../contract"
import type { Search } from "./definition"
import { Message, type SlotName } from "./message"
import type { EventRow, FunnelRow, Model } from "./model"
import { init, routeChanged, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-27 00:00:00", endTime: "2026-11-03 00:00:00" }

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const resolved = (search: Search = {}) =>
	pageUpdate(init({ search }, context).model, Message.CompletedResolveWindow({ window, mode: "Load" }))

const settled = (model: Model, slot: SlotName, value: unknown): Model =>
	pageUpdate(
		model,
		Message.CompletedFetch({ slot, key: model[slot].key ?? "", result: Result.succeed(value) }),
	).model

/** Where the page's navigation goes, decoded by the app's router. */
const searchOf = (outMessage: unknown): Partial<Search> => {
	const url =
		typeof outMessage === "object" &&
		outMessage !== null &&
		"url" in outMessage &&
		typeof outMessage.url === "string"
			? outMessage.url
			: ""
	const route = urlToAppRoute(Option.getOrThrow(fromString(`https://app.maple.test${url}`)))
	return route._tag === "ProductAnalytics" ? route.search : {}
}

const typing = (current: Model, value: string) =>
	pageUpdate(
		current,
		Message.ChangedStep({
			scope: "funnel",
			edit: StepEdit.ChangedText({ index: 0, field: "eventName", value }),
		}),
	)

const EVENTS: ReadonlyArray<EventRow> = [
	{ eventName: "$pageview", kind: "navigation", count: 38_412, sessions: 9_204, persons: 4_812 },
	{ eventName: "signup_started", kind: "custom", count: 1_488, sessions: 1_260, persons: 1_206 },
	{ eventName: "signup_completed", kind: "custom", count: 742, sessions: 742, persons: 742 },
]

const FUNNEL: ReadonlyArray<FunnelRow> = [
	{ name: "signup_started", value: 1_206 },
	{ name: "signup_completed", value: 742, p50Ms: 41_000, leavers: [{ name: "docs_opened", count: 120 }] },
]

const SIGNUP: Search["steps"] = [
	{ kind: "event", eventName: "signup_started" },
	{ kind: "event", eventName: "signup_completed" },
]

describe("product analytics", () => {
	test("the Events tab reads the rail's options and this window's and the previous window's events", () => {
		const sent = names(resolved().commands)
		expect(sent).toContain("FetchProductAnalyticsBreakdowns")
		expect(sent.filter((name) => name === "FetchProductEventNames")).toHaveLength(2)
		expect(sent).not.toContain("FetchProductAnalyticsFunnel")
	})

	test("a funnel runs only once a step names something, with the drop-off details by default", () => {
		expect(names(resolved({ tab: "funnels" }).commands)).not.toContain("FetchProductAnalyticsFunnel")
		const run = resolved({ tab: "funnels", steps: SIGNUP, country: "DE" }).commands?.find(
			({ name }) => name === "FetchProductAnalyticsFunnel",
		)
		expect(run?.args).toMatchObject({
			input: { steps: SIGNUP, keyBy: "person", windowSeconds: 86_400, details: true, country: "DE" },
		})
	})

	test("paths wait for an anchor", () => {
		expect(names(resolved({ tab: "paths" }).commands)).not.toContain("FetchProductAnalyticsPaths")
		const run = resolved({
			tab: "paths",
			anchor: { kind: "event", eventName: "signup_completed" },
		}).commands?.find(({ name }) => name === "FetchProductAnalyticsPaths")
		expect(run?.args).toMatchObject({ input: { direction: "after", depth: 3, branches: 4 } })
	})

	test("an Events row's Funnel opens the Funnels tab with that event as step 1", () => {
		const model = settled(resolved().model, "events", EVENTS)
		const search = searchOf(
			pageUpdate(
				model,
				Message.ClickedStartFunnel({ step: { kind: "event", eventName: "signup_started" } }),
			).outMessage,
		)
		expect(search).toMatchObject({
			tab: "funnels",
			steps: [{ kind: "event", eventName: "signup_started" }],
		})
	})

	test("a typed step name reaches the URL after a pause, and only the last pause counts", () => {
		const model = resolved({ tab: "funnels", steps: [{ kind: "event", eventName: "" }] }).model
		const first = typing(model, "sign")
		expect(first.outMessage).toBeUndefined()
		expect(names(first.commands)).toContain("WaitForProductAnalyticsTypingPause")
		const second = typing(first.model, "signup")
		expect(
			pageUpdate(second.model, Message.PausedTyping({ version: first.model.typingVersion })).outMessage,
		).toBeUndefined()
		const committed = pageUpdate(
			second.model,
			Message.PausedTyping({ version: second.model.typingVersion }),
		)
		expect(searchOf(committed.outMessage).steps).toEqual([{ kind: "event", eventName: "signup" }])
	})

	test("a filter change mid-typing carries the typed step, and its pause no longer writes", () => {
		const typed = typing(
			resolved({ tab: "funnels", steps: [{ kind: "event", eventName: "" }] }).model,
			"signup",
		)
		const toEvents = pageUpdate(typed.model, Message.ChangedFilter({ key: "country", value: "DE" }))
		expect(searchOf(toEvents.outMessage).steps).toEqual([{ kind: "event", eventName: "signup" }])
		expect(
			pageUpdate(toEvents.model, Message.PausedTyping({ version: typed.model.typingVersion }))
				.outMessage,
		).toBeUndefined()
	})

	test("a row's Funnel replaces a half-typed funnel, even when the URL already starts there", () => {
		const start = resolved({
			tab: "funnels",
			steps: [{ kind: "event", eventName: "signup_started" }],
		}).model
		const added = pageUpdate(
			start,
			Message.ChangedStep({ scope: "funnel", edit: StepEdit.Added() }),
		).model
		const clicked = pageUpdate(
			added,
			Message.ClickedStartFunnel({ step: { kind: "event", eventName: "signup_started" } }),
		)
		expect(clicked.model.steps).toEqual([{ kind: "event", eventName: "signup_started" }])
	})

	test("the page's own URL write keeps the draft; Back to another definition replaces it", () => {
		const committed = pageUpdate(
			resolved({ tab: "funnels" }).model,
			Message.ChangedStep({ scope: "funnel", edit: StepEdit.Added() }),
		)
		const written: Search = { tab: "funnels", steps: [{ kind: "event", eventName: "" }] }
		// Typing continued before the route arrived: the draft is ahead of the URL and stays.
		const ahead = { ...committed.model, steps: [{ kind: "event" as const, eventName: "sig" }] }
		expect(routeChanged(ahead, { search: written }, context).model.steps).toEqual(ahead.steps)
		expect(
			routeChanged(ahead, { search: { tab: "funnels", steps: SIGNUP } }, context).model.steps,
		).toEqual(SIGNUP)
	})

	test("the rail's traffic and event keys do not apply here", () => {
		const model = resolved().model
		expect(
			pageUpdate(model, Message.ToggledFilter({ key: "traffic", value: "bots" })).outMessage,
		).toBeUndefined()
		expect(
			searchOf(pageUpdate(model, Message.ToggledFilter({ key: "country", value: "DE" })).outMessage)
				.country,
		).toBe("DE")
	})

	test("the Events tab lists every name with a way into a funnel", () => {
		scene(
			{ update: pageUpdate, view },
			given(settled(resolved().model, "events", EVENTS)),
			expectView(text("signup_completed")).toExist(),
			expectView(text("Page view")).toExist(),
			expectView(text("Top custom event")).toExist(),
		)
	})

	test("an org without events is told where they come from", () => {
		scene(
			{ update: pageUpdate, view },
			given(settled(resolved().model, "events", [])),
			expectView(text("No product events in this window")).toExist(),
		)
	})

	test("a funnel's answer draws its conversion, biggest drop and what leavers did", () => {
		const model = settled(resolved({ tab: "funnels", steps: SIGNUP }).model, "funnel", FUNNEL)
		scene(
			{ update: pageUpdate, view },
			given(model),
			Mount.resolve(
				MeasureChartContainer,
				Chart.Message.ResizedChartContainer({ width: 800, height: 320 }),
			),
			expectView(text("Biggest drop")).toExist(),
			expectView(text("docs_opened")).toExist(),
		)
	})
})
