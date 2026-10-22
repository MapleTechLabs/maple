import {
	DashboardId,
	defaultWidgetLayout,
	DashboardRefreshIntervalSeconds,
	DashboardVariableSchema,
	TimeRangeSchema,
} from "@maple/domain/http"
import { Clock, Duration, Effect, Queue, Random, Result, Schema, Stream } from "effect"
import { Command, Mount } from "foldkit"
import { createQueryDraft } from "@maple/query-engine/query-builder"
import { makeQueryDataSource } from "@maple/widgets/dashboard"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { downloadPortable } from "../kit/portable"
import {
	autoLaidOut,
	generateWidgetId,
	withAddedWidget,
	withClone,
	withLayouts,
	withoutWidget,
} from "../kit/layout"
import { errorMessageOf, mutateDashboard, readDocument, type WriteSync } from "../kit/store"
import { fetchWidgetData, toWidgetFailure } from "../kit/widget-data"
import { fetchVariableOptions } from "../kit/variables"
import { deriveDefaultWidgetTitle } from "../widget/drafts"
import { Message } from "./message"
import { ShareMessage } from "./share"
import { toLoadFailure } from "../../../data/load-failure"
import { presetById } from "./picker-catalog"
import { applySectionEdit, SectionEdit } from "./section-edit"

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

/** A query variable's option list for the window (`variableOptionsAtomFamily`). */
export const FetchVariableOptions = Command.define("FetchDashboardVariableOptions", {
	args: {
		name: Schema.String,
		key: Schema.String,
		variable: DashboardVariableSchema,
		window: Schema.Struct({ startTime: Schema.String, endTime: Schema.String }),
	},
	messages: [Message.CompletedFetchVariableOptions],
	execute: ({ name, key, variable, window }) =>
		fetchVariableOptions(variable, window).pipe(
			Effect.mapError(toWidgetFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchVariableOptions({ name, key, result })),
		),
})

const decodeDashboardId = Schema.decodeUnknownEffect(DashboardId)

/** `dashboardSharesAtom`: loaded means every widget menu offers "Embed chart". */
export const FetchShares = Command.define("FetchDashboardShares", {
	args: { dashboardId: Schema.String, seq: Schema.Number },
	messages: [Message.GotShareMessage],
	execute: ({ dashboardId, seq }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const id = yield* decodeDashboardId(dashboardId)
			const shares = yield* client.dashboards.listShares({ params: { id } })
			return shares.map((share) => ({
				widgetId: share.widgetId ?? null,
				mode: share.mode,
				token: share.token,
			}))
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) =>
				Message.GotShareMessage({ message: ShareMessage.CompletedFetchShares({ seq, result }) }),
			),
		),
})

/** `PageRefreshProvider`: how long Reload shows its pending spinner. */
export const CompleteReloadSpin = Command.define("CompleteDashboardReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(600)), Message.CompletedReloadSpin({ version })),
})

const toWriteMessage = <E, R>(effect: Effect.Effect<WriteSync, E, R>) =>
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

type HandleMessage =
	| typeof Message.PressedGrip.Type
	| typeof Message.PressedResizeHandle.Type
	| typeof Message.PressedGripKey.Type
	| typeof Message.BlurredGrip.Type

/** This grid's own cell for an event target on one of its handles (`cellOf`). */
const handleCellOf = (container: Element, target: EventTarget | null, selector: string) => {
	if (!(target instanceof Element)) return null
	const handle = target.closest<HTMLElement>(selector)
	const cell = handle?.closest<HTMLElement>("[data-grid-item]")
	const widgetId = cell?.dataset.gridItem
	return handle == null || cell == null || cell.parentElement !== container || widgetId === undefined
		? null
		: { handle, widgetId }
}

