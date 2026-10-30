import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { emptyMessage } from "../../../../ui/empty"
import { depthControls } from "../depth-controls"
import { Message, type Model } from "./model"
import { spanRow } from "./row"
import { flattenTree } from "./tree"
import { KEYS_ATTRIBUTE, SELECTED_ATTRIBUTE, VirtualizeWaterfall } from "./virtualize"

// `SpanHierarchy` (packages/ui/src/components/traces/span-hierarchy.tsx): the Waterfall tab's body.

/** Nothing comes from the page but the Model: the selection lives in it too. */
export type ViewInputs = Readonly<Record<string, never>>

const header = (h: HtmlBuilder<Message>, shown: number, total: number): Html =>
	h.div(
		[
			h.Class(
				"@container/row flex shrink-0 items-center border-b bg-surface-sunken px-2 py-1.5 text-xs font-medium text-muted-foreground",
			),
		],
		[
			h.div(
				[h.Class("flex items-center gap-2 flex-1 min-w-0 overflow-hidden")],
				[
					depthControls(h, {
						onCollapseOneLevel: Message.ClickedCollapseOneLevel(),
						onExpandOneLevel: Message.ClickedExpandOneLevel(),
						onCollapseAll: Message.ClickedCollapseAll(),
						onExpandAll: Message.ClickedExpandAll(),
						triggerIds: [
							"waterfall-depth-0",
							"waterfall-depth-1",
							"waterfall-depth-2",
							"waterfall-depth-3",
						],
					}),
					...(shown < total
						? [
								h.span(
									[h.Class("shrink-0 font-normal tabular-nums text-3xs")],
									[
										String(shown),
										" of ",
										String(total),
										h.span([h.Class("hidden @min-[420px]/row:inline")], [" spans"]),
									],
								),
							]
						: []),
				],
			),
			h.div(
				[h.Class("flex items-center gap-2 shrink-0 ml-2")],
				[
					h.span([h.Class("hidden w-48 text-center @min-[560px]/row:block")], ["Duration"]),
					h.span([h.Class("w-16 text-right")], ["Time"]),
					h.span([h.Class("w-14 text-center")], ["Status"]),
				],
			),
		],
	)

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, _inputs, h) => {
	if (model.rootSpans.length === 0) {
		return emptyMessage(h, { className: "rounded-md border p-8 text-sm" }, [
			"No spans found for this trace",
		])
	}
	const expanded = new Set(model.expanded)
	const flat = flattenTree(model.rootSpans, expanded)
	return h.div(
		[h.Class("flex h-full flex-col overflow-hidden rounded-md border")],
		[
			header(h, flat.length, model.totalSpanCount),
			h.div(
				[
					h.Class("flex-1 min-h-0 overflow-auto"),
					h.DataAttribute(KEYS_ATTRIBUTE, flat.map((row) => row.node.spanId).join(" ")),
					h.DataAttribute(SELECTED_ATTRIBUTE, model.selectedSpanId ?? ""),
					h.OnMount(VirtualizeWaterfall()),
				],
				[
					h.div(
						[h.Style({ height: `${model.totalSize}px`, position: "relative", width: "100%" })],
						model.virtualRows.flatMap((item) => {
							const row = flat[item.index]
							return row === undefined
								? []
								: [
										h.div(
											[
												h.Key(row.node.spanId),
												h.DataAttribute("index", String(item.index)),
												h.Style({
													position: "absolute",
													top: "0px",
													left: "0px",
													width: "100%",
													transform: `translateY(${item.start}px)`,
												}),
											],
											[
												spanRow(h, row, {
													totalDurationMs: model.totalDurationMs,
													traceStartTime: model.traceStartTime,
													isExpanded: expanded.has(row.node.spanId),
													isSelected: model.selectedSpanId === row.node.spanId,
												}),
											],
										),
									]
						}),
					),
				],
			),
		],
	)
})
