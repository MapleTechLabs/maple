import { OrgId } from "@maple/domain"
import { DashboardDocument, type PanelType } from "@maple/domain/http"
import { statPresets, tablePresets } from "@maple/web-data/dashboards/widget-presets"
import {
	dataSourceQuerySet,
	dataSourceTransform,
	makeRawSqlDataSource,
	makeRouteDataSource,
} from "@maple/widgets/dashboard"
import { ResolveThemeColors } from "@maple/views/charts/theme-colors"
import { Option, Schema, Array as Arr } from "effect"
import { expect as expectView, given, Mount, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import * as QueryPanel from "../../kit/query-builder/panel"
import * as Combobox from "@maple/views/ui/combobox"
import { CaretMessage } from "../../kit/where-autocomplete"
import { WhereFieldMessage } from "../../kit/where-field"
import { MountWhereFieldCaret } from "../../kit/where-field-command"
import { Message } from "./message"
import type { Model } from "./model"
import { update } from "./page-update"
import { canApply, editedWidget, init, previewWidgetOf } from "./update"
import { listDataSourceOf } from "./lowering-list"
import * as Tabs from "@maple/views/ui/tabs"
import { MeasurePreview } from "./command"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const NOW = Date.parse("2026-10-01T12:00:00Z")
const view = withViewInputs(pageView, { context })()

const presetOf = (id: string) =>
	[...statPresets, ...tablePresets].find((preset) => preset.id === id) ??
	expect.unreachable(`no preset ${id}`)

/** A board holding one widget built from `dataSource`, opened in the editor. */
const opened = (visualization: string, dataSource: unknown, display: Readonly<Record<string, unknown>>) => {
	const document = Schema.decodeUnknownSync(DashboardDocument)({
		id: "dash",
		name: "Board",
		timeRange: { type: "relative", value: "6h" },
		widgets: [{ id: "w", visualization, dataSource, display, layout: { x: 0, y: 0, w: 3, h: 4 } }],
		createdAt: "2026-09-19T12:00:00.000Z",
		updatedAt: "2026-09-28T12:00:00.000Z",
		schemaVersion: 3,
	})
	const widget = document.widgets[0] ?? expect.unreachable("the board has one widget")
	const model = Arr.reduce(
		[
			Message.CompletedReadClock({ nowMs: NOW }),
			Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(document) }),
		],
		init({ dashboardId: "dash", widgetId: "w", search: {} }, context).model,
		(current, message) => update(current, message, context).model,
	)
	return { widget, model }
}

const openedPreset = (id: string) => {
	const preset = presetOf(id)
	return opened(preset.visualization, preset.dataSource, preset.display)
}

const typedWhere = (model: Model, value: string): Model => {
	const queryId = model.state?.queries[0]?.id ?? expect.unreachable("the stand-in has query A")
	return update(
		model,
		Message.GotQueryPanelMessage({
			message: QueryPanel.Message.ChangedText({ queryId, field: "whereClause", value }),
		}),
		context,
	).model
}

const pickedType = (model: Model, panel: PanelType): Model =>
	update(model, Message.ClickedPanelType({ panel }), context).model

const groupedBy = (model: Model, field: string): Model => {
	const queryId = model.state?.queries[0]?.id ?? expect.unreachable("the editor has query A")
	return Arr.reduce(
		[
			QueryPanel.Message.ToggledAddOn({ queryId, key: "groupBy" }),
			QueryPanel.Message.GotGroupByMessage({
				queryId,
				message: Combobox.Message.ClickedItem({ value: field }),
			}),
		],
		model,
		(current, message) => update(current, Message.GotQueryPanelMessage({ message }), context).model,
	)
}

const mounted = (model: Model) =>
	[
		given(model),
		Mount.resolve(ResolveThemeColors, Message.ResolvedThemeColors({ colors: {} })),
		Mount.resolve(MeasurePreview, Message.MeasuredPreview({ widthPx: 800 })),
		Mount.resolve<string, Tabs.Message>(
			Tabs.MeasureTabIndicator,
			Tabs.Message.MeasuredIndicator({
				rect: { left: 0, right: 225, top: 4, bottom: 5, width: 112, height: 32 },
			}),
		),
	] as const

const savedSourceOf = (board: ReturnType<typeof opened>, model: Model) =>
	editedWidget(board.widget, model.state ?? expect.unreachable("the editor is ready"), null).dataSource

