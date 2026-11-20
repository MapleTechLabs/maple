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
import { FetchPromqlDiscovery, FocusPromqlCaret } from "./promql-step"
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

	test("a parse error shows under the query after the typing pause and blocks Run preview", () => {
		const typed = runAll(opened().model, [Message.ChangedPromql({ value: "sum(rate(up[5m])) +* 2" })])
		expect(typed.model.promql?.parseError).toBeNull()
		const seq = typed.model.promql?.parseSeq ?? 0
		// A delay from an older keystroke parses nothing.
		expect(
			pageUpdate(typed.model, Message.ElapsedPromqlParseDelay({ seq: seq - 1 })).model.promql
				?.parseError,
		).toBeNull()
		const parsed = pageUpdate(typed.model, Message.ElapsedPromqlParseDelay({ seq })).model
		expect(parsed.promql?.parseError).toMatchObject({ from: 19 })
		expect(pageUpdate(parsed, Message.ClickedRunPreview()).commands ?? []).toEqual([])
		expect(pageUpdate(parsed, Message.ClickedApply()).commands ?? []).toEqual([])
		scene(
			{ update: pageUpdate, view },
			...mounted(parsed),
			expectView(text('Line 1, column 20: syntax error near "*"')).toExist(),
		)
	})

	test("typing a metric name lists the org's metrics, and Enter writes the highlighted one", () => {
		const typed = runAll(opened().model, [
			Message.ChangedPromql({ value: "http_" }),
			Message.GotPromqlCaret({ caret: 5, opens: true }),
		])
		const asked = Arr.filter(typed.commands, ({ name }) => name === FetchPromqlDiscovery.name)
		expect(Arr.map(asked, ({ args }) => args)).toEqual([{ key: "__name__|", label: "__name__" }])
		const listed = runAll(typed.model, [
			Message.CompletedFetchPromqlDiscovery({
				key: "__name__|",
				result: Result.succeed(["http_requests_total", "process_cpu_seconds_total"]),
			}),
			// The same context asks for nothing new.
			Message.GotPromqlCaret({ caret: 5, opens: true }),
		])
		expect(Arr.filter(listed.commands, ({ name }) => name === FetchPromqlDiscovery.name)).toEqual([])
		scene(
			{ update: pageUpdate, view },
			...mounted(listed.model),
			expectView(text("http_requests_total")).toExist(),
			expectView(text("process_cpu_seconds_total")).not.toExist(),
		)
		const picked = pageUpdate(listed.model, Message.PressedPromqlKey({ key: "Enter" }))
		expect(picked.model.promql?.draft.query).toBe("http_requests_total")
		expect(picked.model.promql?.completion).toBeNull()
		expect(Arr.map(picked.commands ?? [], ({ name }) => name)).toContain(FocusPromqlCaret.name)
	})

	test("an open suggestion list hides the half-typed query's parse error, which still blocks Apply", () => {
		const typed = runAll(opened().model, [
			Message.ChangedPromql({ value: "rate(http_" }),
			Message.GotPromqlCaret({ caret: 10, opens: true }),
			Message.CompletedFetchPromqlDiscovery({
				key: "__name__|",
				result: Result.succeed(["http_requests_total"]),
			}),
		])
		const seq = typed.model.promql?.parseSeq ?? 0
		const parsed = pageUpdate(typed.model, Message.ElapsedPromqlParseDelay({ seq })).model
		expect(parsed.promql?.parseError).not.toBeNull()
		expect(pageUpdate(parsed, Message.ClickedApply()).commands ?? []).toEqual([])
		scene(
			{ update: pageUpdate, view },
			...mounted(parsed),
			expectView(text("http_requests_total")).toExist(),
			expectView(text(/unexpected end of input/)).not.toExist(),
		)
		const closed = pageUpdate(parsed, Message.PressedPromqlKey({ key: "Escape" })).model
		scene(
			{ update: pageUpdate, view },
			...mounted(closed),
			expectView(text(/unexpected end of input/)).toExist(),
		)
	})

	test("inside a matcher's quotes it asks for that label's values on that metric", () => {
		const typed = runAll(opened().model, [
			Message.ChangedPromql({ value: 'up{job="' }),
			Message.GotPromqlCaret({ caret: 8, opens: true }),
		])
		const asked = Arr.filter(typed.commands, ({ name }) => name === FetchPromqlDiscovery.name)
		expect(asked[0]?.args).toEqual({ key: 'job|{__name__="up"}', label: "job", match: '{__name__="up"}' })
		const listed = pageUpdate(
			typed.model,
			Message.CompletedFetchPromqlDiscovery({
				key: 'job|{__name__="up"}',
				result: Result.succeed(["api", "worker"]),
			}),
		).model
		const down = pageUpdate(listed, Message.PressedPromqlKey({ key: "ArrowDown" })).model
		const picked = pageUpdate(down, Message.PressedPromqlKey({ key: "Tab" })).model
		expect(picked.promql?.draft.query).toBe('up{job="worker')
		expect(
			pageUpdate(listed, Message.PressedPromqlKey({ key: "Escape" })).model.promql?.completion,
		).toBeNull()
	})

	test("a pick mid-word replaces the rest of the word, not just what precedes the caret", () => {
		const typed = runAll(opened().model, [
			Message.ChangedPromql({ value: "rate(http_requests_total[5m])" }),
			Message.GotPromqlCaret({ caret: 10, opens: true }),
			Message.CompletedFetchPromqlDiscovery({
				key: "__name__|",
				result: Result.succeed(["http_requests_total", "http_server_errors_total"]),
			}),
			Message.PressedPromqlKey({ key: "ArrowDown" }),
			Message.PressedPromqlKey({ key: "Enter" }),
		])
		expect(typed.model.promql?.draft.query).toBe("rate(http_server_errors_total[5m])")
	})

	test("a pick stops at a quoted value's unescaped quote and at a subquery's step", () => {
		const value = runAll(opened().model, [
			Message.ChangedPromql({ value: 'up{job="ap\\"old"}' }),
			Message.GotPromqlCaret({ caret: 10, opens: true }),
			Message.CompletedFetchPromqlDiscovery({
				key: 'job|{__name__="up"}',
				result: Result.succeed(["api"]),
			}),
			Message.PressedPromqlKey({ key: "Enter" }),
		])
		expect(value.model.promql?.draft.query).toBe('up{job="api"}')
		const duration = runAll(opened().model, [
			Message.ChangedPromql({ value: "max_over_time(up[5m:1m])" }),
			Message.GotPromqlCaret({ caret: 17, opens: true }),
			Message.PressedPromqlKey({ key: "ArrowDown" }),
			Message.PressedPromqlKey({ key: "Enter" }),
		])
		expect(duration.model.promql?.draft.query).toBe("max_over_time(up[$__interval:1m])")
	})

	test("with a full page of metrics, the typed prefix is asked only once typing pauses", () => {
		const fetches = (step: Step) =>
			Arr.map(
				Arr.filter(step.commands, ({ name }) => name === FetchPromqlDiscovery.name),
				({ args }) => args,
			)
		const typed = runAll(opened().model, [
			Message.ChangedPromql({ value: "zeb" }),
			Message.GotPromqlCaret({ caret: 3, opens: true }),
			Message.CompletedFetchPromqlDiscovery({
				key: "__name__|",
				result: Result.succeed(Arr.makeBy(500, (i) => `metric_${i}`)),
			}),
			Message.ChangedPromql({ value: "zebr" }),
			Message.GotPromqlCaret({ caret: 4, opens: true }),
		])
		expect(fetches(typed)).toEqual([{ key: "__name__|", label: "__name__" }])
		const seq = typed.model.promql?.parseSeq ?? 0
		const paused = runAll(typed.model, [Message.ElapsedPromqlParseDelay({ seq })])
		expect(fetches(paused)).toEqual([
			{ key: '__name__|{__name__=~"zebr.*"}', label: "__name__", match: '{__name__=~"zebr.*"}' },
		])
	})

	test("a page of metrics that lands after typing paused still asks for the typed prefix", () => {
		const typed = runAll(opened().model, [
			Message.ChangedPromql({ value: "zebr" }),
			Message.GotPromqlCaret({ caret: 4, opens: true }),
		])
		const seq = typed.model.promql?.parseSeq ?? 0
		const landed = runAll(typed.model, [
			Message.ElapsedPromqlParseDelay({ seq }),
			Message.CompletedFetchPromqlDiscovery({
				key: "__name__|",
				result: Result.succeed(Arr.makeBy(500, (i) => `metric_${i}`)),
			}),
		])
		const asked = Arr.filter(landed.commands, ({ name }) => name === FetchPromqlDiscovery.name)
		expect(Arr.map(asked, ({ args }) => args)).toEqual([
			{ key: '__name__|{__name__=~"zebr.*"}', label: "__name__", match: '{__name__=~"zebr.*"}' },
		])
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
