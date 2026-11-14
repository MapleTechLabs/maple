import { OrgId } from "@maple/domain"
import { Array as Arr, Option, Result, Schema } from "effect"
import { fromString } from "foldkit/url"
import { expect as expectView, given, Mount, scene, selector, text, withViewInputs } from "foldkit/scene"
import * as Chart from "@maple/views/charts/chart"
import * as Select from "@maple/views/ui/select"
import { MeasureChartContainer } from "@maple/views/charts/chart-mounts"
import { describe, expect, test } from "vitest"
import { StepEdit } from "../kit/funnel-steps"
import { urlToAppRoute } from "../../route"
import type { PageContext } from "../contract"
import type { Search } from "./definition"
import { Message, type SlotName } from "./message"
import type { EventRow, FunnelRow, Model } from "./model"
import { BREAKDOWN_SELECT_ID, init, routeChanged, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-27 00:00:00", endTime: "2026-11-03 00:00:00" }

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)
const sentAs = <C extends { readonly name: string }>(
	commands: ReadonlyArray<C> | undefined,
	name: string,
): C | undefined => Option.getOrUndefined(Arr.findFirst(commands ?? [], (command) => command.name === name))

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
	{
		name: "signup_completed",
		value: 742,
		p50Ms: 41_000,
		p90Ms: 600_000,
		sinceStartP50Ms: 41_000,
		sinceStartP90Ms: 600_000,
		leavers: [
			{ name: "docs_opened", count: 116 },
			{ name: "", count: 232 },
		],
	},
]

const measured = Mount.resolve(
	MeasureChartContainer,
	Chart.Message.ResizedChartContainer({ width: 800, height: 320 }),
)

const pickBreakdown = (model: Model, value: string) =>
	pageUpdate(
		model,
		Message.GotSelectMessage({
			id: BREAKDOWN_SELECT_ID,
			message: Select.Message.SelectedItem({ index: 0, value }),
		}),
	)

const SIGNUP: Search["steps"] = [
	{ kind: "event", eventName: "signup_started" },
	{ kind: "event", eventName: "signup_completed" },
]

