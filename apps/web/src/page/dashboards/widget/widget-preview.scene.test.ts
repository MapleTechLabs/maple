import { OrgId } from "@maple/domain"
import { DashboardDocument, DashboardWidgetSchema } from "@maple/domain/http"
import { Option, Schema, Array as Arr } from "effect"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import { SaveWidget } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { update } from "./page-update"
import { init, previewWidgetOf } from "./update"

// The editor over a fixed-endpoint stat: what the preview shows and what Apply writes.

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }

const totalTraces = {
	id: "total",
	visualization: "stat",
	dataSource: {
		kind: "route",
		endpoint: "service_usage",
		transform: { reduceToValue: { field: "totalTraces", aggregate: "sum" } },
	},
	display: { title: "Total Traces", unit: "number" },
	layout: { x: 0, y: 0, w: 3, h: 2 },
}

const document = Schema.decodeUnknownSync(DashboardDocument)({
	id: "dash_presets",
	name: "Presets",
	timeRange: { type: "relative", value: "6h" },
	widgets: [totalTraces],
	createdAt: "2026-09-19T12:00:00.000Z",
	updatedAt: "2026-09-28T12:00:00.000Z",
	schemaVersion: 3,
})

const run = (model: Model, messages: ReadonlyArray<Message>) =>
	Arr.reduce(messages, model, (current, message) => update(current, message, context).model)

const opened = () =>
	run(init({ dashboardId: "dash_presets", widgetId: "total", search: {} }, context).model, [
		Message.CompletedReadClock({ nowMs: Date.parse("2026-10-01T12:00:00Z") }),
		Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(document) }),
	])

const decodeSave = Schema.decodeUnknownOption(Schema.Struct({ widget: DashboardWidgetSchema }))

/** The widget Apply's write carries. */
const savedWidget = (model: Model) => {
	const commands: ReadonlyArray<{ readonly name: string; readonly args?: unknown }> =
		update(model, Message.ClickedApply(), context).commands ?? []
	const saved = Arr.findFirst(commands, ({ name }) => name === SaveWidget.name)
	return Option.getOrNull(
		Option.map(
			Option.flatMap(saved, ({ args }) => decodeSave(args)),
			({ widget }) => widget,
		),
	)
}

describe("widget editor over a fixed-endpoint widget", () => {
	test("a title-only edit previews and saves the stored endpoint, not the stand-in query", () => {
		const retitled = run(opened(), [Message.ChangedTitle({ value: "All traces" })])
		expect(previewWidgetOf(retitled)?.dataSource).toEqual(totalTraces.dataSource)
		const widget = savedWidget(retitled)
		expect(widget?.dataSource).toEqual(totalTraces.dataSource)
		expect(widget?.display.title).toBe("All traces")
	})

	test("display-only edits reach the preview without Run preview", () => {
		const edited = run(opened(), [
			Message.ChangedTitle({ value: "Traces" }),
			Message.ChangedUnit({ unit: "percent" }),
			Message.ClickedAddThreshold(),
			Message.ToggledSparkline(),
		])
		const display = previewWidgetOf(edited)?.display
		expect(display?.title).toBe("Traces")
		expect(display?.unit).toBe("percent")
		expect(display?.thresholds).toHaveLength(1)
		expect(display?.sparkline?.enabled).toBe(true)
	})
})
