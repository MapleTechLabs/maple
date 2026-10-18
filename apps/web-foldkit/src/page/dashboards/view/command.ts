import { DashboardId, DashboardWidgetSchema, TimeRangeSchema } from "@maple/domain/http"
import { Clock, Duration, Effect, Queue, Random, Schema, Stream } from "effect"
import { Command, Mount } from "foldkit"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { downloadPortable } from "../kit/portable"
import { generateWidgetId, withClone, withLayouts, withoutWidget } from "../kit/layout"
import { errorMessageOf, mutateDashboard, readDocument } from "../kit/store"
import { fetchWidgetData, toWidgetFailure } from "../kit/widget-data"
import { Message } from "./message"

export const ReadClock = Command.define("ReadDashboardClock", {
	messages: [Message.CompletedReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadClock({ nowMs })),
})

/** `widgetFetchAtom`: one fetch per request key, however many tiles share it. */
export const FetchWidget = Command.define("FetchDashboardWidget", {
	args: {
		key: Schema.String,
		endpoint: Schema.String,
		params: Schema.Record(Schema.String, Schema.Unknown),
	},
	messages: [Message.CompletedFetchWidget],
	execute: ({ key, endpoint, params }) =>
		fetchWidgetData(endpoint, params).pipe(
			Effect.mapError(toWidgetFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchWidget({ key, result })),
		),
})

const decodeDashboardId = Schema.decodeUnknownEffect(DashboardId)

/** `dashboardSharesAtom`: loaded means every widget menu offers "Embed chart". */
export const FetchShares = Command.define("FetchDashboardShares", {
	args: { dashboardId: Schema.String },
	messages: [Message.CompletedFetchShares],
	execute: ({ dashboardId }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const id = yield* decodeDashboardId(dashboardId)
			yield* client.dashboards.listShares({ params: { id } })
		}).pipe(Effect.ignore, Effect.as(Message.CompletedFetchShares({ dashboardId }))),
})

/** `PageRefreshProvider`: how long Reload shows its pending spinner. */
export const CompleteReloadSpin = Command.define("CompleteDashboardReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(600)), Message.CompletedReloadSpin({ version })),
})

const toWriteMessage = <E, R>(effect: Effect.Effect<void, E, R>) =>
	effect.pipe(
		Effect.mapError((error) => errorMessageOf(error)),
		Effect.result,
		Effect.map((result) => Message.CompletedWrite({ result })),
	)

const Target = { orgId: Schema.String, dashboardId: Schema.String }

/** `updateDashboardTimeRange`: the picked range becomes the board's saved range. */
export const SaveTimeRange = Command.define("SaveDashboardTimeRange", {
	args: { ...Target, timeRange: TimeRangeSchema },
	messages: [Message.CompletedWrite],
	execute: ({ orgId, dashboardId, timeRange }) =>
		toWriteMessage(
			mutateDashboard(orgId, dashboardId, (document, nowIso) => ({
				...document,
				timeRange,
				updatedAt: nowIso,
			})),
		),
})

/** `updateDashboard(id, { name })` from the inline title. */
export const RenameDashboard = Command.define("RenameDashboard", {
	args: { ...Target, name: Schema.String },
	messages: [Message.CompletedWrite],
	execute: ({ orgId, dashboardId, name }) =>
		toWriteMessage(
			mutateDashboard(orgId, dashboardId, (document, nowIso) => ({
				...document,
				name,
				updatedAt: nowIso,
			})),
		),
})

export const RemoveWidget = Command.define("RemoveDashboardWidget", {
	args: { ...Target, widgetId: Schema.String },
	messages: [Message.CompletedWrite],
	execute: ({ orgId, dashboardId, widgetId }) =>
		toWriteMessage(
			mutateDashboard(orgId, dashboardId, (document, nowIso) =>
				withoutWidget(document, widgetId, nowIso),
			),
		),
})

/** `cloneWidget`: the id is `generateId`'s, read here because it is the clock and `Math.random`. */
export const CloneWidget = Command.define("CloneDashboardWidget", {
	args: { ...Target, widgetId: Schema.String },
	messages: [Message.CompletedWrite],
	execute: ({ orgId, dashboardId, widgetId }) =>
		Effect.gen(function* () {
			const nowMs = yield* Clock.currentTimeMillis
			const newId = generateWidgetId(nowMs, yield* Random.next)
			return yield* toWriteMessage(
				mutateDashboard(orgId, dashboardId, (document, nowIso) =>
					withClone(document, widgetId, newId, nowIso),
				),
			)
		}),
})

