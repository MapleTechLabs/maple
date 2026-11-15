import { OrgId } from "@maple/domain"
import { DashboardDocument, DashboardWidgetSchema } from "@maple/domain/http"
import { ResolveThemeColors } from "@maple/views/charts/theme-colors"
import * as Tabs from "@maple/views/ui/tabs"
import { Option, Result, Schema, Array as Arr } from "effect"
import {
	Command as SceneCommand,
	expect as expectView,
	given,
	Mount,
	scene,
	text,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import { FetchWidget, MeasurePreview, SaveWidget } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { update } from "./page-update"
import { init, isDirty, previewWidgetOf } from "./update"
import { view as pageView } from "./view"

// The editor over a PromQL line chart: the tab it opens on, the preview it asks for, the
// parser's message under the query, and what Apply writes.

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()

const QUERY = 'sum by (job) (rate(http_requests_total{env=~"$env"}[$__rate_interval]))'

const requestRate = {
	id: "rate",
	visualization: "chart",
	dataSource: { kind: "promql", query: QUERY, legendFormat: "{{job}}", displayType: "line" },
	display: { title: "Request rate", chartId: "query-builder-line" },
	layout: { x: 0, y: 0, w: 6, h: 4 },
}

const document = Schema.decodeUnknownSync(DashboardDocument)({
	id: "dash_promql",
	name: "Prometheus",
	timeRange: { type: "relative", value: "1h" },
	widgets: [requestRate],
	variables: [
		{
			name: "env",
			type: "custom",
			options: [{ value: "prod" }, { value: "staging" }],
			defaultValue: "prod",
		},
	],
	createdAt: "2026-09-19T12:00:00.000Z",
	updatedAt: "2026-09-28T12:00:00.000Z",
	schemaVersion: 3,
})

type Step = { readonly model: Model; readonly commands: ReadonlyArray<{ name: string; args?: unknown }> }

const runAll = (model: Model, messages: ReadonlyArray<Message>): Step => {
	const start: Step = { model, commands: [] }
	return Arr.reduce(messages, start, (step, message) => {
		const next = pageUpdate(step.model, message)
		return { model: next.model, commands: [...step.commands, ...(next.commands ?? [])] }
	})
}

const opened = () =>
	runAll(init({ dashboardId: "dash_promql", widgetId: "rate", search: {} }, context).model, [
		Message.CompletedReadClock({ nowMs: Date.parse("2026-10-01T12:00:00Z") }),
		Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(document) }),
	])

const FetchArgs = Schema.Struct({
	key: Schema.String,
	endpoint: Schema.String,
	params: Schema.Record(Schema.String, Schema.Unknown),
})
const fetchesOf = (step: Step) =>
	Arr.flatMap(step.commands, ({ name, args }) =>
		name === FetchWidget.name ? Option.toArray(Schema.decodeUnknownOption(FetchArgs)(args)) : [],
	)

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

const decodeSave = Schema.decodeUnknownOption(Schema.Struct({ widget: DashboardWidgetSchema }))