describe("preset widgets in the editor", () => {
	test("Total Traces with a filter saves a filtered trace count, not an error rate", () => {
		const board = openedPreset("stat-total-traces")
		const filtered = typedWhere(board.model, 'service.name = "api"')
		const saved = savedSourceOf(board, filtered)
		const query = dataSourceQuerySet(saved)?.queries[0]
		expect(query).toMatchObject({
			dataSource: "traces",
			aggregation: "count",
			whereClause: 'service.name = "api"',
		})
		expect(dataSourceTransform(saved)?.reduceToValue).toEqual({ field: "A", aggregate: "sum" })
	})

	test("an untouched Total Traces keeps its stored route", () => {
		const board = openedPreset("stat-total-traces")
		expect(savedSourceOf(board, board.model)).toEqual(board.widget.dataSource)
	})

	test("Total Logs and Root Errors read as their builder queries", () => {
		expect(openedPreset("stat-total-logs").model.state?.queries[0]).toMatchObject({
			dataSource: "logs",
			aggregation: "count",
		})
		const rootErrors = openedPreset("stat-root-total-errors").model.state
		expect(rootErrors?.queries[0]).toMatchObject({
			dataSource: "traces",
			aggregation: "count",
			whereClause: "root_only = true AND has_error = true",
		})
		expect(rootErrors?.statAggregate).toBe("sum")
	})

	test("Error Rate stays fixed: a mean of bucket rates is not errors over spans", () => {
		for (const id of ["stat-error-rate", "stat-root-error-rate"]) {
			const board = openedPreset(id)
			expect(board.model.state?.queryFixed).toBe(true)
			const edited = typedWhere(board.model, 'service.name = "api"')
			expect(savedSourceOf(board, edited)).toEqual(board.widget.dataSource)
		}
	})

	test("a service's P95 latency stat edits as p95 duration of that service", () => {
		const board = opened(
			"stat",
			makeRouteDataSource(
				"service_overview",
				{ service_name: "checkout" },
				{ reduceToValue: { field: "p95LatencyMs", aggregate: "avg" } },
			),
			{ title: "P95 Latency", unit: "duration_ms" },
		)
		const saved = savedSourceOf(board, typedWhere(board.model, 'service.name = "payments"'))
		expect(dataSourceQuerySet(saved)?.queries[0]).toMatchObject({
			dataSource: "traces",
			aggregation: "p95_duration",
			whereClause: 'service.name = "payments"',
		})
		expect(board.model.state?.queries[0]?.whereClause).toBe('service.name = "checkout"')
	})

	test("Active Services has no builder query: edits keep the stored route", () => {
		const board = openedPreset("stat-total-services")
		expect(board.model.state?.queryFixed).toBe(true)
		const edited = update(
			typedWhere(board.model, 'service.name = "api"'),
			Message.ChangedTitle({ value: "Services" }),
			context,
		).model
		expect(savedSourceOf(board, edited)).toEqual(board.widget.dataSource)
	})

	test("a SQL widget is not a preset: the Builder edits a query and the SQL tab keeps its SQL", () => {
		const sql =
			"SELECT toStartOfHour(Timestamp) AS bucket, count() AS value FROM traces WHERE OrgId = {orgId:String} GROUP BY bucket"
		const board = opened("stat", makeRawSqlDataSource({ sql }), { title: "Spans" })
		const tab = (model: Model, index: number) =>
			update(
				model,
				Message.GotSourceTabsMessage({ message: Tabs.Message.ClickedTab({ index }) }),
				context,
			).model
		const builder = tab(board.model, 0)
		expect(builder.state?.queryFixed).toBe(false)
		const filtered = typedWhere(builder, 'service.name = "api"')
		expect(dataSourceQuerySet(savedSourceOf(board, filtered))?.queries[0]).toMatchObject({
			whereClause: 'service.name = "api"',
		})
		expect(previewWidgetOf(tab(filtered, 1))?.dataSource).toMatchObject({ kind: "raw_sql", sql })
		scene(
			{ update: (model: Model, message: Message) => update(model, message, context), view },
			given(builder),
			Mount.resolve(ResolveThemeColors, Message.ResolvedThemeColors({ colors: {} })),
			Mount.resolve(MeasurePreview, Message.MeasuredPreview({ widthPx: 800 })),
			Mount.resolve<string, Tabs.Message>(
				Tabs.MeasureTabIndicator,
				Tabs.Message.MeasuredIndicator({
					rect: { left: 0, right: 225, top: 4, bottom: 5, width: 112, height: 32 },
				}),
			),
			// Resolved with the query panel's message: the page's submodel wraps it.
			Mount.resolve<string, QueryPanel.Message>(
				MountWhereFieldCaret,
				QueryPanel.Message.GotWhereField({
					message: WhereFieldMessage.GotCaret({
						fieldId:
							builder.state?.queries[0]?.id ?? expect.unreachable("the Builder has query A"),
						message: CaretMessage.BlurredEditor(),
					}),
				}),
			),
			expectView(text("+ Formula")).toExist(),
			expectView(text("This preset's query can't be edited")).not.toExist(),
		)
	})

	test("a fixed query says it can't be edited instead of showing query A", () => {
		scene(
			{ update: (model: Model, message: Message) => update(model, message, context), view },
			given(openedPreset("table-errors").model),
			Mount.resolve(ResolveThemeColors, Message.ResolvedThemeColors({ colors: {} })),
			Mount.resolve(MeasurePreview, Message.MeasuredPreview({ widthPx: 800 })),
			Mount.resolve<string, Tabs.Message>(
				Tabs.MeasureTabIndicator,
				Tabs.Message.MeasuredIndicator({
					rect: { left: 0, right: 225, top: 4, bottom: 5, width: 112, height: 32 },
				}),
			),
			expectView(text("This preset's query can't be edited")).toExist(),
		)
	})

	test("a fixed preset switched to a pie edits a builder query that saves once grouped", () => {
		const board = openedPreset("stat-total-services")
		const pie = pickedType(board.model, "pie")
		expect(pie.state?.queryFixed).toBe(false)
		expect(pie.state?.queries[0]?.aggregation).toBe("count")
		expect(canApply(pie)).toBe(false)
		const grouped = groupedBy(pie, "service.name")
		expect(canApply(grouped)).toBe(true)
		const saved = savedSourceOf(board, grouped)
		expect(dataSourceQuerySet(saved)?.queries[0]).toMatchObject({ aggregation: "count" })
		expect(saved).not.toEqual(board.widget.dataSource)
		scene(
			{ update: (model: Model, message: Message) => update(model, message, context), view },
			...mounted(pie),
			Mount.resolve<string, QueryPanel.Message>(
				MountWhereFieldCaret,
				QueryPanel.Message.GotWhereField({
					message: WhereFieldMessage.GotCaret({
						fieldId: pie.state?.queries[0]?.id ?? expect.unreachable("the pie has query A"),
						message: CaretMessage.BlurredEditor(),
					}),
				}),
			),
			expectView(
				text("This visualization groups data into categories. Add a group-by field"),
			).toExist(),
			expectView(text("+ Query")).toExist(),
			expectView(text("This preset's query can't be edited")).not.toExist(),
		)
	})

	test("a fixed preset switched to a list saves the list's own source", () => {
		const board = openedPreset("stat-total-services")
		const list = pickedType(board.model, "list")
		const state = list.state ?? expect.unreachable("the editor is ready")
		expect(canApply(list)).toBe(true)
		expect(savedSourceOf(board, list)).toEqual(listDataSourceOf(state))
	})

	test("a fixed preset stays fixed as a table, and back from a pie or a previewed list untouched", () => {
		const board = openedPreset("stat-total-services")
		const table = pickedType(board.model, "table")
		expect(table.state?.queryFixed).toBe(true)
		expect(dataSourceTransform(savedSourceOf(board, table))?.reduceToValue).toBeUndefined()
		expect(pickedType(pickedType(board.model, "pie"), "stat").state?.queryFixed).toBe(true)
		// Previewed as a list (its own source), then back: the preview reads the stored route again.
		const previewed = update(pickedType(board.model, "list"), Message.ClickedRunPreview(), context).model
		const back = pickedType(previewed, "stat")
		expect(back.state?.queryFixed).toBe(true)
		expect(savedSourceOf(board, back)).toEqual(board.widget.dataSource)
		expect(previewWidgetOf(back)?.dataSource).toEqual(board.widget.dataSource)
		scene(
			{ update: (model: Model, message: Message) => update(model, message, context), view },
			...mounted(back),
			expectView(text("This preset's query can't be edited")).toExist(),
		)
	})

	test("a fixed preset grouped as a pie stays a builder query back as a stat", () => {
		const board = openedPreset("stat-total-services")
		const back = pickedType(groupedBy(pickedType(board.model, "pie"), "service.name"), "stat")
		expect(back.state?.queryFixed).toBe(false)
		expect(dataSourceQuerySet(savedSourceOf(board, back))?.queries[0]).toMatchObject({
			aggregation: "count",
		})
	})
})