/** `restoreWidget`: idempotent, a refetch may already have put it back. */
export const RestoreWidget = Command.define("RestoreDashboardWidget", {
	args: { ...Target, widget: DashboardWidgetSchema },
	messages: [Message.CompletedWrite],
	execute: ({ orgId, dashboardId, widget }) =>
		toWriteMessage(
			mutateDashboard(orgId, dashboardId, (document, nowIso) =>
				document.widgets.some((existing) => existing.id === widget.id)
					? document
					: { ...document, widgets: [...document.widgets, widget], updatedAt: nowIso },
			),
		),
})

/** `updateWidgetLayouts`: one commit per finished drag or resize, only the changed boxes. */
export const UpdateWidgetLayouts = Command.define("UpdateDashboardWidgetLayouts", {
	args: {
		...Target,
		layouts: Schema.Array(
			Schema.Struct({
				i: Schema.String,
				x: Schema.Number,
				y: Schema.Number,
				w: Schema.Number,
				h: Schema.Number,
			}),
		),
	},
	messages: [Message.CompletedWrite],
	execute: ({ orgId, dashboardId, layouts }) =>
		toWriteMessage(
			mutateDashboard(
				orgId,
				dashboardId,
				(document, nowIso) => withLayouts(document, layouts, nowIso) ?? document,
			),
		),
})

export const ExportDashboard = Command.define("ExportDashboardJson", {
	args: { orgId: Schema.String, dashboardId: Schema.String },
	messages: [Message.CompletedExport],
	execute: ({ orgId, dashboardId }) =>
		readDocument(orgId, dashboardId).pipe(
			Effect.flatMap(downloadPortable),
			Effect.ignore,
			Effect.as(Message.CompletedExport()),
		),
})

// MOUNTS

/** `useContainerWidth`: the sections container's width in whole px, before first paint. */
export const MeasureGrid = Mount.defineStream("MeasureDashboardGrid", {
	messages: [Message.MeasuredGrid],
	execute: ({ element }) =>
		Stream.callback<typeof Message.MeasuredGrid.Type>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					Queue.offerUnsafe(
						queue,
						Message.MeasuredGrid({ width: Math.round(element.getBoundingClientRect().width) }),
					)
					const observer = new ResizeObserver((entries) => {
						const entry = entries.at(-1)
						if (entry !== undefined)
							Queue.offerUnsafe(
								queue,
								Message.MeasuredGrid({ width: Math.round(entry.contentRect.width) }),
							)
					})
					observer.observe(element)
					return observer
				}),
				(observer) => Effect.sync(() => observer.disconnect()),
			).pipe(Effect.flatMap(() => Effect.never)),
		),
})

const WIDTH_STEP_PX = 100

/** `quantizeWidthPx`: the tile width on a 100 px grid, so a resize does not re-key every fetch. */
const quantizeWidthPx = (widthPx: number): number | undefined =>
	!Number.isFinite(widthPx) || widthPx <= 0
		? undefined
		: Math.max(WIDTH_STEP_PX, Math.floor(widthPx / WIDTH_STEP_PX) * WIDTH_STEP_PX)

/**
 * `useInViewportSticky` + `useMeasuredWidthPx` on a tile's root: its quantized width now and on
 * every resize, and (once) that it came within 200 px of the viewport for 200 ms.
 */
export const WatchWidget = Mount.defineStream("WatchDashboardWidget", {
	args: { widgetId: Schema.String },
	messages: [Message.MeasuredWidget, Message.RevealedWidget],
	execute: ({ element, widgetId }) =>
		Stream.callback<typeof Message.MeasuredWidget.Type | typeof Message.RevealedWidget.Type>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const measure = (width: number) => {
						const widthPx = quantizeWidthPx(width)
						if (widthPx !== undefined)
							Queue.offerUnsafe(queue, Message.MeasuredWidget({ widgetId, widthPx }))
					}
					measure(element.getBoundingClientRect().width)
					const resizes = new ResizeObserver((entries) =>
						entries.forEach((entry) => measure(entry.contentRect.width)),
					)
					resizes.observe(element)
					const reveal = { timer: 0, isDone: false }
					const intersections = new IntersectionObserver(
						(entries) => {
							if (reveal.isDone) return
							const isIntersecting = entries.some((entry) => entry.isIntersecting)
							if (isIntersecting && reveal.timer === 0) {
								reveal.timer = window.setTimeout(() => {
									reveal.isDone = true
									intersections.disconnect()
									Queue.offerUnsafe(queue, Message.RevealedWidget({ widgetId }))
								}, 200)
							} else if (!isIntersecting && reveal.timer !== 0) {
								window.clearTimeout(reveal.timer)
								reveal.timer = 0
							}
						},
						{ rootMargin: "200px" },
					)
					intersections.observe(element)
					return { resizes, intersections, reveal }
				}),
				({ resizes, intersections, reveal }) =>
					Effect.sync(() => {
						window.clearTimeout(reveal.timer)
						resizes.disconnect()
						intersections.disconnect()
					}),
			).pipe(Effect.flatMap(() => Effect.never)),
		),
})