describe("widget editor over a PromQL widget", () => {
	test("opens on the PromQL tab and previews the query with the variable filled", () => {
		const step = opened()
		expect(step.model.sourceMode).toBe("promql")
		expect(isDirty(step.model)).toBe(false)
		const [fetch] = fetchesOf(step)
		expect(fetch?.endpoint).toBe("promql_chart")
		expect(fetch?.params).toMatchObject({
			promql: 'sum by (job) (rate(http_requests_total{env=~"prod"}[$__rate_interval]))',
			legendFormat: "{{job}}",
			displayType: "line",
		})
	})

	test("renders the query, legend and min step fields", () => {
		scene(
			{ update: pageUpdate, view },
			...mounted(opened().model),
			expectView(text("PromQL query")).toExist(),
			expectView(text("Legend")).toExist(),
			expectView(text("Min step (s)")).toExist(),
			expectView(text("Run preview")).toExist(),
		)
	})

	test("shows the parser's message under the query when the preview refuses it", () => {
		const step = opened()
		const key = fetchesOf(step)[0]?.key ?? expect.unreachable("the preview fetched")
		const refused = Message.CompletedFetchWidget({
			key,
			result: Result.fail({
				title: null,
				message: "Invalid PromQL: unexpected end of input",
				kind: "decode",
			}),
		})
		// A failed preview is asked again on the next plan, and refused again.
		scene(
			{ update: pageUpdate, view },
			...mounted(pageUpdate(step.model, refused).model),
			SceneCommand.resolve(FetchWidget, refused),
			expectView(text("Invalid PromQL: unexpected end of input")).toExist(),
		)
	})

	test("an edit waits for Run preview, and Apply writes the promql source", () => {
		const edited = runAll(opened().model, [
			Message.ChangedPromql({ value: "up" }),
			Message.ChangedPromqlLegend({ value: "{{instance}}" }),
			Message.ChangedPromqlMinStep({ value: "60" }),
		])
		expect(fetchesOf(edited)).toEqual([])
		expect(isDirty(edited.model)).toBe(true)
		const previewed = runAll(edited.model, [Message.ClickedRunPreview()])
		expect(fetchesOf(previewed)[0]?.params).toMatchObject({ promql: "up", minStepSeconds: 60 })
		const saved = pageUpdate(previewed.model, Message.ClickedApply()).commands ?? []
		const save = Arr.findFirst(saved, ({ name }) => name === SaveWidget.name)
		const widget = Option.getOrNull(Option.flatMap(save, ({ args }) => decodeSave(args)))?.widget
		expect(widget?.dataSource).toEqual({
			kind: "promql",
			query: "up",
			legendFormat: "{{instance}}",
			minStepSeconds: 60,
			displayType: "line",
		})
	})

	test("a table's Row limit is saved on Apply and read back when the widget reopens", () => {
		const tableWidget = {
			id: "jobs",
			visualization: "table",
			dataSource: { kind: "promql", query: "up", displayType: "table", transform: { limit: 50 } },
			display: { title: "Jobs" },
			layout: { x: 0, y: 0, w: 6, h: 4 },
		}
		const openWith = (widget: unknown) =>
			runAll(init({ dashboardId: "dash_promql", widgetId: "jobs", search: {} }, context).model, [
				Message.CompletedReadClock({ nowMs: Date.parse("2026-10-01T12:00:00Z") }),
				Message.UpdatedDashboard({
					orgId,
					maybeDocument: Option.some(
						Schema.decodeUnknownSync(DashboardDocument)({ ...document, widgets: [widget] }),
					),
				}),
			])
		const opened = openWith(tableWidget)
		expect(opened.model.state?.tableLimit).toBe("50")
		const edited = runAll(opened.model, [Message.ChangedTableLimit({ value: "10" })])
		const saved = pageUpdate(edited.model, Message.ClickedApply()).commands ?? []
		const save = Arr.findFirst(saved, ({ name }) => name === SaveWidget.name)
		const widget = Option.getOrNull(Option.flatMap(save, ({ args }) => decodeSave(args)))?.widget
		expect(widget?.dataSource).toMatchObject({ kind: "promql", transform: { limit: 10 } })
		expect(openWith(widget).model.state?.tableLimit).toBe("10")
	})

	test("an empty query blocks Run preview and Apply", () => {
		const empty = pageUpdate(opened().model, Message.ChangedPromql({ value: "  " })).model
		expect(pageUpdate(empty, Message.ClickedRunPreview()).commands ?? []).toEqual([])
		expect(pageUpdate(empty, Message.ClickedApply()).commands ?? []).toEqual([])
	})

	test("the Builder tab previews a query set again", () => {
		const builder = pageUpdate(
			opened().model,
			Message.GotSourceTabsMessage({ message: Tabs.Message.ClickedTab({ index: 0 }) }),
		).model
		expect(previewWidgetOf(builder)?.dataSource).not.toMatchObject({ kind: "promql" })
		expect(isDirty(builder)).toBe(true)
	})
})
