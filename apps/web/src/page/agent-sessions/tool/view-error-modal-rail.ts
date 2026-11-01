import { unwrapToolErrorText, type VariantDifference } from "../../../lib/agent-sessions/tool-error-display"
import { sessionRowId } from "@maple/agent-sessions"
import { rowSelectedClass } from "@maple/ui/styles/ui/list-row"
import { cn } from "@maple/ui/lib/utils"
import { formatToolCount } from "@maple/web-data/lib/tool-analytics"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { orderedSearch } from "../../../route/tanstack-search"
import { errorState } from "../../../ui/error-state"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { meter } from "../../../ui/meter"
import { skeleton } from "../../../ui/skeleton"
import { relativeTime } from "../../kit/relative-time"
import { type ErrorDetail, Message, type Model } from "./error-modal-model"
import type { ModalInputs } from "./view-error-modal"

// The rail of `ToolErrorModal`: the variants a group folded, where it happens, which sessions hit it.

type H = HtmlBuilder<Message>
type BreakdownRow = ErrorDetail["breakdown"][number]

const RAIL_TITLE = "font-mono text-xs font-medium text-foreground"

const variantText = (
	h: H,
	message: string,
	difference: VariantDifference | undefined,
): ReadonlyArray<Html> =>
	difference === undefined || difference.middle === ""
		? [h.span([h.Class("truncate text-muted-foreground")], [unwrapToolErrorText(message).text])]
		: [
				h.span(
					[h.Class("min-w-0 truncate whitespace-pre text-muted-foreground")],
					[difference.before],
				),
				h.span([h.Class("shrink-0 whitespace-pre font-medium text-foreground")], [difference.middle]),
				h.span(
					[h.Class("min-w-0 truncate whitespace-pre text-muted-foreground")],
					[difference.after],
				),
			]

/** The raw texts a group folded, where there is more than one; one narrows the samples. */
const variantsSection = (
	h: H,
	detail: ErrorDetail,
	total: number,
	differences: ReadonlyMap<string, VariantDifference>,
	selected: string | undefined,
): Html => {
	const max = Math.max(1, ...detail.variants.map((row) => row.calls))
	const isOnlyIndex = [...differences.values()].every((difference) => /^\[\d+\]$/.test(difference.middle))
	return h.section(
		[h.Class("flex flex-col gap-2 border-b border-border p-4")],
		[
			h.div(
				[h.Class("flex items-baseline gap-2 pb-1")],
				[
					h.span([h.Class(RAIL_TITLE)], ["Variants"]),
					h.span(
						[h.Class("font-mono text-2xs leading-3.5 tabular-nums text-foreground-subtle")],
						[formatToolCount(total), " raw messages"],
					),
				],
			),
			...detail.variants.map((row) => {
				const isSelected = row.message === selected
				return h.button(
					[
						h.Key(row.message),
						h.AriaPressed(String(isSelected)),
						h.Class(
							cn(
								"-mx-2 flex h-8 shrink-0 items-center gap-2.5 rounded-md px-2 text-left font-mono text-xs transition-colors",
								isSelected ? "bg-primary-a2" : "hover:bg-surface-sunken active:bg-surface-sunken",
							),
						),
						h.Title(unwrapToolErrorText(row.message).text),
						h.Type("button"),
						h.OnClick(Message.ClickedVariant({ variant: isSelected ? undefined : row.message })),
					],
					[
						h.span(
							[
								h.Class(
									"flex w-0 min-w-0 flex-1 items-baseline overflow-hidden whitespace-pre",
								),
							],
							variantText(h, row.message, differences.get(row.message)),
						),
						meter(h, {
							value: row.calls,
							max,
							minVisible: 4,
							tone: "crit",
							className: "w-12 shrink-0 rounded-xs bg-muted",
						}),
						h.span(
							[h.Class("w-7 shrink-0 text-right tabular-nums text-foreground")],
							[formatToolCount(row.calls)],
						),
					],
				)
			}),
			h.p(
				[h.Class("pt-1 font-mono text-2xs leading-[15px] text-foreground-subtle")],
				[
					isOnlyIndex
						? "Grouped because only the array index differs."
						: "Grouped because only masked values differ.",
					" ",
					"Select one to filter samples.",
				],
			),
		],
	)
}

