import { countLabel } from "@maple/ui/lib/format"
import { shortId } from "@maple/ui/lib/ids"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as DialogView from "../../../ui/dialog-view"
import { errorState } from "../../../ui/error-state"
import { httpSpanLabel } from "../../../ui/http-span-label"
import * as Resizable from "../../../ui/resizable"
import { skeleton, skeletonList } from "../../../ui/skeleton"
import { traceIdBadge } from "../../../ui/trace-badges"
import { sheetDetailHeader } from "../../kit/sheet-detail-header"
import { Message } from "./message"
import type { Model } from "./model"
import { loadedTrace, selectedSpanOf } from "./select"
import * as SpanPanel from "./span-panel"
import { anatomy, callout, traceViewTabs } from "./view"
import { logsLink, replayLink } from "./view-header"

// The trace page in the list's peek sheet. The sheet, its footer and the keys are the list's.

export type PeekViewInputs = Readonly<{ dialogId: string; timeZone: string }>

type H = HtmlBuilder<Message>

const loadingRow = (h: H): Html =>
	h.div(
		[h.Class("flex items-center gap-2 border-b p-3 last:border-0")],
		[skeleton(h, "size-4"), skeleton(h, "h-4 w-20"), skeleton(h, "h-4 flex-1"), skeleton(h, "h-2 w-32")],
	)

const loading = (h: H, model: Model, inputs: PeekViewInputs): ReadonlyArray<Html> => [
	sheetDetailHeader(h, {
		dialogId: inputs.dialogId,
		kind: "Trace",
		title: [shortId(model.traceId, "trace")],
		description: "Loading trace details",
	}),
	h.div(
		[h.Class("flex-1 space-y-3 overflow-hidden p-4")],
		[
			skeleton(h, "h-1.5 w-full rounded-full"),
			skeletonList(h, {
				rows: 6,
				className: "gap-0 rounded-md border",
				renderRow: () => loadingRow(h),
			}),
		],
	),
]

/** No root span (or no spans at all): a plain header and the id. */
const missing = (h: H, model: Model, inputs: PeekViewInputs, spanCount: number): ReadonlyArray<Html> => [
	DialogView.dialogHeader(
		h,
		"sheet",
		[
			DialogView.dialogTitle(
				h,
				"sheet",
				inputs.dialogId,
				shortId(model.traceId, "trace"),
				"font-mono text-title",
			),
			DialogView.dialogDescription(
				h,
				"sheet",
				inputs.dialogId,
				spanCount === 0
					? "This trace could not be found. It may have expired or not been ingested yet."
					: `Found ${countLabel(spanCount, "span")}, but the root span is missing.`,
			),
		],
		"pr-14",
	),
	h.div(
		[h.Class("flex flex-1 flex-col items-center justify-center p-8")],
		[traceIdBadge(h, model.traceId)],
	),
]

export const view = Submodel.defineView<Model, Message, PeekViewInputs>((model, inputs, h) =>
	h.div(
		[h.Class("contents")],
		AsyncData.matchData(model.hierarchy.data, {
			onEmpty: () => loading(h, model, inputs),
			onFailure: (failure) => [
				sheetDetailHeader(h, {
					dialogId: inputs.dialogId,
					kind: "Trace",
					title: [shortId(model.traceId, "trace")],
					description: "Couldn't load trace",
				}),
				h.div(
					[h.Class("flex-1 overflow-auto p-4")],
					[
						errorState(h, {
							failure,
							title: "Couldn't load trace details",
							onRetry: Message.ClickedRetryHierarchy(),
						}),
					],
				),
			],
			onData: (data) =>
				Option.match(loadedTrace(model), {
					onNone: () => missing(h, model, inputs, data.spans.length),
					onSome: (trace) => {
						const root = trace.rootSpan
						if (root === undefined) return missing(h, model, inputs, trace.data.spans.length)
						const isWaiting = AsyncData.isRefreshing(model.hierarchy.data)
						const selected = selectedSpanOf(model)
						const panel = model.spanPanel
						return [
							h.div(
								[
									h.Class(cn("flex min-h-0 flex-1 flex-col", refreshingClass(isWaiting))),
									...(isWaiting ? [h.AriaBusy(true)] : []),
								],
								[
									sheetDetailHeader(h, {
										dialogId: inputs.dialogId,
										kind: "Trace",
										mono: false,
										title: [
											httpSpanLabel(h, {
												spanName: root.spanName,
												spanAttributes: root.spanAttributes,
												spanKind: root.spanKind,
												className: "gap-3",
											}),
										],
										description: `Spans and timing for trace ${trace.data.traceId}`,
										meta: [
											traceIdBadge(h, trace.data.traceId, {
												size: "sm",
												className: "max-w-[260px]",
												onCopy: Message.ClickedCopyTraceId(),
											}),
											...[logsLink(h, model, trace), replayLink(h, model)].flatMap(
												(link) => (link === null ? [] : [link]),
											),
										],
									}),
									h.div(
										[h.Class("flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4")],
										[
											anatomy(h, trace, inputs.timeZone, model.nowMs),
											callout(h, trace, selected?.spanId),
											h.submodel({
												slotId: "trace-peek-split",
												model: model.split,
												view: Resizable.view,
												viewInputs: {
													className:
														"min-h-0 flex-1 overflow-hidden rounded-md border",
													withHandle: [true],
													toPanels: () => [
														[traceViewTabs(h, model)],
														...(panel === null || selected === undefined
															? []
															: [
																	[
																		h.submodel({
																			slotId: `peek-span-panel:${selected.spanId}`,
																			model: panel,
																			view: SpanPanel.view,
																			viewInputs: {
																				timeZone: inputs.timeZone,
																			},
																			toParentMessage: (
																				message: SpanPanel.Message,
																			) =>
																				Message.GotSpanPanelMessage({
																					message,
																				}),
																		}),
																	],
																]),
													],
												},
												toParentMessage: (message: Resizable.Message) =>
													Message.GotSplitMessage({ message }),
											}),
										],
									),
								],
							),
						]
					},
				}),
		}),
	),
)
