import { DashboardDocument } from "@maple/domain/http"
import { OrgId } from "@maple/domain"
import { Effect, Option, Queue, Schema, Stream } from "effect"
import { Command, Mount, Submodel, Subscription } from "foldkit"
import { createKeyedLazy, type Html, type HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import {
	installDashboardGridBench,
	LAST_COMMIT_SIZE_ATTRIBUTE,
	LAYOUT_COMMITS_ATTRIBUTE,
	TILE_RENDER_MARK,
} from "../../bench/dashboard-grid-harness"
import type { PageContext } from "../../../page/contract"
import { canvasGridOf } from "../../../page/dashboards/view/grid"
import { Message } from "../../../page/dashboards/view/message"
import { Model } from "../../../page/dashboards/view/model"
import { pointerEvents } from "../../../page/dashboards/view/subscription"
import { init as pageInit, update as pageUpdate } from "../../../page/dashboards/view/update"
import { dashboardSections } from "../../../page/dashboards/view/view-grid"
import type { Resources } from "../../../platform/resources"
import { icon } from "../../../ui/icon"
import { defineLabWithFlags } from "../../define"

/**
 * `/lab/bench/dashboard-grid`: the dashboard grid in edit mode
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
		const row = (
			kind: "stat" | "chart",
			label: string,
			xs: ReadonlyArray<number>,
			w: number,
			h: number,
		) =>
			xs.slice(0, count - widgets.length).map((x, index) => ({
				id: `${kind}-${widgets.length + index}`,
				title: `${label} ${widgets.length + index}`,
				layout: { x, y, w, h },
			}))
		if (band(y) === 0) return step([...widgets, ...row("stat", "Stat", [0, 3, 6, 9], 3, 2)], y + 2)
		if (band(y) === 1) return step([...widgets, ...row("chart", "Chart", [0, 6], 6, 6)], y + 6)
		return step(
			[
				...widgets,
				{
					id: `table-${widgets.length}`,
					title: `Table ${widgets.length}`,
					layout: { x: 0, y, w: 12, h: 5 },
				},
			],
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
	layouts: Schema.Array(
		Schema.Struct({
			i: Schema.String,
			x: Schema.Number,
			y: Schema.Number,
			w: Schema.Number,
			h: Schema.Number,
		}),
	),
})
const decodeLayoutWrite = Schema.decodeUnknownOption(LayoutWrite)

const BenchModel = Schema.Struct({
	board: Model,
	/** `mountKey`: bumped by `measureMount`, so the board remounts. */
	mountKey: Schema.Number,
	layoutCommits: Schema.Number,
	lastCommitSize: Schema.Number,
})
type BenchModel = typeof BenchModel.Type

const BenchMessage = defineMessageUnion({
	GotBoardMessage: { message: Message },
	RequestedRemount: {},
})
type BenchMessage = typeof BenchMessage.Type

type Box = (typeof LayoutWrite.Type)["layouts"][number]
const isMoved = (layout: Layout, box: Box) =>
	box.x !== layout.x || box.y !== layout.y || box.w !== layout.w || box.h !== layout.h

/** `onLayoutCommit`: the moved boxes applied to the board; an unchanged widget keeps its object. */
const withLayouts = (model: BenchModel, layouts: ReadonlyArray<Box>): BenchModel => {
	const document = model.board.document
	if (document === null) return model
	const byId = new Map(layouts.map((layout) => [layout.i, layout]))
	const moved = document.widgets.filter((widget) => {
		const box = byId.get(widget.id)
		return box !== undefined && isMoved(widget.layout, box)
	})
	const widgets = document.widgets.map((widget) => {
		const box = byId.get(widget.id)
		return box === undefined || !isMoved(widget.layout, box)
			? widget
			: { ...widget, layout: { ...widget.layout, x: box.x, y: box.y, w: box.w, h: box.h } }
	})
	return {
		...model,
		board: { ...model.board, document: { ...document, widgets } },
		layoutCommits: model.layoutCommits + 1,
		lastCommitSize: moved.length,
	}
}

/** The board's own work runs; its writes and API reads stay here. */
const LOCAL_ONLY = new Set(["UpdateDashboardWidgetLayouts", "FetchDashboardShares", "FetchDashboardWidget"])
const toBoard = (message: Message): BenchMessage => BenchMessage.GotBoardMessage({ message })

const boardStep = (model: BenchModel, message: Message) => {
	const next = pageUpdate(model.board, message, CONTEXT)
	const commands = next.commands ?? []
	const written = commands
		.filter((command) => command.name === "UpdateDashboardWidgetLayouts")
		.flatMap((command) => Option.toArray(decodeLayoutWrite(command.args)))
	return {
		model: written.reduce((acc, write) => withLayouts(acc, write.layouts), {
			...model,
			board: next.model,
		}),
		commands: Command.mapMessages(
			commands.filter((command) => !LOCAL_ONLY.has(command.name)),
			toBoard,
		),
	}
}

const update = (model: BenchModel, message: BenchMessage) =>
	BenchMessage.match(message, {
		GotBoardMessage: ({ message: inner }) => boardStep(model, inner),
		RequestedRemount: () => ({ model: { ...model, mountKey: model.mountKey + 1 }, commands: [] }),
	})