const GRIP = ".widget-drag-handle"
const GRIP_KEYS = new Set([" ", "Enter", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"])

/**
 * `DashboardGrid`'s `onPointerDown`, `onKeyDown` and `onBlur`. A primary press on a grip or resize
 * corner starts a gesture, default prevented so it neither selects text nor moves focus. Keys on a
 * grip drive the keyboard move; which keys it takes depends on whether a tile is picked up.
 */
export const WatchGridHandles = Mount.defineStream("WatchDashboardGridHandles", {
	messages: [Message.PressedGrip, Message.PressedResizeHandle, Message.PressedGripKey, Message.BlurredGrip],
	execute: ({ element }) =>
		Stream.callback<HandleMessage>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const session = { pickedUp: "" }
					const onKey = (event: Event) => {
						if (!(event instanceof KeyboardEvent)) return
						const target = handleCellOf(element, event.target, GRIP)
						if (target === null) return
						const isPickKey = event.key === " " || event.key === "Enter"
						if (session.pickedUp === "" ? !isPickKey : session.pickedUp !== target.widgetId)
							return
						if (!GRIP_KEYS.has(event.key)) return
						event.preventDefault()
						if (session.pickedUp === "") session.pickedUp = target.widgetId
						else if (isPickKey || event.key === "Escape") session.pickedUp = ""
						Queue.offerUnsafe(
							queue,
							Message.PressedGripKey({
								widgetId: target.widgetId,
								label: target.handle.dataset.gridLabel ?? "",
								key: event.key,
								isShift: event.shiftKey,
							}),
						)
					}
					const onBlur = (event: Event) => {
						if (!(event instanceof FocusEvent) || session.pickedUp === "") return
						const next = handleCellOf(element, event.relatedTarget, GRIP)
						if (next?.widgetId === session.pickedUp) return
						const widgetId = session.pickedUp
						session.pickedUp = ""
						Queue.offerUnsafe(queue, Message.BlurredGrip({ widgetId }))
					}
					const onDown = (event: Event) => {
						if (
							!(event instanceof PointerEvent) ||
							event.button !== 0 ||
							!(event.target instanceof Element)
						)
							return
						const handle = event.target.closest(".widget-drag-handle, [data-grid-resize-handle]")
						const cell = handle?.closest<HTMLElement>("[data-grid-item]")
						const widgetId = cell?.dataset.gridItem
						if (
							handle == null ||
							cell == null ||
							cell.parentElement !== element ||
							widgetId === undefined
						)
							return
						event.preventDefault()
						const pressed = { widgetId, clientX: event.clientX, clientY: event.clientY }
						Queue.offerUnsafe(
							queue,
							handle.matches("[data-grid-resize-handle]")
								? Message.PressedResizeHandle(pressed)
								: Message.PressedGrip(pressed),
						)
					}
					element.addEventListener("pointerdown", onDown)
					element.addEventListener("keydown", onKey)
					element.addEventListener("focusout", onBlur)
					return () => {
						element.removeEventListener("pointerdown", onDown)
						element.removeEventListener("keydown", onKey)
						element.removeEventListener("focusout", onBlur)
					}
				}),
				(detach) => Effect.sync(detach),
			).pipe(Effect.flatMap(() => Effect.never)),
		),
})

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

/** `updateDashboardRefreshInterval`: in edit mode the picked cadence is the board's default. */
export const SaveRefreshInterval = Command.define("SaveDashboardRefreshInterval", {
	args: { ...Target, refreshIntervalSeconds: DashboardRefreshIntervalSeconds },
	messages: [Message.CompletedWrite],
	execute: ({ orgId, dashboardId, refreshIntervalSeconds }) =>
		toWriteMessage(
			mutateDashboard(orgId, dashboardId, (document, nowIso) => ({
				...document,
				refreshIntervalSeconds,
				updatedAt: nowIso,
			})),
		),
})

/** What the picker adds: a preset as it ships, or a chart style over one default query. */
const pickedWidget = (pick: { readonly presetId: string | null; readonly chartId: string | null }) => {
	const preset = pick.presetId === null ? undefined : presetById(pick.presetId)
	if (preset !== undefined)
		return { visualization: preset.visualization, dataSource: preset.dataSource, display: preset.display }
	if (pick.chartId === null) return null
	const draft = createQueryDraft(0)
	return {
		visualization: "chart" as const,
		dataSource: makeQueryDataSource({
			resultShape: "timeseries",
			queries: [draft],
			formulas: [],
			comparison: { mode: "none", includePercentChange: true },
		}),
		// A derived title ("Error rate by service.name"), so a fresh chart is never "Untitled".
		display: { chartId: pick.chartId, title: deriveDefaultWidgetTitle([draft]) },
	}
}

