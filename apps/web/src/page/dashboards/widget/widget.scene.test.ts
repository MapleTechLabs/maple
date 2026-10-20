import { OrgId } from "@maple/domain"
import { DashboardDocument } from "@maple/domain/http"
import { dataSourceQuerySet } from "@maple/widgets/dashboard"
import { Option, Schema } from "effect"
import { ResolveThemeColors } from "../../../charts/theme-colors"
import { expect as expectView, given, Mount, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../../contract"
import { FetchAutocomplete, FetchWidget, SaveWidget } from "./command"
import { setPanelType, withRootOnly } from "./edits"
import { buildDataSource, buildDisplay, toInitialState, validationErrorOf } from "./lowering"
import * as QueryPanel from "../../kit/query-builder/panel"
import { Message } from "./message"
import type { Model } from "./model"
import { update } from "./page-update"
import { init, isDirty, previewWidgetOf } from "./update"
import * as Tabs from "../../../ui/tabs"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const throughput = {
	id: "throughput",
	visualization: "chart",
	dataSource: {
		kind: "query",
		resultShape: "timeseries",
		queries: [
			{
				id: "q-throughput",
				name: "Throughput",
				dataSource: "traces",
				aggregation: "count",
				whereClause: "",
				addOns: { groupBy: true, having: false, orderBy: false, limit: false, legend: false },
				groupBy: ["service.name"],
			},
		],
	},
	display: {
		title: "Throughput by Service",
		chartId: "query-builder-area",
		stacked: true,
		curveType: "monotone",
		unit: "number",
		chartPresentation: { legend: "visible", showPoints: false },
	},
	layout: { x: 0, y: 0, w: 6, h: 6 },
}

const document = Schema.decodeUnknownSync(DashboardDocument)({
	id: "dash_platform",
	name: "Platform overview",
	timeRange: { type: "relative", value: "6h" },
	widgets: [throughput],
	createdAt: "2026-09-19T12:00:00.000Z",
	updatedAt: "2026-09-28T12:00:00.000Z",
	schemaVersion: 3,
})
const stored = document.widgets[0]

const route = (widgetId: string) => ({ dashboardId: "dash_platform", widgetId, search: {} })

const opened = (widgetId = "throughput") =>
	[
		Message.CompletedReadClock({ nowMs: NOW }),
		Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(document) }),
	].reduce(
		(step, message) => {
			const next = pageUpdate(step.model, message)
			return { model: next.model, commands: [...step.commands, ...(next.commands ?? [])] }
		},
		{
			model: init(route(widgetId), context).model,
			commands: [] as ReadonlyArray<{ readonly name: string }>,
		},
	)