const Flags = Schema.Struct({ count: Schema.Number })

const init = (flags: typeof Flags.Type) => {
	const started = pageInit({ dashboardId: DASHBOARD_ID, search: { mode: "edit" } }, CONTEXT)
	const empty: BenchModel = { board: started.model, mountKey: 0, layoutCommits: 0, lastCommitSize: 0 }
	const loaded = boardStep(
		empty,
		Message.UpdatedDashboard({ orgId: CONTEXT.orgId, maybeDocument: Option.some(boardOf(flags.count)) }),
	)
	return {
		model: loaded.model,
		commands: [...Command.mapMessages(started.commands ?? [], toBoard), ...loaded.commands],
	}
}

const BARS = Array.from({ length: 140 }, (_, index) => index)

/** `memo(BenchTile)`: one slot per tile and mount; a widget that kept its object skips. */
const lazyTile = createKeyedLazy()

/** `BenchTile`: a header with the drag grip and ~140 bars in place of a chart. */
const benchTile = (h: HtmlBuilder<Message>, widget: Widget): Html => {
	// The bench's render counter, read by the harness.
	performance.mark(TILE_RENDER_MARK)
	const title = widget.display.title ?? widget.id
	return h.div(
		[
			h.DataAttribute("bench-tile", widget.id),
			h.Class("group/tile flex h-full flex-col overflow-hidden rounded-lg border bg-card"),
		],
		[
			h.div(
				[h.Class("flex items-center gap-2 px-3 py-2 text-xs")],
				[
					h.button(
						[
							h.Type("button"),
							// The real tile's grip, muted until the tile is hovered.
							h.Class(
								"widget-drag-handle cursor-grab touch-none rounded-sm text-muted-foreground opacity-50 transition-opacity group-hover/tile:opacity-100 hover:text-foreground active:cursor-grabbing",
							),
							h.DataAttribute("grid-label", title),
							h.AriaLabel(`Move ${title}`),
						],
						[icon(h, "GripDotsIcon", { size: 14 })],
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

/** The board, remounted with its key: `<DashboardGrid key={mountKey}>`. */
const boardView = Submodel.defineView<Model, Message, { mountKey: number }>((model, inputs, h) =>
	model.document === null
		? h.div([], [])
		: dashboardSections(
				h,
				{
					model,
					timeZone: CONTEXT.timeZone,
					variables: {},
					renderTile: (widget) =>
						lazyTile(`${inputs.mountKey}:${widget.id}`, benchTile, [h, widget]) ?? h.div([], []),
				},
				model.document,
			),
)

/** `window.__dashboardGridBench` while the bench is on the page; `measureMount` remounts the board. */
const InstallDashboardGridBench = Mount.defineStream("InstallDashboardGridBench", {
	args: { count: Schema.Number },
	messages: [BenchMessage.RequestedRemount],
	execute: ({ element, count }) =>
		Stream.callback<ReturnType<typeof BenchMessage.RequestedRemount>>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() =>
					installDashboardGridBench(element, count, () =>
						Queue.offerUnsafe(queue, BenchMessage.RequestedRemount()),
					),
				),
				(uninstall) => Effect.sync(uninstall),
			).pipe(Effect.flatMap(() => Effect.never)),
		),
})

const view = (model: BenchModel, h: HtmlBuilder<BenchMessage>): Html => {
	const count = model.board.document?.widgets.length ?? 0
	const cols = canvasGridOf(model.board)?.tier.cols ?? 12
	return h.div(
		[
			h.Class("p-6"),
			h.Attribute(LAYOUT_COMMITS_ATTRIBUTE, String(model.layoutCommits)),
			h.Attribute(LAST_COMMIT_SIZE_ATTRIBUTE, String(model.lastCommitSize)),
			h.OnMount(InstallDashboardGridBench({ count })),
		],
		[
			h.p([h.Class("mb-3 text-xs text-muted-foreground")], [`${count} widgets · ${cols} columns`]),
			h.keyed("div")(
				`board-${model.mountKey}`,
				[h.DataAttribute("bench-board", "")],
				[
					h.submodel({
						slotId: `bench-board-${model.mountKey}`,
						model: model.board,
						view: boardView,
						viewInputs: { mountKey: model.mountKey },
						toParentMessage: toBoard,
					}),
				],
			),
		],
	)
}

const subscriptions = Subscription.make<BenchModel, BenchMessage, Resources>()((entry) => ({
	gesturePointer: entry(
		{ widgetId: Schema.NullOr(Schema.String) },
		{
			modelToDependencies: (model) => ({ widgetId: model.board.gesture?.widgetId ?? null }),
			dependenciesToStream: ({ widgetId }) =>
				widgetId === null ? Stream.empty : Stream.map(pointerEvents(widgetId), toBoard),
		},
	),
}))

export const lab = defineLabWithFlags("Dashboard grid bench", {
	Model: BenchModel,
	Flags,
	flags: Effect.sync(() => ({
		count: Number(new URLSearchParams(window.location.search).get("n") ?? "50") || 50,
	})),
	init,
	update,
	view,
	subscriptions,
})
