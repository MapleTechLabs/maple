import { OrgId } from "@maple/domain"
import { Effect, Schema } from "effect"
import { AsyncData } from "foldkit"
import { toLoadFailure } from "@maple/views/data/load-failure"
import type { PageContext } from "../../page/contract"
import type { Search } from "../../page/product-analytics/definition"
import { Message } from "../../page/product-analytics/message"
import { type EventRow, type FunnelRow, Model, type PathsRow } from "../../page/product-analytics/model"
import { init as pageInit, update as pageUpdate } from "../../page/product-analytics/update"
import { view as pageView } from "../../page/product-analytics/view"
import type { Breakdowns } from "../../page/kit/analytics-filter-rail"
import { defineShellLab } from "../shell-lab"

// `/lab/product-analytics?state=<scenario>`: the Product analytics tabs over fixtures, in the real
// shell. Reads and navigation are dropped, so nothing leaves the browser.

const Scenario = Schema.Literals([
	"events",
	"events-empty",
	"events-loading",
	"funnels",
	"funnels-bars",
	"funnels-new",
	"funnels-error",
	"paths",
	"paths-new",
])
type Scenario = typeof Scenario.Type
const isScenario = Schema.is(Scenario)

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_lab"),
	pinnedNamespace: null,
	timeZone: "UTC",
}

const EVENTS: ReadonlyArray<EventRow> = [
	{ eventName: "$pageview", kind: "navigation", count: 38_412, sessions: 9_204, persons: 4_812 },
	{ eventName: "signup_started", kind: "custom", count: 1_488, sessions: 1_260, persons: 1_206 },
	{ eventName: "signup_completed", kind: "custom", count: 742, sessions: 742, persons: 742 },
	{ eventName: "query_run", kind: "custom", count: 6_210, sessions: 1_310, persons: 402 },
	{ eventName: "onboarding_connected", kind: "custom", count: 388, sessions: 388, persons: 388 },
	{ eventName: "dashboard_created", kind: "custom", count: 531, sessions: 470, persons: 311 },
	{ eventName: "alert_created", kind: "custom", count: 214, sessions: 201, persons: 162 },
	{ eventName: "Home", kind: "screen", count: 1_902, sessions: 640, persons: 188 },
	{ eventName: "plan_started", kind: "custom", count: 61, sessions: 61, persons: 61 },
]

const PREVIOUS: ReadonlyArray<EventRow> = EVENTS.map((row) => ({
	...row,
	count: Math.round(row.count * 0.89),
}))

const FUNNEL: ReadonlyArray<FunnelRow> = [
	{ name: "signup_started", value: 1_206 },
	{
		name: "signup_completed",
		value: 742,
		p50Ms: 190_000,
		p90Ms: 1_420_000,
		leavers: [{ name: "docs_opened", count: 210 }],
	},
	{
		name: "onboarding_connected",
		value: 388,
		p50Ms: 6_720_000,
		p90Ms: 86_000_000,
		leavers: [{ name: "", count: 190 }],
	},
	{
		name: "plan_started",
		value: 61,
		p50Ms: 187_000_000,
		p90Ms: 520_000_000,
		leavers: [{ name: "dashboard_viewed", count: 140 }],
	},
]

const PATHS: ReadonlyArray<PathsRow> = [
	{ hop: 1, fromNode: "signup_completed", toNode: "onboarding_viewed", count: 410 },
	{ hop: 1, fromNode: "signup_completed", toNode: "dashboard_viewed", count: 160 },
	{ hop: 1, fromNode: "signup_completed", toNode: "docs_opened", count: 92 },
	{ hop: 1, fromNode: "signup_completed", toNode: "$other", count: 50 },
	{ hop: 1, fromNode: "signup_completed", toNode: "", count: 30 },
	{ hop: 2, fromNode: "onboarding_viewed", toNode: "onboarding_connected", count: 290 },
	{ hop: 2, fromNode: "onboarding_viewed", toNode: "query_run", count: 60 },
	{ hop: 2, fromNode: "onboarding_viewed", toNode: "", count: 60 },
	{ hop: 2, fromNode: "dashboard_viewed", toNode: "query_run", count: 90 },
	{ hop: 2, fromNode: "dashboard_viewed", toNode: "/pricing", count: 40 },
	{ hop: 2, fromNode: "dashboard_viewed", toNode: "", count: 30 },
	{ hop: 2, fromNode: "docs_opened", toNode: "/pricing", count: 34 },
	{ hop: 2, fromNode: "docs_opened", toNode: "", count: 58 },
	{ hop: 2, fromNode: "$other", toNode: "$other", count: 50 },
	{ hop: 3, fromNode: "onboarding_connected", toNode: "dashboard_created", count: 170 },
	{ hop: 3, fromNode: "onboarding_connected", toNode: "alert_created", count: 64 },
	{ hop: 3, fromNode: "onboarding_connected", toNode: "", count: 56 },
	{ hop: 3, fromNode: "query_run", toNode: "dashboard_created", count: 40 },
	{ hop: 3, fromNode: "query_run", toNode: "query_run", count: 84 },
	{ hop: 3, fromNode: "query_run", toNode: "", count: 26 },
	{ hop: 3, fromNode: "/pricing", toNode: "alert_created", count: 32 },
	{ hop: 3, fromNode: "/pricing", toNode: "", count: 42 },
	{ hop: 3, fromNode: "$other", toNode: "", count: 50 },
]

