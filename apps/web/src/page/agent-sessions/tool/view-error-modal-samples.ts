import { formatWarehouseDateTime } from "@maple/query-engine"
import { formatBytes, formatNumber, pluralize } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { VariantDifference } from "../../../lib/agent-sessions/tool-error-display"
import { formatDurationNs } from "@maple/web-data/lib/tool-analytics"
import { formatTimestampInTimezone } from "@maple/web-data/lib/timezone-format"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { orderedSearch } from "../../../route/tanstack-search"
import { emptyMessage } from "../../../ui/empty"
import { errorState } from "../../../ui/error-state"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import { skeleton } from "../../../ui/skeleton"
import { Message, type Model, type ToolErrorOccurrenceRow } from "./error-modal-model"
import { currentOf, occurrencesOf, pagingOf } from "./error-modal-update"
import { sampleBody } from "./view-error-modal-payload"
import { sessionLink } from "./view-error-modal-rail"
import type { ModalInputs } from "./view-error-modal"

// `SamplesPane` and `Sample` of `ToolErrorModal`: the failed calls, newest first, one open at a time.

type H = HtmlBuilder<Message>

/** The read's own page size: what "Load N more" promises. */
const SAMPLES_PAGE = 25

const footer = (h: H, model: Model, shown: number, total: number): Html => {
	const paging = pagingOf(model)
	return h.div(
		[h.Class("flex h-9 items-center gap-2 px-6 font-mono text-xs")],
		[
			h.span(
				[h.Class("text-muted-foreground")],
				["Showing ", formatNumber(shown), " of ", formatNumber(total)],
			),
			...(paging === "more"
				? [
						h.button(
							[
								h.Class("text-foreground hover:text-primary active:text-primary"),
								h.Type("button"),
								h.OnClick(Message.ClickedLoadMore()),
							],
							["Load ", String(Math.min(SAMPLES_PAGE, Math.max(total - shown, 1))), " more"],
						),
					]
				: paging === "loading"
					? [h.span([h.Class("text-foreground-subtle")], ["Loading…"])]
					: paging === "failed"
						? [
								h.button(
									[
										h.Class(
											"text-severity-error hover:text-foreground active:text-foreground",
										),
										h.Type("button"),
										h.OnClick(Message.ClickedLoadMore()),
									],
									["Couldn't load more. Retry"],
								),
							]
						: []),
		],
	)
}

/** The failed calls, newest first: one open at a time, j/k move it, the end loads the next page. */
export const samplesPane = (
	h: H,
	model: Model,
	inputs: ModalInputs,
	options: Readonly<{ total: number; differences: ReadonlyMap<string, VariantDifference> | undefined }>,
): Html => {
	const rows = occurrencesOf(model)
	const current = currentOf(model)
	const first = model.pages[0]?.data
	const failure = first !== undefined && AsyncData.isFailure(first) ? first.error : undefined
	const isLoading = first === undefined || (!AsyncData.hasData(first) && failure === undefined)
	const body: ReadonlyArray<Html> =
		failure !== undefined
			? [errorState(h, { failure, title: "Couldn't load samples" })]
			: isLoading && rows.length === 0
				? [
						h.div(
							[h.Class("flex flex-col gap-1.5 px-6 py-3")],
							[skeleton(h, "h-10"), skeleton(h, "h-10"), skeleton(h, "h-10")],
						),
					]
				: rows.length === 0
					? [emptyMessage(h, {}, ["No samples in the selected window."])]
					: rows.map((row, index) =>
							sampleRow(h, model, inputs, row, {
								index,
								isOpen: index === current && !model.isSampleClosed,
								variant: options.differences?.get(row.message)?.middle,
							}),
						)
	return h.div(
		[h.Class("flex min-w-0 grow flex-col overflow-hidden")],
		[
			h.div(
				[
					h.Class(
						"flex h-12 shrink-0 items-center justify-between gap-4 border-b border-border px-6 font-mono",
					),
				],
				[
					h.div(
						[h.Class("flex items-baseline gap-2")],
						[
							h.span([h.Class("text-xs font-medium text-foreground")], ["Samples"]),
							h.span(
								[h.Class("text-2xs leading-3.5 tabular-nums text-foreground-subtle")],
								[
									formatNumber(options.total),
									" failed ",
									pluralize(options.total, "call"),
									" · newest first",
								],
							),
						],
					),
					h.div(
						[h.Class("flex items-center gap-2")],
						[
							h.span(
								[h.Class("pr-1 text-2xs text-foreground-subtle max-md:hidden")],
								["j / k"],
							),
							iconButton(
								h,
								{
									label: "Newer sample",
									variant: "outline",
									size: "icon-xs",
									isDisabled: current === 0,
									className: "text-muted-foreground hover:text-foreground active:text-foreground",
									attributes: [h.OnClick(Message.PressedModalKey({ key: "NewerSample" }))],
								},
								[icon(h, "ChevronLeftIcon", { attributes: [h.AriaHidden(true)] })],
							),
							h.span(
								[h.Class("w-20 text-center text-xs tabular-nums text-foreground")],
								[
									rows.length === 0 ? "0" : String(current + 1),
									" of ",
									formatNumber(options.total),
								],
							),
							iconButton(
								h,
								{
									label: "Older sample",
									variant: "outline",
									size: "icon-xs",
									isDisabled: current >= rows.length - 1 && pagingOf(model) !== "more",
									className: "text-muted-foreground hover:text-foreground active:text-foreground",
									attributes: [h.OnClick(Message.PressedModalKey({ key: "OlderSample" }))],
								},
								[icon(h, "ChevronRightIcon", { attributes: [h.AriaHidden(true)] })],
							),
						],
					),
				],
			),
			h.div(
				[h.Class("min-h-0 grow overflow-y-auto overscroll-contain")],
				[...body, ...(rows.length > 0 ? [footer(h, model, rows.length, options.total)] : [])],
			),
		],
	)
}