const whereItHappens = (h: H, rows: ReadonlyArray<BreakdownRow>, isLoading: boolean): Html =>
	h.section(
		[h.Class("flex flex-col gap-3.5 border-b border-border p-4")],
		[
			h.span([h.Class(RAIL_TITLE)], ["Where it happens"]),
			...(isLoading && rows.length === 0
				? [
						h.div(
							[h.Class("flex flex-col gap-2")],
							[skeleton(h, "h-3 w-3/4"), skeleton(h, "h-3 w-1/2")],
						),
					]
				: [
						breakdown(
							h,
							"Model",
							fold(rows, (row) => row.model),
							"unattributed",
						),
						breakdown(
							h,
							"Service",
							fold(rows, (row) => row.service),
							"unknown",
						),
					]),
		],
	)

/**
 * The session a failure belongs to: the trace view filtered to this tool, and the failed call
 * opened in its span panel. Positioned, so it sits above a row's stretched button.
 */
export const sessionLink = (
	h: H,
	options: Readonly<{ tool: string; sessionId: string; spanId?: string; className?: string }>,
): Html =>
	h.a(
		[
			// `{ tool, view, span }` in that order.
			h.Href(
				`${hrefOf(AppRoute.AgentSession({ sessionId: options.sessionId, search: {} }))}${orderedSearch(
					[
						["tool", options.tool],
						["view", "trace"],
						["span", options.spanId],
					],
				)}`,
			),
			h.Title(options.sessionId),
			h.Class(
				cn(
					"group/link relative flex min-w-0 items-center gap-1.5 rounded-sm text-foreground hover:text-primary active:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
					options.className,
				),
			),
		],
		[
			h.span([h.Class("truncate")], [sessionRowId(options.sessionId)]),
			icon(h, "ExternalLinkIcon", {
				size: 10,
				className: "shrink-0 text-muted-foreground",
				attributes: [h.AriaHidden(true)],
			}),
		],
	)

const sessionRowClass = (isSelected: boolean) =>
	cn(
		"group flex w-full shrink-0 items-center gap-3 border-b border-border-subtle pr-4 pl-4 text-left transition-colors",
		rowSelectedClass(isSelected),
		!isSelected && "hover:bg-surface-sunken active:bg-surface-sunken",
	)

const LAST_CLASS = "w-14 shrink-0 text-right font-mono text-2xs tabular-nums text-foreground-subtle"

/** Which sessions hit this group; `All sessions` is the way back out of a selection. */
const sessionsSection = (h: H, model: Model, inputs: ModalInputs, detail: ErrorDetail): Html => {
	const { group, session: selected, nowMs, timeZone } = inputs
	const isLoading = !AsyncData.hasData(model.detail.data) && !AsyncData.isFailure(model.detail.data)
	return h.section(
		[h.Class("flex flex-col")],
		[
			h.div(
				[h.Class("flex items-baseline gap-2 px-4 pt-4 pb-2.5")],
				[
					h.span([h.Class(RAIL_TITLE)], ["Sessions"]),
					h.span(
						[h.Class("font-mono text-2xs leading-3.5 tabular-nums text-foreground-subtle")],
						[formatToolCount(group.sessions)],
					),
				],
			),
			eyebrow(
				h,
				{
					variant: "mono",
					as: "div",
					className: "flex h-8 shrink-0 items-center gap-3 border-y border-border px-4",
				},
				[
					h.span([h.Class("grow")], ["Session"]),
					h.span([h.Class("w-10 shrink-0 text-right")], ["Hits"]),
					h.span([h.Class("w-14 shrink-0 text-right")], ["Last"]),
				],
			),
			h.button(
				[
					h.AriaPressed(String(selected === undefined)),
					h.Class(cn(sessionRowClass(selected === undefined), "h-10")),
					h.Type("button"),
					h.OnClick(Message.ClickedSession({ session: undefined })),
				],
				[
					h.span([h.Class("grow font-mono text-xs font-medium text-foreground")], ["All sessions"]),
					h.span(
						[h.Class("w-10 shrink-0 text-right font-mono text-xs tabular-nums text-foreground")],
						[formatToolCount(group.calls)],
					),
					relativeTime(h, {
						value: group.lastSeen,
						nowMs,
						timeZone,
						variant: "orDate",
						tooltip: "title",
						className: LAST_CLASS,
					}),
				],
			),
			...(isLoading && detail.sessions.length === 0
				? [
						h.div(
							[h.Class("flex flex-col gap-1.5 px-4 py-3")],
							[skeleton(h, "h-10"), skeleton(h, "h-10")],
						),
					]
				: detail.sessions.map((row) => {
						const isSelected = row.sessionId === selected
						return h.div(
							[h.Key(row.sessionId), h.Class(cn(sessionRowClass(isSelected), "h-[52px]"))],
							[
								h.button(
									[
										h.AriaPressed(String(isSelected)),
										h.AriaLabel(`Show samples in ${sessionRowId(row.sessionId)}`),
										h.Class(
											"absolute inset-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
										),
										h.Type("button"),
										h.OnClick(
											Message.ClickedSession({
												session: isSelected ? undefined : row.sessionId,
											}),
										),
									],
									[],
								),
								h.span(
									[h.Class("flex w-0 min-w-0 grow flex-col items-start gap-1")],
									[
										sessionLink(h, {
											tool: inputs.tool,
											sessionId: row.sessionId,
											className: "max-w-full font-mono text-xs",
										}),
										h.span(
											[
												h.Class(
													"w-full truncate font-mono text-2xs leading-3.5 text-foreground-subtle",
												),
											],
											[
												row.service === ""
													? row.agentName === ""
														? row.vendorId
														: row.agentName
													: row.service,
											],
										),
									],
								),
								h.span(
									[
										h.Class(
											"w-10 shrink-0 text-right font-mono text-xs tabular-nums text-foreground",
										),
									],
									[formatToolCount(row.hits)],
								),
								relativeTime(h, {
									value: row.lastSeen,
									nowMs,
									timeZone,
									variant: "orDate",
									tooltip: "title",
									className: LAST_CLASS,
								}),
							],
						)
					})),
			h.div(
				[h.Class("flex h-9 shrink-0 items-center gap-2 px-4 font-mono text-xs")],
				[
					h.span(
						[h.Class("text-muted-foreground")],
						[
							"Showing ",
							formatToolCount(detail.sessions.length),
							" of ",
							formatToolCount(group.sessions),
						],
					),
					h.span([h.Class("text-foreground-subtle")], ["by hits"]),
				],
			),
		],
	)
}

