import { OrgId } from "@maple/domain"
import { Schema } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ResolveThemeColors } from "../../charts/theme-colors"
import type { PageContext } from "../contract"
import { ApplyShareAppearance, MeasureGrid, ReadFrame, sectionsOf, WatchTile } from "./command"
import { Message } from "./message"
import type { Model, SharedDashboard, ShareWidget } from "./model"
import { init, update } from "./update"
import { appearanceOf, view as pageView } from "./view"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("public"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const NOW = Date.parse("2026-10-01T12:00:00Z")
const view = withViewInputs(pageView, { context })()

const widget = (id: string, extra: Partial<ShareWidget> = {}): ShareWidget => ({
	id,
	visualization: "markdown",
	display: { title: id, markdown: { content: "note" } },
	layout: { x: 0, y: 0, w: 3, h: 4 },
	dataSource: { kind: "static" },
	...extra,
})

const share = (
	widgets: ReadonlyArray<ShareWidget>,
	extra: Partial<SharedDashboard> = {},
): SharedDashboard => ({
	mode: "public",
	scope: "dashboard",
	embeddable: false,
	dashboard: {
		id: "dash_1",
		name: "Platform overview",
		timeRange: { type: "relative", value: "6h" },
		widgets,
		sections: [
			{
				id: "s1",
				title: "Latency",
				tabs: [
					{ id: "a", title: "Overview" },
					{ id: "b", title: "Breakdown" },
				],
			},
		],
	},
	...extra,
})

/** Resolved and measured: every tile has already reported, so a remeasure sends nothing. */
const resolved = (board: SharedDashboard, search: Model["search"] = {}): Model => {
	const model = [
		Message.CompletedResolveClock({ nowMs: NOW }),
		Message.CompletedResolveShare({ token: "tok", resolve: { _tag: "Ready", share: board } }),
		Message.MeasuredGrid({ width: 1200 }),
	].reduce((current, message) => update(current, message).model, init({ token: "tok", search }).model)
	return { ...model, options: Object.fromEntries(board.dashboard.widgets.map((w) => [w.id, 300])) }
}

const shell = () => [Mount.resolve(ResolveThemeColors, Message.ResolvedThemeColors({ colors: {} }))]
const tile = (widgetId: string) =>
	Mount.resolve(
		WatchTile({ widgetId, isBar: false }),
		Message.MeasuredWidget({ widgetId, maxDataPoints: 300 }),
	)
const grid = Mount.resolve(MeasureGrid, Message.MeasuredGrid({ width: 1200 }))

describe("share board", () => {
	test("entry reads whether the page is framed", () => {
		expect((init({ token: "tok", search: {} }).commands ?? []).map(({ name }) => name)).toContain(
			ReadFrame.name,
		)
	})

	test("a framed link the server did not mark embeddable renders the not-embeddable card", () => {
		const framed = update(
			resolved(share([widget("root")])),
			Message.CompletedReadFrame({ isFramed: true }),
		).model
		scene(
			{ update: (model, message) => update(model, message), view },
			given(framed),
			...shell(),
			expectView(text("This link can't be embedded")).toExist(),
			expectView(text("Platform overview")).not.toExist(),
		)
	})

	test("grouped tiles render under their group, on the active tab", () => {
		const board = share([
			widget("root"),
			widget("in-a", { sectionId: "s1", tabId: "a" }),
			widget("in-b", { sectionId: "s1", tabId: "b" }),
		])
		scene(
			{ update: (model, message) => update(model, message), view },
			given(resolved(board)),
			...shell(),
			grid,
			tile("root"),
			tile("in-a"),
			expectView(text("Latency")).toExist(),
			expectView(role("tab", { name: "Overview" })).toHaveAttr("aria-selected", "true"),
			expectView(text("in-a")).toExist(),
			expectView(text("in-b")).not.toExist(),
		)
	})

	test("sections in a shape this build cannot read drop the grouping, not the board", () => {
		expect(sectionsOf({ sections: [{ id: 1 }] })).toEqual([])
		expect(
			sectionsOf({ sections: [{ id: "s", title: "S", tabs: [{ id: "t", title: "T" }] }] }),
		).toHaveLength(1)
	})

	test("titles read the variables the server resolved for the batch", () => {
		const board = share([
			widget("root", { display: { title: "Throughput for $service", markdown: { content: "x" } } }),
		])
		const answered = update(
			resolved(board),
			Message.CompletedFetchBatch({ batchId: 0, keys: {}, states: {}, variables: { service: "api" } }),
		).model
		expect(answered.variables).toEqual({})
		const live = { ...answered, requested: { root: "k" } }
		const withVariables = update(
			live,
			Message.CompletedFetchBatch({
				batchId: 0,
				keys: { root: "k" },
				states: { root: { _tag: "Loading" } },
				variables: { service: "api" },
			}),
		).model
		scene(
			{ update: (model, message) => update(model, message), view },
			given(withVariables),
			...shell(),
			grid,
			tile("root"),
			expectView(text("Throughput for api")).toExist(),
		)
	})

	test("a tile pinned to its own window shows the window in its header", () => {
		const board = share([widget("root", { timeRange: { type: "relative", value: "7d" } })])
		scene(
			{ update: (model, message) => update(model, message), view },
			given(resolved(board)),
			...shell(),
			grid,
			tile("root"),
			expectView(text("Last 7 days")).toExist(),
		)
	})

	test("only a theme override or an embed changes the page's appearance", () => {
		expect(appearanceOf({})).toBeNull()
		expect(appearanceOf({ theme: "sepia" })).toBeNull()
		expect(appearanceOf({ theme: "light" })).toEqual({ theme: "light", isEmbed: false })
		const search = { embed: true, theme: "dark" }
		scene(
			{ update: (model, message) => update(model, message), view },
			given(resolved(share([]), search)),
			Mount.expectHas(ApplyShareAppearance({ theme: "dark", isEmbed: true })),
			Mount.resolve(ApplyShareAppearance, Message.AppliedShareAppearance()),
			...shell(),
		)
	})
})