const sampleRow = (
	h: H,
	model: Model,
	inputs: ModalInputs,
	row: ToolErrorOccurrenceRow,
	options: Readonly<{ index: number; isOpen: boolean; variant: string | undefined }>,
): Html => {
	const time = formatTimestampInTimezone(row.timestamp, { timeZone: inputs.timeZone })
	return h.div(
		[
			h.Key(row.spanId),
			h.DataAttribute("slot", "tool-error-sample"),
			h.Class("border-b border-border-subtle"),
		],
		[
			h.div(
				[
					h.Class(
						cn(
							"group relative flex w-full items-center gap-3.5 px-6 font-mono hover:bg-surface-sunken active:bg-surface-sunken",
							options.isOpen ? "h-11" : "h-10",
						),
					),
				],
				[
					h.button(
						[
							h.AriaExpanded(options.isOpen),
							h.AriaLabel(`Sample at ${time}`),
							h.Class(
								"absolute inset-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
							),
							h.Type("button"),
							h.OnClick(Message.ClickedSample({ index: options.index })),
						],
						[],
					),
					icon(h, options.isOpen ? "ChevronDownIcon" : "ChevronRightIcon", {
						size: 12,
						className: "shrink-0 text-muted-foreground",
						attributes: [h.AriaHidden(true)],
					}),
					h.span([h.Class("shrink-0 text-xs text-foreground")], [time]),
					h.span(
						[h.Class("flex min-w-0 shrink items-center gap-1.5 text-xs")],
						[
							h.span([h.Class("shrink-0 text-foreground-subtle")], ["session"]),
							sessionLink(h, {
								tool: inputs.tool,
								sessionId: row.sessionId,
								spanId: row.spanId,
								className: "max-w-[160px]",
							}),
						],
					),
					h.span(
						[h.Class("hidden min-w-0 shrink truncate text-xs text-muted-foreground lg:block")],
						[row.model === "" ? "model not recorded" : row.model],
					),
					...(row.service === ""
						? []
						: [
								h.span(
									[
										h.Class(
											"hidden min-w-0 shrink truncate text-xs text-foreground-subtle xl:block",
										),
									],
									[row.service],
								),
							]),
					...(options.variant === undefined || options.variant === ""
						? []
						: [
								h.span(
									[
										h.Class(
											"hidden shrink-0 rounded-sm border border-border px-1.5 text-2xs leading-3.5 text-foreground-subtle md:block",
										),
									],
									["variant ", h.span([h.Class("text-foreground-soft")], [options.variant])],
								),
							]),
					h.span([h.Class("grow")], []),
					...(options.isOpen || row.argumentsBytes === 0
						? []
						: [
								h.span(
									[
										h.Class(
											"hidden shrink-0 text-2xs tabular-nums text-foreground-subtle md:block",
										),
									],
									["args ", formatBytes(row.argumentsBytes)],
								),
							]),
					h.span(
						[h.Class("w-12 shrink-0 text-right text-xs tabular-nums text-foreground-soft")],
						[formatDurationNs(row.durationNs)],
					),
					h.a(
						[
							// The call's own timestamp narrows the trace read to one partition.
							h.Href(
								`${hrefOf(AppRoute.Trace({ traceId: row.traceId, search: {} }))}${orderedSearch(
									[
										["spanId", row.spanId],
										["t", formatWarehouseDateTime(row.timestamp)],
									],
								)}`,
							),
							h.Class(
								"relative flex shrink-0 items-center gap-1.5 text-2xs text-muted-foreground hover:text-foreground active:text-foreground",
							),
						],
						[
							"Open trace",
							icon(h, "ExternalLinkIcon", { size: 12, attributes: [h.AriaHidden(true)] }),
						],
					),
				],
			),
			...(options.isOpen ? [sampleBody(h, model, row)] : []),
		],
	)
}
