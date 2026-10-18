import { DashboardDocument } from "@maple/domain/http"
import { OrgId } from "@maple/domain"
import { Effect, Option, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { PageContext } from "../../../page/contract"
import { canvasGridOf } from "../../../page/dashboards/view/grid"
import { Message } from "../../../page/dashboards/view/message"
import { Model } from "../../../page/dashboards/view/model"
import { pointerEvents } from "../../../page/dashboards/view/subscription"
import { init as pageInit, update as pageUpdate } from "../../../page/dashboards/view/update"
import { dashboardSections } from "../../../page/dashboards/view/view-grid"
import type { Resources } from "../../../platform/resources"
import { defineLabWithFlags } from "../../define"

/**
 * `/lab/bench/dashboard-grid` (apps/web's `DashboardGridBench`): the dashboard grid in edit mode
 * over a `?n=`-widget board (default 50), each tile ~150 elements standing in for a chart. Writes
 * stay local: a layout commit moves the board here instead of reaching the API.
 */

type Widget = DashboardDocument["widgets"][number]
type Layout = Widget["layout"]

const CONTEXT: PageContext = { orgId: OrgId.make("lab"), pinnedNamespace: null, timeZone: "UTC" }
const DASHBOARD_ID = "bench"

/** `buildBoard`: rows of stats, pairs of charts, a wide table, as real boards are shaped. */
const buildBoard = (count: number): ReadonlyArray<{ id: string; title: string; layout: Layout }> => {
	const band = (y: number) => Math.floor(y / 15) % 3
	const step = (
		widgets: ReadonlyArray<{ id: string; title: string; layout: Layout }>,
		y: number,
	): ReadonlyArray<{ id: string; title: string; layout: Layout }> => {
		if (widgets.length >= count) return widgets
		const row = (kind: "stat" | "chart", label: string, xs: ReadonlyArray<number>, w: number, h: number) =>
			xs.slice(0, count - widgets.length).map((x, index) => ({
				id: `${kind}-${widgets.length + index}`,
				title: `${label} ${widgets.length + index}`,
				layout: { x, y, w, h },
			}))
		if (band(y) === 0) return step([...widgets, ...row("stat", "Stat", [0, 3, 6, 9], 3, 2)], y + 2)
		if (band(y) === 1) return step([...widgets, ...row("chart", "Chart", [0, 6], 6, 6)], y + 6)
		return step(
			[...widgets, { id: `table-${widgets.length}`, title: `Table ${widgets.length}`, layout: { x: 0, y, w: 12, h: 5 } }],
			y + 5,
		)
	}
	return step([], 0)
}

const boardOf = (count: number) =>
	Schema.decodeUnknownSync(DashboardDocument)({
		id: DASHBOARD_ID,
		name: "Dashboard grid bench",
		timeRange: { type: "relative", value: "6h" },
		// Notes: static tiles, so nothing is fetched; the bench draws its own tile in each cell.
		widgets: buildBoard(count).map((widget) => ({
			id: widget.id,
			visualization: "markdown",
			dataSource: { kind: "static" },
			display: { title: widget.title, markdown: { content: "" } },
			layout: widget.layout,
		})),
		createdAt: "2026-10-01T00:00:00.000Z",
		updatedAt: "2026-10-01T00:00:00.000Z",
		schemaVersion: 3,
	})

const LayoutWrite = Schema.Struct({
	layouts: Schema.Array(Schema.Struct({ i: Schema.String, x: Schema.Number, y: Schema.Number, w: Schema.Number, h: Schema.Number })),
})
const decodeLayoutWrite = Schema.decodeUnknownOption(LayoutWrite)

/** `onLayoutCommit`: the moved boxes applied to the board; an unchanged widget keeps its object. */
const withLayouts = (model: Model, layouts: typeof LayoutWrite.Type["layouts"]): Model => {
	if (model.document === null) return model
	const byId = new Map(layouts.map((layout) => [layout.i, layout]))
	const widgets = model.document.widgets.map((widget) => {
		const box = byId.get(widget.id)
		return box === undefined ? widget : { ...widget, layout: { ...widget.layout, x: box.x, y: box.y, w: box.w, h: box.h } }
	})
	return { ...model, document: { ...model.document, widgets } }
}

/** The board's own work runs; its writes and API reads stay here. */
const LOCAL_ONLY = new Set(["UpdateDashboardWidgetLayouts", "FetchDashboardShares", "FetchDashboardWidget"])

const update = (model: Model, message: Message) => {
	const next = pageUpdate(model, message, CONTEXT)
	const commands = next.commands ?? []
	const written = commands
		.filter((command) => command.name === "UpdateDashboardWidgetLayouts")
		.flatMap((command) => Option.toArray(decodeLayoutWrite(command.args)))
	return {
		model: written.reduce((acc, write) => withLayouts(acc, write.layouts), next.model),
		commands: commands.filter((command) => !LOCAL_ONLY.has(command.name)),
	}
}

const Flags = Schema.Struct({ count: Schema.Number })

const init = (flags: typeof Flags.Type) => {
	const started = pageInit({ dashboardId: DASHBOARD_ID, search: { mode: "edit" } }, CONTEXT)
	const loaded = update(started.model, Message.UpdatedDashboard({ orgId: CONTEXT.orgId, maybeDocument: Option.some(boardOf(flags.count)) }))
	return { model: loaded.model, commands: [...(started.commands ?? []), ...loaded.commands] }
}

const BARS = Array.from({ length: 140 }, (_, index) => index)

/** `BenchTile`: a header with the drag grip and ~140 bars in place of a chart. */
const benchTile = (h: HtmlBuilder<Message>, widget: Widget): Html => {
	const title = widget.display.title ?? widget.id
	return h.div(
		[h.DataAttribute("bench-tile", widget.id), h.Class("flex h-full flex-col overflow-hidden rounded-lg border bg-card")],
		[
			h.div(
				[h.Class("flex items-center gap-2 px-3 py-2 text-xs")],
				[
					h.button(
						[
							h.Type("button"),
							h.Class("widget-drag-handle cursor-grab touch-none text-muted-foreground"),
							h.DataAttribute("grid-label", title),
							h.AriaLabel(`Move ${title}`),
						],
						["::"],
					),
					h.span([h.Class("truncate")], [title]),
				],
			),
			h.div(
				[h.Class("flex min-h-0 flex-1 items-end gap-px px-3 pb-2")],
				BARS.map((bar) =>
					h.span([
						h.Class("flex-1 bg-primary/40"),
						h.Style({ height: `${20 + ((bar * 37 + widget.id.length * 11) % 80)}%` }),
					]),
				),
			),
		],
	)
}

const view = (model: Model, h: HtmlBuilder<Message>): Html => {
	const document = model.document
	const cols = canvasGridOf(model)?.tier.cols ?? 12
	return h.div(
		[h.Class("p-6")],
		[
			h.p([h.Class("mb-3 text-xs text-muted-foreground")], [`${document?.widgets.length ?? 0} widgets · ${cols} columns`]),
			h.div(
				[h.DataAttribute("bench-board", "")],
				document === null
					? []
					: [
							dashboardSections(
								h,
								{ model, timeZone: CONTEXT.timeZone, variables: {}, renderTile: (widget) => benchTile(h, widget) },
								document,
							),
						],
			),
		],
	)
}

const subscriptions = Subscription.make<Model, Message, Resources>()((entry) => ({
	gesturePointer: entry(
		{ widgetId: Schema.NullOr(Schema.String) },
		{
			modelToDependencies: (model) => ({ widgetId: model.gesture?.widgetId ?? null }),
			dependenciesToStream: ({ widgetId }) => (widgetId === null ? Stream.empty : pointerEvents(widgetId)),
		},
	),
}))

export const lab = defineLabWithFlags("Dashboard grid bench", {
	Model,
	Flags,
	flags: Effect.sync(() => ({ count: Number(new URLSearchParams(window.location.search).get("n") ?? "50") || 50 })),
	init,
	update,
	view,
	subscriptions,
})