describe("product analytics", () => {
	test("the Events tab reads the rail's options and this window's and the previous window's events", () => {
		const sent = names(resolved().commands)
		expect(sent).toContain("FetchProductAnalyticsBreakdowns")
		expect(Arr.filter(sent, (name) => name === "FetchProductEventNames")).toHaveLength(2)
		expect(sent).not.toContain("FetchProductAnalyticsFunnel")
	})

	test("a funnel runs only once a step names something, with the drop-off details by default", () => {
		expect(names(resolved({ tab: "funnels" }).commands)).not.toContain("FetchProductAnalyticsFunnel")
		const run = sentAs(
			resolved({ tab: "funnels", steps: SIGNUP, country: "DE" }).commands,
			"FetchProductAnalyticsFunnel",
		)
		expect(run?.args).toMatchObject({
			input: { steps: SIGNUP, keyBy: "person", windowSeconds: 86_400, details: true, country: "DE" },
		})
	})

	test("names typed with stray spaces still match their events", () => {
		const run = sentAs(
			resolved({ tab: "funnels", steps: [{ kind: "event", eventName: "signup " }] }).commands,
			"FetchProductAnalyticsFunnel",
		)
		expect(run?.args).toMatchObject({ input: { steps: [{ kind: "event", eventName: "signup" }] } })
	})

	test("paths wait for an anchor", () => {
		expect(names(resolved({ tab: "paths" }).commands)).not.toContain("FetchProductAnalyticsPaths")
		const run = sentAs(
			resolved({ tab: "paths", anchor: { kind: "event", eventName: "signup_completed" } }).commands,
			"FetchProductAnalyticsPaths",
		)
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

	test("walking back from the anchor, a sequence that runs out is where it started", () => {
		const model = settled(
			resolved({
				tab: "paths",
				direction: "before",
				anchor: { kind: "event", eventName: "plan_started" },
			}).model,
			"paths",
			[
				{ hop: 1, fromNode: "plan_started", toNode: "/pricing", count: 40 },
				{ hop: 2, fromNode: "/pricing", toNode: "", count: 40 },
			],
		)
		scene(
			{ update: pageUpdate, view },
			given(model),
			Mount.resolve(
				MeasureChartContainer,
				Chart.Message.ResizedChartContainer({ width: 800, height: 320 }),
			),
			expectView(text("Where sequences started")).toExist(),
			expectView(text("Where sequences ended")).not.toExist(),
		)
	})

	test("Back to another window mid-typing restarts the pause; the page's own write keeps it", () => {
		const start = resolved({ tab: "funnels", steps: [{ kind: "event", eventName: "" }] }).model
		const typed = typing(start, "sig")
		const back = routeChanged(
			typed.model,
			{ search: { tab: "funnels", steps: [{ kind: "event", eventName: "" }], timePreset: "24h" } },
			context,
		)
		expect(back.model.steps).toEqual([{ kind: "event", eventName: "sig" }])
		expect(
			pageUpdate(back.model, Message.PausedTyping({ version: typed.model.typingVersion })).outMessage,
		).toBeUndefined()
		expect(names(back.commands)).toContain("WaitForProductAnalyticsTypingPause")
		const landed24h = pageUpdate(back.model, Message.PausedTyping({ version: back.model.typingVersion }))
		expect(searchOf(landed24h.outMessage)).toMatchObject({
			timePreset: "24h",
			steps: [{ kind: "event", eventName: "sig" }],
		})

		const committed = pageUpdate(
			typed.model,
			Message.PausedTyping({ version: typed.model.typingVersion }),
		)
		const more = typing(committed.model, "signup")
		const landed = routeChanged(
			more.model,
			{ search: { tab: "funnels", steps: [{ kind: "event", eventName: "sig" }] } },
			context,
		)
		expect(
			pageUpdate(landed.model, Message.PausedTyping({ version: more.model.typingVersion })).outMessage,
		).toBeDefined()
	})

	test("a Page anchor with no path yet stays a Page anchor", () => {
		const picked = pageUpdate(
			resolved({ tab: "paths" }).model,
			Message.ChangedStep({ scope: "paths", edit: StepEdit.SetKind({ index: 0, kind: "page" }) }),
		)
		expect(picked.model.anchor).toEqual({ kind: "page", pagePath: "" })
		expect(routeChanged(picked.model, { search: { tab: "paths" } }, context).model.anchor.kind).toBe(
			"page",
		)
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

	test("exactly 200 names is a full answer; one more says the totals are capped", () => {
		const names = (count: number): ReadonlyArray<EventRow> =>
			Array.from({ length: count }, (_, index) => ({
				eventName: `event_${index}`,
				kind: "custom",
				count: 1,
				sessions: 1,
				persons: 1,
			}))
		scene(
			{ update: pageUpdate, view },
			given(settled(resolved().model, "events", names(200))),
			expectView(text("200+")).not.toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(settled(resolved().model, "events", names(201))),
			expectView(text("across the top 200 names")).toExist(),
		)
	})

	test("an org without events is told where they come from", () => {
		scene(
			{ update: pageUpdate, view },
			given(settled(resolved().model, "events", [])),
			expectView(text("No product events in this window")).toExist(),
		)
	})

	test("a funnel's answer draws its conversion, how long it takes and where the leavers went", () => {
		const model = settled(resolved({ tab: "funnels", steps: SIGNUP }).model, "funnel", FUNNEL)
		scene(
			{ update: pageUpdate, view },
			given(model),
			measured,
			expectView(text("Biggest drop")).toExist(),
			expectView(text("median · 90% within 10m")).toExist(),
			// 464 dropped before signup_completed: 116 opened the docs, 232 did nothing else.
			expectView(text("docs_opened")).toExist(),
			expectView(text("25%")).toExist(),
			expectView(text("nothing after")).toExist(),
			expectView(text("50%")).toExist(),
		)
	})

	test("the funnel is read again for the window before, counts only, and compared with it", () => {
		const { commands, model } = resolved({ tab: "funnels", steps: SIGNUP })
		const runs = Arr.filter(commands ?? [], (command) => command.name === "FetchProductAnalyticsFunnel")
		expect(Arr.map(runs, (run) => run.args)).toMatchObject([
			{ slot: "funnel", input: { startTime: window.startTime, details: true } },
			{
				slot: "previousFunnel",
				input: { startTime: "2026-10-20 00:00:00", endTime: window.startTime, details: false },
			},
		])
		// 61.5% now against 50% the week before.
		const compared = settled(settled(model, "funnel", FUNNEL), "previousFunnel", [
			{ name: "signup_started", value: 1_000 },
			{ name: "signup_completed", value: 500 },
		])
		scene(
			{ update: pageUpdate, view },
			given(compared),
			measured,
			expectView(selector('[title="Up 11.5 pts vs the previous period"]')).toExist(),
		)
		// While the previous period refetches for a new definition, the old rows are not compared.
		const refetching = pageUpdate(compared, Message.ClickedRetry({ slot: "previousFunnel" })).model
		scene(
			{ update: pageUpdate, view },
			given(refetching),
			measured,
			expectView(selector('[title="Up 11.5 pts vs the previous period"]')).not.toExist(),
		)
	})

	test("a breakdown splits the funnel into up to twenty groups and compares each with everyone", () => {
		const { commands, model } = resolved({ tab: "funnels", steps: SIGNUP, breakdown: "utmSource" })
		const split = Arr.findFirst(
			commands ?? [],
			(command) =>
				command.name === "FetchProductAnalyticsFunnel" && command.args?.slot === "funnelBreakdown",
		)
		expect(Option.getOrUndefined(split)?.args).toMatchObject({
			input: { breakdownBy: "utmSource", breakdownLimit: 20, details: false },
		})
		const answered = settled(settled(model, "funnel", FUNNEL), "funnelBreakdown", [
			{ name: "signup_started", value: 400, group: "newsletter" },
			{ name: "signup_completed", value: 300, group: "newsletter" },
			{ name: "signup_started", value: 806, group: "google" },
			{ name: "signup_completed", value: 442, group: "google" },
		])
		scene(
			{ update: pageUpdate, view },
			given(answered),
			measured,
			expectView(text("By UTM source")).toExist(),
			// The newsletter converts 75% against 61.5% overall; google 54.8%.
			expectView(text("75%")).toExist(),
			expectView(selector('[title="Up 13.5 pts vs everyone in this window"]')).toExist(),
			expectView(selector('[title="Down 6.7 pts vs everyone in this window"]')).toExist(),
		)
	})

	test("a group nobody entered is left out, and a breakdown with no groups says so", () => {
		const model = settled(
			resolved({ tab: "funnels", steps: SIGNUP, breakdown: "utmSource" }).model,
			"funnel",
			FUNNEL,
		)
		const lateOnly = [
			{ name: "signup_started", value: 0, group: "partner" },
			{ name: "signup_completed", value: 4, group: "partner" },
		]
		scene(
			{ update: pageUpdate, view },
			given(settled(model, "funnelBreakdown", lateOnly)),
			measured,
			expectView(text("partner")).not.toExist(),
			expectView(text("Nobody who entered has a UTM source in this window.")).toExist(),
		)
	})

	test("a one-step funnel asks for no breakdown and says a second step is needed", () => {
		const one: Search["steps"] = [{ kind: "event", eventName: "signup_started" }]
		const { commands, model } = resolved({ tab: "funnels", steps: one, breakdown: "country" })
		expect(
			Arr.filter(commands ?? [], (command) => command.args?.slot === "funnelBreakdown"),
		).toHaveLength(0)
		scene(
			{ update: pageUpdate, view },
			given(settled(model, "funnel", [{ name: "signup_started", value: 1_206 }])),
			measured,
			expectView(text("Add a second step to compare how each group converts.")).toExist(),
		)
	})

	test("a funnel nobody finished says so instead of showing a time", () => {
		const unfinished: ReadonlyArray<FunnelRow> = [
			{ name: "signup_started", value: 1_206 },
			{
				name: "signup_completed",
				value: 0,
				p50Ms: 0,
				p90Ms: 0,
				sinceStartP50Ms: 0,
				sinceStartP90Ms: 0,
			},
		]
		scene(
			{ update: pageUpdate, view },
			given(settled(resolved({ tab: "funnels", steps: SIGNUP }).model, "funnel", unfinished)),
			measured,
			expectView(text("nobody converted")).toExist(),
			expectView(text("under 1s")).not.toExist(),
		)
	})

	test("a step's property filter reaches the URL once it parses, and Enter does not wait", () => {
		const shown = pageUpdate(
			resolved({ tab: "funnels", steps: SIGNUP }).model,
			Message.ToggledStepFilters(),
		)
		expect(shown.outMessage).toBeUndefined()
		const filter = (model: Model, value: string) =>
			pageUpdate(
				model,
				Message.ChangedStep({
					scope: "funnel",
					edit: StepEdit.ChangedText({ index: 1, field: "filterClause", value }),
				}),
			)
		const typed = filter(shown.model, 'method = "google"')
		expect(typed.outMessage).toBeUndefined()
		const entered = pageUpdate(typed.model, Message.SubmittedStepFilter())
		expect(searchOf(entered.outMessage).steps).toEqual([
			{ kind: "event", eventName: "signup_started" },
			{ kind: "event", eventName: "signup_completed", attributeEquals: { method: "google" } },
		])
		// Half a clause does not parse: the step keeps running with the filter that did.
		const landed = routeChanged(entered.model, { search: searchOf(entered.outMessage) }, context).model
		const halfway = pageUpdate(
			filter(landed, 'method = "google" AND plan').model,
			Message.SubmittedStepFilter(),
		)
		expect(searchOf(halfway.outMessage).steps?.[1]).toEqual({
			kind: "event",
			eventName: "signup_completed",
			attributeEquals: { method: "google" },
		})
		scene(
			{ update: pageUpdate, view },
			given(halfway.model),
			expectView(text('"plan" is not a key = "value" clause')).toExist(),
		)
	})

	test("a step keeps its own filter when another step is removed while its clause is half typed", () => {
		const twoFilters: Search["steps"] = [
			{ kind: "event", eventName: "page_viewed", attributeEquals: { page: "pricing" } },
			{ kind: "event", eventName: "page_viewed", attributeEquals: { page: "checkout" } },
		]
		const halfTyped = pageUpdate(
			resolved({ tab: "funnels", steps: twoFilters }).model,
			Message.ChangedStep({
				scope: "funnel",
				edit: StepEdit.ChangedText({ index: 1, field: "filterClause", value: "page = " }),
			}),
		).model
		const removed = pageUpdate(
			halfTyped,
			Message.ChangedStep({ scope: "funnel", edit: StepEdit.Removed({ index: 0 }) }),
		)
		expect(searchOf(removed.outMessage).steps).toEqual([
			{ kind: "event", eventName: "page_viewed", attributeEquals: { page: "checkout" } },
		])
	})

	test("emptying a filter to retype it keeps the filter lines", () => {
		const filtered: Search["steps"] = [
			{ kind: "event", eventName: "signup_started" },
			{ kind: "event", eventName: "signup_completed", attributeEquals: { method: "google" } },
		]
		const emptied = pageUpdate(
			resolved({ tab: "funnels", steps: filtered }).model,
			Message.ChangedStep({
				scope: "funnel",
				edit: StepEdit.ChangedText({ index: 1, field: "filterClause", value: "" }),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(emptied),
			expectView(selector('[aria-label="Step 2 attribute filter"]')).toExist(),
		)
	})

	test("an Events row's Funnel starts clean, even on the event being edited", () => {
		const halfTyped = pageUpdate(
			pageUpdate(
				resolved({ tab: "funnels", steps: [{ kind: "event", eventName: "signup_started" }] }).model,
				Message.ToggledStepFilters(),
			).model,
			Message.ChangedStep({
				scope: "funnel",
				edit: StepEdit.ChangedText({ index: 0, field: "filterClause", value: "plan =" }),
			}),
		).model
		const opened = pageUpdate(
			halfTyped,
			Message.ClickedStartFunnel({ step: { kind: "event", eventName: "signup_started" } }),
		)
		expect(opened.model.steps).toEqual([{ kind: "event", eventName: "signup_started" }])
	})

	test("a shared funnel with a filtered step opens with its filter line, and the toggle clears it", () => {
		const filtered: Search["steps"] = [
			{ kind: "event", eventName: "signup_started" },
			{ kind: "event", eventName: "signup_completed", attributeEquals: { method: "google" } },
		]
		const model = resolved({ tab: "funnels", steps: filtered }).model
		expect(model.steps[1]).toMatchObject({ filterClause: 'method = "google"' })
		const cleared = pageUpdate(model, Message.ToggledStepFilters())
		expect(searchOf(cleared.outMessage).steps).toEqual(SIGNUP)
	})

	test("picking a breakdown writes it to the URL, and None clears it", () => {
		const model = resolved({ tab: "funnels", steps: SIGNUP }).model
		expect(searchOf(pickBreakdown(model, "attribute:plan").outMessage).breakdown).toBe("attribute:plan")
		expect(pickBreakdown(model, "not-a-dimension").outMessage).toBeUndefined()
		const split = resolved({ tab: "funnels", steps: SIGNUP, breakdown: "country" }).model
		expect(searchOf(pickBreakdown(split, "").outMessage)).toMatchObject({ tab: "funnels", steps: SIGNUP })
		expect(searchOf(pickBreakdown(split, "").outMessage).breakdown).toBeUndefined()
	})
})