const BREAKDOWNS: Breakdowns = {
	referrerHosts: [
		{ name: "google.com", count: 3_200 },
		{ name: "github.com", count: 1_900 },
		{ name: "news.ycombinator.com", count: 804 },
	],
	countries: [
		{ name: "US", count: 6_100 },
		{ name: "DE", count: 2_400 },
		{ name: "GB", count: 1_300 },
	],
	deviceTypes: [
		{ name: "desktop", count: 15_000 },
		{ name: "mobile", count: 3_200 },
	],
	browsers: [
		{ name: "Chrome", count: 12_000 },
		{ name: "Safari", count: 4_100 },
	],
	operatingSystems: [{ name: "Mac OS", count: 9_000 }],
	languages: [{ name: "en-US", count: 11_000 }],
	utmSources: [],
	utmMediums: [],
	utmCampaigns: [],
	entryPaths: [
		{ name: "/", count: 8_100 },
		{ name: "/pricing", count: 2_300 },
		{ name: "/onboarding", count: 744 },
	],
	exitPaths: [],
	hosts: [
		{ name: "app.maple.dev", count: 12_400 },
		{ name: "maple.dev", count: 8_900 },
	],
}

const SIGNUP_TO_PAID: Search["steps"] = FUNNEL.map((row) => ({ kind: "event", eventName: row.name }))

const searchOf = (scenario: Scenario): Search => {
	switch (scenario) {
		case "events":
		case "events-empty":
		case "events-loading":
			return {}
		case "funnels":
		case "funnels-error":
			return { tab: "funnels", steps: SIGNUP_TO_PAID }
		case "funnels-bars":
			return { tab: "funnels", steps: SIGNUP_TO_PAID, view: "bars" }
		case "funnels-new":
			return { tab: "funnels" }
		case "paths":
			return { tab: "paths", anchor: { kind: "event", eventName: "signup_completed" } }
		case "paths-new":
			return { tab: "paths" }
	}
}

const loaded = <A>(data: A) => ({ key: "lab", data: AsyncData.Success({ data }) })

const init = (flags: typeof Flags.Type) => {
	const { scenario } = flags
	const base = pageInit({ search: searchOf(scenario) }, context).model
	const model: Model = {
		...base,
		window: { startTime: "2026-10-27 00:00:00", endTime: "2026-11-03 00:00:00" },
		breakdowns: loaded(BREAKDOWNS),
		events:
			scenario === "events-loading"
				? { key: "lab", data: AsyncData.Loading() }
				: loaded(scenario === "events-empty" ? [] : EVENTS),
		previousEvents: loaded(PREVIOUS),
		funnel:
			scenario === "funnels-error"
				? {
						key: "lab",
						data: AsyncData.Failure({ error: toLoadFailure("The warehouse timed out.") }),
					}
				: loaded(FUNNEL),
		paths: loaded(PATHS),
	}
	return { model }
}

/** Reads and the window never leave the lab; everything local (popovers, typing pauses) runs. */
const isLocalCommand = (command: { readonly name: string }): boolean =>
	!command.name.startsWith("Fetch") && command.name !== "ResolveProductAnalyticsWindow"

const update = (model: Model, message: Message) => {
	const next = pageUpdate(model, message, context)
	return { model: next.model, commands: (next.commands ?? []).filter(isLocalCommand) }
}

const Flags = Schema.Struct({ scenario: Scenario })

export const lab = defineShellLab("Product analytics", {
	Model,
	Message,
	Flags,
	flags: Effect.sync(() => {
		const state = new URLSearchParams(window.location.search).get("state")
		return { scenario: isScenario(state) ? state : "events" }
	}),
	init,
	update,
	view: (model, h) =>
		h.submodel({
			slotId: "product-analytics-lab",
			model,
			view: pageView,
			toParentMessage: (message: Message) => message,
			viewInputs: { context, isBelowSm: false },
		}),
	currentPath: "/product-analytics",
	breadcrumbs: [{ label: "Product analytics", isPageHeading: true }],
})
