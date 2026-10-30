import { formatPercent, pluralize } from "@maple/ui/lib/format"
import { TONE_FILL, TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import {
	commonErrorPrefix,
	type ErrorTextToken,
	errorTextTokens,
	errorTrendBucket,
	failureStatus,
	fillTrend,
	unwrapToolErrorText,
} from "../../../lib/agent-sessions/tool-error-display"
import { formatToolCount, UNGROUPED_FINGERPRINT } from "@maple/web-data/lib/tool-analytics"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { LoadFailure } from "../../../data/load-failure"
import { errorState } from "../../../ui/error-state"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { miniBars } from "../../../ui/mini-bars"
import { skeleton } from "../../../ui/skeleton"
import { statusDot } from "../../../ui/status-dot"
import { truncatedText } from "../../../ui/truncated-text"
import { errorTextLine, failureStatusLine, maskChip, windowRangeLabel } from "../tools-kit/error-parts"
import type { ToolErrorRow } from "../tools-kit/model"
import {
	shareCell,
	type SortState,
	sortRows,
	th,
	toolRowClass,
	toolTable,
	toolTableBody,
	toolTableHead,
} from "../tools-kit/table"
import { relativeTime } from "../../kit/relative-time"
import { Message } from "./message"

type H = HtmlBuilder<Message>

const VISIBLE_GROUPS = 10

const MASK_MEANINGS = new Map([
	["[*]", "index"],
	["<n>", "number"],
	["<ts>", "timestamp"],
	["<id>", "id"],
	["<email>", "email"],
	["<url>", "host"],
])

type Range = Readonly<{ startMs: number; endMs: number }>

export type Prepared = ToolErrorRow &
	Readonly<{
		tokens: ReadonlyArray<ErrorTextToken>
		display: string
		share: number
		spark: ReadonlyArray<number>
	}>

/** `prepareToolErrors`: messages unwrapped, the shared prefix hoisted, trends filled over the window. */
export const prepare = (rows: ReadonlyArray<ToolErrorRow>, range: Range) => {
	const failures = rows.reduce((sum, row) => sum + row.calls, 0)
	const bucket = errorTrendBucket(range.startMs, range.endMs)
	const texts = rows.map((row) => unwrapToolErrorText(row.message).text)
	const prefix = commonErrorPrefix(
		texts.filter((text, index) => text !== "" && rows[index]?.fingerprint !== UNGROUPED_FINGERPRINT),
	)
	const types = new Set(
		rows.flatMap((row) => (row.fingerprint === UNGROUPED_FINGERPRINT ? [] : [row.errorType])),
	)
	const [onlyType] = types
	const errorType = rows.length > 1 && types.size === 1 && onlyType !== "" ? onlyType : undefined
	return {
		prefix,
		errorType,
		rows: rows.map((row, index): Prepared => {
			const text = texts[index] ?? ""
			const display = prefix !== "" && text.startsWith(prefix) ? text.slice(prefix.length) : text
			return {
				...row,
				display,
				tokens: errorTextTokens(display),
				share: failures > 0 ? row.calls / failures : 0,
				spark: fillTrend(row.trend, range.startMs, range.endMs, bucket.seconds),
			}
		}),
	}
}

const SORT_FIELDS = new Map<string, (row: Prepared) => number>([
	["calls", (row) => row.calls],
	["sessions", (row) => row.sessions],
	["lastSeen", (row) => row.lastSeen],
])

const groupTitle = (h: H, row: Prepared): Html =>
	row.fingerprint === UNGROUPED_FINGERPRINT
		? h.span([h.Class("truncate text-muted-foreground")], ["Failures recorded before error grouping"])
		: row.display === ""
			? h.span([h.Class("truncate text-muted-foreground")], ["No error message recorded"])
			: errorTextLine(h, row.tokens)

export type ErrorsTableInputs = Readonly<{
	rows: ReadonlyArray<ToolErrorRow>
	tool: string
	toolCalls: number
	range: Range
	selected: string | undefined
	sort: SortState
	isExpanded: boolean
	isLoading: boolean
	failure: LoadFailure | undefined
	isWaiting: boolean
	nowMs: number
	timeZone: string
}>

const errorRow = (
	h: H,
	row: Prepared,
	inputs: ErrorsTableInputs,
	maxShare: number,
	sharedType: string | undefined,
): Html =>
	h.button(
		[
			h.Key(row.fingerprint),
			h.AriaPressed(String(row.fingerprint === inputs.selected)),
			h.Class(toolRowClass(row.fingerprint === inputs.selected)),
			...(row.display === "" ? [] : [h.Title(row.display)]),
			h.Type("button"),
			h.OnClick(Message.ClickedErrorRow({ fingerprint: row.fingerprint })),
		],
		[
			h.span(
				[
					h.Class(
						"flex w-0 min-w-0 flex-1 items-center gap-2.5 overflow-hidden font-mono text-xs leading-4",
					),
				],
				[
					groupTitle(h, row),
					...(sharedType === undefined && row.errorType !== ""
						? [
								h.span(
									[
										h.Class(
											cn(
												"flex h-4.5 shrink-0 items-center rounded-sm border border-border px-1.5 text-2xs leading-3.5",
												TONE_TEXT.crit,
											),
										),
									],
									[row.errorType],
								),
							]
						: []),
					...(row.variants > 1
						? [
								h.span(
									[
										h.Class(
											"shrink-0 pl-1.5 text-2xs leading-3.5 text-foreground-subtle",
										),
									],
									[String(row.variants), " variants"],
								),
							]
						: []),
				],
			),
			h.span(
				[h.Class("hidden w-24 shrink-0 items-center @min-[720px]/panel:flex")],
				[
					miniBars(h, {
						values: row.spark,
						color: "var(--color-severity-error)",
						floor: 12.5,
						floorColor: "var(--input)",
						minHeight: 18.75,
						gap: row.spark.length > 12 ? 1 : 4.3,
						className: "h-4 w-24 shrink-0",
					}),
				],
			),
			shareCell(h, {
				ratio: row.share,
				max: maxShare,
				label: formatPercent(row.share, { floor: 0.01 }),
				tone: { bar: TONE_FILL.crit, text: "text-muted-foreground" },
			}),
			h.span(
				[h.Class("w-20 shrink-0 text-right font-mono text-xs tabular-nums text-foreground")],
				[formatToolCount(row.calls)],
			),
			h.span(
				[
					h.Class(
						"hidden w-20 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground @min-[640px]/panel:block",
					),
				],
				[formatToolCount(row.sessions)],
			),
			relativeTime(h, {
				value: row.lastSeen,
				variant: "orDate",
				tooltip: "title",
				nowMs: inputs.nowMs,
				timeZone: inputs.timeZone,
				className:
					"hidden w-24 shrink-0 text-right font-mono text-2xs tabular-nums text-foreground-subtle @min-[800px]/panel:block",
			}),
			h.span(
				[h.Class("flex w-3.5 shrink-0 items-center justify-end text-foreground-subtle")],
				[icon(h, "ChevronRightIcon", { size: 14, attributes: [h.AriaHidden(true)] })],
			),
		],
	)

const LOADING_WIDTHS = [340, 260, 400]

const loadingRows = (h: H): ReadonlyArray<Html> =>
	LOADING_WIDTHS.map((width, index) =>
		h.div(
			[
				h.Key(String(width)),
				h.Class("flex h-[38px] items-center gap-3 border-b border-border-subtle px-2.5 last:border-0"),
				h.Style({ opacity: String(1 - index * 0.2) }),
			],
			[
				h.span(
					[h.Class("w-0 min-w-0 flex-1")],
					[skeleton(h, "h-2.5", { width: `${width}px`, "max-width": "100%" })],
				),
				h.span(
					[h.Class("hidden w-24 shrink-0 @min-[720px]/panel:block")],
					[skeleton(h, "h-2.5 w-24")],
				),
				h.span(
					[h.Class("flex w-36 shrink-0 justify-end gap-2.5")],
					[skeleton(h, "h-1 w-[60px]"), h.span([h.Class("w-[46px]")], [])],
				),
				h.span([h.Class("flex w-20 shrink-0 justify-end")], [skeleton(h, "h-2.5 w-7")]),
				h.span(
					[h.Class("hidden w-20 shrink-0 justify-end @min-[640px]/panel:flex")],
					[skeleton(h, "h-2.5 w-[22px]")],
				),
				h.span(
					[h.Class("hidden w-24 shrink-0 justify-end @min-[800px]/panel:flex")],
					[skeleton(h, "h-2.5 w-11")],
				),
				h.span([h.Class("w-3.5 shrink-0")], []),
			],
		),
	)

const head = (h: H, inputs: ErrorsTableInputs, headHint: string): Html => {
	const sortable = (label: string, key: string, hidden?: string) =>
		th(h, {
			label,
			width: "w-20 shrink-0",
			align: "right",
			sortKey: key,
			sort: inputs.sort,
			onSort: (sortKey) => Message.ClickedErrorsSort({ key: sortKey }),
			hidden,
		})
	return toolTableHead(h, [
		h.div(
			[h.Class("flex w-0 min-w-0 flex-1 items-baseline gap-2.5 font-mono text-2xs leading-3.5")],
			[
				eyebrow(h, { variant: "mono" }, ["Error"]),
				...(headHint === ""
					? []
					: [truncatedText(h, { text: headHint, className: "text-foreground-subtle" })]),
			],
		),
		th(h, {
			label: windowRangeLabel(inputs.range.startMs, inputs.range.endMs, inputs.timeZone),
			width: "w-24 shrink-0",
			hidden: "hidden @min-[720px]/panel:flex",
		}),
		th(h, { label: "Share", width: "w-36 shrink-0 pl-6" }),
		sortable("Count", "calls"),
		sortable("Sessions", "sessions", "hidden @min-[640px]/panel:flex"),
		th(h, {
			label: "Last seen",
			width: "w-24 shrink-0",
			align: "right",
			sortKey: "lastSeen",
			sort: inputs.sort,
			onSort: (sortKey) => Message.ClickedErrorsSort({ key: sortKey }),
			hidden: "hidden @min-[800px]/panel:flex",
		}),
		h.span([h.AriaHidden(true), h.Class("w-3.5 shrink-0")], []),
	])
}

const showMore = (h: H, hidden: ReadonlyArray<Prepared>, isExpanded: boolean): Html => {
	const hiddenCalls = hidden.reduce((sum, row) => sum + row.calls, 0)
	return h.button(
		[
			h.AriaExpanded(isExpanded),
			h.Class(
				"flex h-[38px] w-full items-center gap-2.5 px-2.5 text-left font-mono text-xs transition-colors hover:bg-surface-sunken",
			),
			h.Type("button"),
			h.OnClick(Message.ToggledErrorsExpanded()),
		],
		[
			icon(h, "ChevronDownIcon", {
				size: 12,
				className: cn(
					"shrink-0 transition-transform",
					isExpanded && "rotate-180",
					"text-muted-foreground",
				),
				attributes: [h.AriaHidden(true)],
			}),
			h.span(
				[h.Class("text-foreground")],
				[
					isExpanded
						? "Show fewer errors"
						: `Show ${formatToolCount(hidden.length)} more ${pluralize(hidden.length, "error")}`,
				],
			),
			...(isExpanded
				? []
				: [
						h.span(
							[h.Class("text-foreground-subtle")],
							[
								formatToolCount(hiddenCalls),
								` failed ${pluralize(hiddenCalls, "call")}`,
								...(hiddenCalls === hidden.length && hidden.length > 1 ? [", 1 each"] : []),
							],
						),
					]),
		],
	)
}

const maskLabels = (rows: ReadonlyArray<Prepared>): ReadonlyArray<string> =>
	[
		...new Set(
			rows.flatMap((row) =>
				row.tokens.flatMap((token) =>
					token.kind === "mask"
						? [token.label]
						: token.kind === "path"
							? token.parts.flatMap((part) => (part.kind === "mask" ? [part.label] : []))
							: [],
				),
			),
		),
	].filter((label) => MASK_MEANINGS.has(label))

/** How one tool fails, one row per distinct error. */
export const errorsTable = (h: H, inputs: ErrorsTableInputs): Html => {
	const failures = inputs.rows.reduce((sum, row) => sum + row.calls, 0)
	const prepared = prepare(inputs.rows, inputs.range)
	const maxShare = prepared.rows.reduce((max, row) => Math.max(max, row.share), 0)
	const sorted = sortRows(prepared.rows, inputs.sort, (row, key) => SORT_FIELDS.get(key)?.(row))
	const visible = inputs.isExpanded ? sorted : sorted.slice(0, VISIBLE_GROUPS)
	const hidden = sorted.slice(VISIBLE_GROUPS)
	const status =
		inputs.rows.length === 0
			? undefined
			: failureStatus({
					lastSeen: Math.max(...inputs.rows.map((row) => row.lastSeen)),
					callsSince: Math.min(...inputs.rows.map((row) => row.callsSince)),
					failures,
					calls: inputs.toolCalls,
					nowMs: inputs.nowMs,
				})
	const masks = maskLabels(visible)
	const headHint = [
		prepared.prefix === "" ? undefined : `all start “${prepared.prefix.trim()}”`,
		prepared.errorType === undefined ? undefined : `error.type ${prepared.errorType}`,
	]
		.filter((part) => part !== undefined)
		.join(" · ")
	const isEmpty = !inputs.isLoading && inputs.failure === undefined && inputs.rows.length === 0
	const { startMs, endMs } = inputs.range
	return h.section(
		[h.AriaLabel("Errors"), h.Class("@container/panel min-w-0 border-b border-border px-6 pt-5 pb-4")],
		[
			h.div(
				[h.Class("flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 pb-3 font-mono")],
				[
					h.div(
						[h.Class("flex items-baseline gap-2.5")],
						[
							h.span([h.Class("text-xs font-medium text-foreground")], ["Errors"]),
							inputs.isLoading
								? skeleton(h, "h-2.5 w-36 self-center")
								: h.span(
										[
											h.Class(
												"text-2xs leading-3.5 tabular-nums text-foreground-subtle",
											),
										],
										[
											formatToolCount(failures),
											" failed ",
											pluralize(failures, "call"),
											...(inputs.rows.length > 0
												? [
														` · ${formatToolCount(inputs.rows.length)} ${pluralize(inputs.rows.length, "error")}`,
													]
												: []),
										],
									),
						],
					),
					...(status === undefined
						? []
						: [
								failureStatusLine(h, {
									status,
									scope: "tool",
									timeZone: inputs.timeZone,
									nowMs: inputs.nowMs,
									calls: inputs.toolCalls,
									failures,
								}),
							]),
				],
			),
			isEmpty
				? h.div(
						[
							h.Class(
								"flex flex-col gap-2 border-t border-border px-2.5 py-5 font-mono",
							),
						],
						[
							h.span(
								[h.Class("flex items-center gap-2 text-xs text-foreground")],
								[
									statusDot(h, { tone: "ok" }),
									"No failed calls between",
									" ",
									windowRangeLabel(startMs, startMs, inputs.timeZone),
									" and",
									" ",
									windowRangeLabel(endMs, endMs, inputs.timeZone),
								],
							),
							h.span(
								[h.Class("pl-3.5 text-xs text-muted-foreground")],
								[
									inputs.toolCalls > 0
										? `All ${formatToolCount(inputs.toolCalls)} ${inputs.tool} ${pluralize(inputs.toolCalls, "call")} in this range succeeded.`
										: `${inputs.tool} was not called in this range.`,
								],
							),
						],
					)
				: toolTable(h, [
						head(h, inputs, headHint),
						toolTableBody(
							h,
							inputs.failure !== undefined
								? [
										errorState(h, {
											failure: inputs.failure,
											title: `Couldn't load ${inputs.tool} errors`,
										}),
									]
								: inputs.isLoading
									? loadingRows(h)
									: [
											...visible.map((row) =>
												errorRow(h, row, inputs, maxShare, prepared.errorType),
											),
											...(hidden.length > 0
												? [showMore(h, hidden, inputs.isExpanded)]
												: []),
										],
							{ isWaiting: inputs.isWaiting },
						),
						...(masks.length > 0 && !inputs.isLoading
							? [
									h.div(
										[
											h.Class(
												"flex flex-wrap items-center gap-2 border-t border-border px-2.5 pt-3 font-mono text-2xs leading-3.5 text-foreground-subtle",
											),
										],
										[
											h.span(
												[],
												[
													"Calls with the same message are grouped; changing values are masked:",
												],
											),
											...masks.map((label) =>
												h.span(
													[h.Key(label), h.Class("flex items-center gap-1.5")],
													[
														maskChip(h, label, "", "text-2xs leading-3.5"),
														h.span([], [MASK_MEANINGS.get(label) ?? ""]),
													],
												),
											),
										],
									),
								]
							: []),
					]),
		],
	)
}