/** The rail: the facts read's failure in its place, or what the read found. */
export const railView = (
	h: H,
	model: Model,
	inputs: ModalInputs,
	detail: ErrorDetail,
	differences: ReadonlyMap<string, VariantDifference>,
): Html => {
	const isLoading = !AsyncData.hasData(model.detail.data) && !AsyncData.isFailure(model.detail.data)
	const failure = AsyncData.isFailure(model.detail.data) ? model.detail.data.error : undefined
	return h.aside(
		[
			h.Class(
				"flex w-[340px] shrink-0 flex-col overflow-y-auto overscroll-contain border-r border-border bg-sidebar max-md:h-56 max-md:w-full max-md:border-r-0 max-md:border-b",
			),
		],
		failure !== undefined
			? [errorState(h, { failure, title: "Couldn't load this error's details" })]
			: [
					...(detail.variants.length > 1
						? [variantsSection(h, detail, inputs.group.variants, differences, inputs.variant)]
						: []),
					whereItHappens(h, detail.breakdown, isLoading),
					sessionsSection(h, model, inputs, detail),
				],
	)
}

/** The group's pairs folded to one key, the three busiest first. */
const fold = (rows: ReadonlyArray<BreakdownRow>, keyOf: (row: BreakdownRow) => string) =>
	[
		...rows
			.reduce(
				(totals, row) => totals.set(keyOf(row), (totals.get(keyOf(row)) ?? 0) + row.calls),
				new Map<string, number>(),
			)
			.entries(),
	]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 3)

const breakdown = (
	h: H,
	label: string,
	rows: ReadonlyArray<readonly [string, number]>,
	blank: string,
): Html => {
	const max = rows[0]?.[1] ?? 1
	return h.div(
		[h.Class("flex flex-col gap-1.5")],
		[
			eyebrow(h, { variant: "mono", className: "leading-3.5" }, [label]),
			...rows.map(([key, calls], index) =>
				h.div(
					[h.Key(key), h.Class("flex items-center gap-2.5 font-mono text-xs leading-4")],
					[
						h.span(
							[
								h.Class(
									cn(
										"w-0 min-w-0 flex-1 truncate",
										index === 0 ? "text-foreground" : "text-muted-foreground",
										key === "" && "italic",
									),
								),
							],
							[key === "" ? blank : key],
						),
						meter(h, {
							value: calls,
							max,
							minVisible: 4,
							fillClassName: "bg-muted-foreground",
							className: "w-14 shrink-0 rounded-xs bg-muted",
						}),
						h.span(
							[
								h.Class(
									cn(
										"w-10 shrink-0 text-right tabular-nums",
										index === 0 ? "text-foreground" : "text-muted-foreground",
									),
								),
							],
							[formatToolCount(calls)],
						),
					],
				),
			),
		],
	)
}