/** `addWidget` from the picker: a new id, the type's default size, the next free slot. */
export const AddWidget = Command.define("AddDashboardWidget", {
	args: {
		...Target,
		presetId: Schema.NullOr(Schema.String),
		chartId: Schema.NullOr(Schema.String),
		/** Which grid the widget lands in (a group's own "+"); `null` is the root canvas. */
		target: Schema.NullOr(Schema.Struct({ sectionId: Schema.String, tabId: Schema.String })),
	},
	messages: [Message.CompletedWrite],
	execute: ({ orgId, dashboardId, presetId, chartId, target }) =>
		Effect.gen(function* () {
			const picked = pickedWidget({ presetId, chartId })
			if (picked === null)
				return Message.CompletedWrite({ result: Result.succeed("Synced" satisfies WriteSync) })
			const id = generateWidgetId(yield* Clock.currentTimeMillis, yield* Random.next)
			return yield* toWriteMessage(
				mutateDashboard(orgId, dashboardId, (document, nowIso) =>
					withAddedWidget(
						document,
						{ id, ...picked, layout: defaultWidgetLayout(picked.visualization) },
						nowIso,
						target,
					),
				),
			)
		}),
})

/** `autoLayoutWidgets`: every container re-flowed; an empty board is left as it is. */
export const AutoLayout = Command.define("AutoLayoutDashboard", {
	args: Target,
	messages: [Message.CompletedWrite],
	execute: ({ orgId, dashboardId }) =>
		toWriteMessage(
			mutateDashboard(orgId, dashboardId, (document, nowIso) =>
				document.widgets.length === 0
					? document
					: {
							...document,
							widgets: autoLaidOut(document.widgets, document.sections ?? []),
							updatedAt: nowIso,
						},
			),
		),
})

/** The toolbar's Tags: `updateDashboard(id, { tags })`. */
export const SaveTags = Command.define("SaveDashboardViewTags", {
	args: { ...Target, tags: Schema.Array(Schema.String) },
	messages: [Message.CompletedWrite],
	execute: ({ orgId, dashboardId, tags }) =>
		toWriteMessage(
			mutateDashboard(orgId, dashboardId, (document, nowIso) => ({
				...document,
				tags,
				updatedAt: nowIso,
			})),
		),
})

/** `VariablesManagerDialog`'s save: `updateDashboardVariables(id, variables)`. */
export const SaveVariables = Command.define("SaveDashboardVariables", {
	args: { ...Target, variables: Schema.Array(DashboardVariableSchema) },
	messages: [Message.CompletedWrite],
	execute: ({ orgId, dashboardId, variables }) =>
		toWriteMessage(
			mutateDashboard(orgId, dashboardId, (document, nowIso) => ({
				...document,
				variables,
				updatedAt: nowIso,
			})),
		),
})

/** How many fresh ids an edit mints: a new group and its tab, or a new tab. */
const idsNeeded = (edit: SectionEdit): number =>
	edit._tag === "AddSection" ? 2 : edit._tag === "AddTab" ? 1 : 0

/** A group or tab write (`DashboardActionsProvider`'s section actions). */
export const EditSections = Command.define("EditDashboardSections", {
	args: { ...Target, edit: SectionEdit },
	messages: [Message.CompletedWrite],
	execute: ({ orgId, dashboardId, edit }) =>
		Effect.gen(function* () {
			const nowMs = yield* Clock.currentTimeMillis
			const ids = yield* Effect.forEach(Array.from({ length: idsNeeded(edit) }), () =>
				Effect.map(Random.next, (random) => generateWidgetId(nowMs, random)),
			)
			const queue = { next: 0 }
			const nextId = () => {
				const id = ids[queue.next] ?? generateWidgetId(nowMs, 0)
				queue.next += 1
				return id
			}
			return yield* toWriteMessage(
				mutateDashboard(orgId, dashboardId, (document, nowIso) =>
					applySectionEdit(edit, document, nowIso, nextId),
				),
			)
		}),
})