describe("widget editor", () => {
	test("the stored widget seeds the editor, and the preview fetches once", () => {
		const { model, commands } = opened()
		expect(model.status).toBe("Ready")
		expect(model.state?.title).toBe("Throughput by Service")
		expect(model.state?.legendPosition).toBe("bottom")
		expect(model.state?.pointsMode).toBe("never")
		expect(names(commands)).toEqual([FetchWidget.name])
	})

	test("an unknown widget id is the not-found state", () => {
		scene(
			{ update: pageUpdate, view },
			given(opened("nope").model),
			Mount.resolve(ResolveThemeColors, Message.ResolvedThemeColors({ colors: {} })),
			expectView(text("Widget not found")).toExist(),
		)
	})

	test("a presentation edit reaches the preview at once; a query edit waits for Run preview", () => {
		const { model } = opened()
		const legend = pageUpdate(model, Message.ChangedLegend({ legendPosition: "right" }))
		expect(previewWidgetOf(legend.model)?.display.chartPresentation?.legend).toBe("right")
		expect(names(legend.commands)).toEqual([])
		const ungrouped = pageUpdate(
			model,
			Message.GotQueryPanelMessage({
				message: QueryPanel.Message.ToggledAddOn({ queryId: "q-throughput", key: "groupBy" }),
			}),
		)
		expect(names(ungrouped.commands)).toEqual([])
		const run = pageUpdate(ungrouped.model, Message.ClickedRunPreview())
		expect(names(run.commands)).toEqual([FetchWidget.name])
	})

	test("Apply writes the edited widget, then returns to the dashboard in edit mode", () => {
		const renamed = pageUpdate(opened().model, Message.ChangedTitle({ value: "Throughput (all)" })).model
		const applied = pageUpdate(renamed, Message.ClickedApply())
		expect(names(applied.commands)).toEqual([SaveWidget.name])
		expect(applied.model.isSaving).toBe(true)
		const saved = pageUpdate(applied.model, Message.CompletedSave({ error: null }))
		expect(saved.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/dashboards/dash_platform?mode=edit",
				isReplace: false,
			}),
		)
	})

	test("Cancel asks first only when something changed", () => {
		const clean = pageUpdate(opened().model, Message.ClickedCancel())
		expect(clean.outMessage?._tag).toBe("RequestedNavigation")
		const renamed = pageUpdate(opened().model, Message.ChangedTitle({ value: "Renamed" })).model
		const dirty = pageUpdate(renamed, Message.ClickedCancel())
		expect(dirty.outMessage).toBeUndefined()
		expect(dirty.model.leaveDialog.isOpen).toBe(true)
	})

	test("a failed time-range save is reported, a saved one is quiet", () => {
		const model = opened().model
		expect(pageUpdate(model, Message.CompletedSaveTimeRange({ error: null })).outMessage).toBeUndefined()
		expect(pageUpdate(model, Message.CompletedSaveTimeRange({ error: "Dashboard is read-only" })).outMessage).toEqual(
			PageOutMessage.RequestedToast({
				type: "error",
				title: "Dashboard is read-only",
				description: "",
				timeoutMs: null,
				action: null,
			}),
		)
	})

	test("the first focus in the query editor starts every autocomplete lookup, once", () => {
		const focused = pageUpdate(opened().model, Message.FocusedQueryEditor())
		expect(names(focused.commands).filter((name) => name === FetchAutocomplete.name)).toHaveLength(7)
		expect(names(pageUpdate(focused.model, Message.FocusedQueryEditor()).commands)).toEqual([])
	})
})

describe("widget lowering", () => {
	test("an unchanged state lowers back to the stored display and query set", () => {
		const state = toInitialState(stored)
		const display = buildDisplay(stored, state)
		expect(display.title).toBe("Throughput by Service")
		expect(display.chartPresentation?.legend).toBe("visible")
		expect(display.stacked).toBe(true)
		expect(dataSourceQuerySet(stored.dataSource)?.queries[0]?.groupBy).toEqual(state.queries[0]?.groupBy)
	})

	test("an untitled chart takes a title derived from its first query", () => {
		const state = { ...toInitialState(stored), title: "  " }
		expect(buildDisplay(stored, state).title).toBe("Count of traces by service.name")
	})

	test("a chart switched to a note lowers to a static note with its body, and nothing to validate", () => {
		const note = setPanelType({ ...toInitialState(stored), markdownContent: "## Runbook" }, "markdown")
		expect(buildDataSource(note)).toEqual({ kind: "static" })
		const display = buildDisplay(stored, note)
		expect(display.markdown).toEqual({ content: "## Runbook" })
		expect(display.stacked).toBeUndefined()
		expect(validationErrorOf(note)).toBeNull()
	})

	test("the Raw SQL tab is an unsaved change; Apply writes the SQL only once it scopes to the org", () => {
		const sqlTab = pageUpdate(opened().model, Message.GotSourceTabsMessage({ message: Tabs.Message.ClickedTab({ index: 1 }) })).model
		expect(isDirty(sqlTab)).toBe(true)
		expect(previewWidgetOf(sqlTab)?.dataSource).toMatchObject({ kind: "raw_sql" })
		const unscoped = pageUpdate(sqlTab, Message.ChangedSql({ value: "SELECT 1 AS value" })).model
		expect(names(pageUpdate(unscoped, Message.ClickedApply()).commands)).toEqual([])
		expect(names(pageUpdate(sqlTab, Message.ClickedApply()).commands)).toEqual([SaveWidget.name])
	})

	test("the spans select rewrites root_only in the where clause", () => {
		expect(withRootOnly('service.name = "api"', true)).toBe('service.name = "api" AND root_only = true')
		expect(withRootOnly('service.name = "api" AND root_only = true', false)).toBe('service.name = "api"')
		expect(withRootOnly("", true)).toBe("root_only = true")
	})
})
