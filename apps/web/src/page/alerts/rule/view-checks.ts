import type { AlertCheckDocument, AlertRuleDocument } from "@maple/domain/http"
import { countLabel, EMPTY_VALUE, formatNumber } from "@maple/ui/lib/format"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { tableCellStyles } from "@maple/ui/styles/ui/table"
import { formatSignalValue } from "@maple/web-data/alerts/form-utils"
import { formatTimeInTimezone, formatTimestampInTimezone } from "@maple/web-data/lib/timezone-format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { badge } from "../../../ui/display"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../ui/empty"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import { segmentedSelect } from "../../../ui/segmented-select"
import { skeleton } from "../../../ui/skeleton"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import { truncatedText } from "../../../ui/truncated-text"
import { docsLink } from "../../kit/signal-empty-state"
import { statRail, statRailItem } from "../../kit/stat-rail"
import { alertStatusBadge } from "../shared/badges"
import { Message } from "./message"
import type { CheckStatusFilter, ChecksResponse, Model } from "./model"
import { sectionHeading } from "../../kit/section-heading"

// `ChecksPanel` and `CheckDelta`: the rule's recent checks.

type H = HtmlBuilder<Message>

const checkKey = (check: AlertCheckDocument) => `${check.timestamp}:${check.groupKey}:${check.status}`

const formatBucketRange = (bucket: Readonly<{ start: number; end: number }>, timeZone: string): string => {
	const time = (ms: number) => formatTimeInTimezone(ms, { timeZone })
	return `${time(bucket.start)}–${time(bucket.end)}`
}

const checkDelta = (h: H, rule: AlertRuleDocument, observed: number, threshold: number, isBreached: boolean): ReadonlyArray<Html> => {
	const delta = observed - threshold
	if (!Number.isFinite(delta) || delta === 0) return []
	return [
		badge(h, { variant: isBreached ? "crit" : "muted", size: "xs", mono: true }, [
			delta > 0 ? "+" : "−",
			formatSignalValue(rule.signalType, Math.abs(delta)),
		]),
	]
}

export type ChecksPanelInputs = Readonly<{
	rule: AlertRuleDocument
	page: ChecksResponse | null
	isLoading: boolean
	timeZone: string
}>

export const checksPanel = (h: H, model: Model, inputs: ChecksPanelInputs): Html => {
	const { rule, timeZone } = inputs
	if (inputs.isLoading)
		return h.div(
			[h.Class("space-y-4")],
			[skeleton(h, "h-24 w-full"), skeleton(h, "h-48 w-full"), skeleton(h, "h-64 w-full")],
		)
	const loaded = new Map(
		[...(inputs.page?.checks ?? []), ...model.extraChecks].map((check) => [checkKey(check), check] as const),
	)
	const loadedChecks = [...loaded.values()]
	if (loadedChecks.length === 0)
		return empty(
			h,
			[
				emptyHeader(h, [
					emptyMedia(h, { variant: "icon" }, [icon(h, "CheckIcon", { size: 18 })]),
					emptyTitle(h, ["No checks in this window"]),
					emptyDescription(h, [
						"No evaluations were recorded for the selected time range. Try widening the range, or wait for the scheduler to record the next check.",
					]),
				]),
				docsLink(h, "alertRules"),
			],
			"py-12",
		)
	const counted = loadedChecks.reduce(
		(acc, check) => ({
			breached: acc.breached + (check.status === "breached" ? 1 : 0),
			healthy: acc.healthy + (check.status === "healthy" ? 1 : 0),
			errored: acc.errored + (check.status === "error" ? 1 : 0),
			skipped: acc.skipped + (check.status === "skipped" ? 1 : 0),
			transitions: acc.transitions + (check.incidentTransition !== "none" ? 1 : 0),
		}),
		{ breached: 0, healthy: 0, errored: 0, skipped: 0, transitions: 0 },
	)
	const summary = inputs.page?.summary.totals
	const totals =
		summary === undefined
			? { ...counted, total: loadedChecks.length }
			: {
					breached: summary.breached,
					healthy: summary.healthy,
					skipped: summary.skipped,
					errored: summary.error,
					transitions: summary.transitions,
					total: summary.total,
				}
	const bucket = model.selectedBucket
	const rowSource = bucket != null ? model.bucketChecks : loadedChecks
	const filtered =
		model.checkStatusFilter === "all" ? rowSource : rowSource.filter((c) => c.status === model.checkStatusFilter)
	const times = rowSource
		.map((c) => new Date(c.timestamp).getTime())
		.filter((t) => Number.isFinite(t))
		.sort((a, b) => b - a)
	const gaps = times.slice(1).map((t, i) => (times[i] ?? t) - t).sort((a, b) => a - b)
	const medianGapMs = gaps.length === 0 ? null : (gaps[Math.floor(gaps.length / 2)] ?? null)
	const gapBefore = (index: number): number | null => {
		if (index === 0 || medianGapMs == null || medianGapMs <= 0) return null
		const prev = new Date(filtered[index - 1]?.timestamp ?? "").getTime()
		const current = new Date(filtered[index]?.timestamp ?? "").getTime()
		if (!Number.isFinite(prev) || !Number.isFinite(current)) return null
		const missing = Math.round((prev - current) / medianGapMs) - 1
		return missing >= 1 ? missing : null
	}
	const nextCursor = model.nextCursorOverride === undefined ? (inputs.page?.nextCursor ?? null) : model.nextCursorOverride
	const isGrouped = (rule.groupBy?.length ?? 0) > 0
	const filterOptions: ReadonlyArray<{ value: CheckStatusFilter; label: string }> = [
		{ value: "all", label: "All" },
		{ value: "breached", label: "Breached" },
		{ value: "healthy", label: "Healthy" },
		{ value: "skipped", label: "Skipped" },
		...(totals.errored > 0 ? [{ value: "error" as const, label: "Failed" }] : []),
	]

	return h.div(
		[h.Class("space-y-4")],
		[
			sectionHeading(h, { title: "Checks" }),
			statRail(
				h,
				{ columns: totals.errored > 0 ? 5 : 4 },
				[
					statRailItem(h, { size: "sm", eyebrow: "Total checks", value: String(totals.total) }),
					statRailItem(h, {
						size: "sm",
						eyebrow: "Breached",
						value: String(totals.breached),
						tone: totals.breached > 0 ? "crit" : "neutral",
					}),
					statRailItem(h, { size: "sm", eyebrow: "Healthy", value: String(totals.healthy), tone: "ok" }),
					...(totals.errored > 0
						? [statRailItem(h, { size: "sm", eyebrow: "Failed", value: String(totals.errored), tone: "crit" })]
						: []),
					statRailItem(h, { size: "sm", eyebrow: "Transitions", value: String(totals.transitions) }),
				],
			),
			h.div(
				[h.Class("space-y-3")],
				[
					h.div(
						[h.Class("flex flex-wrap items-end justify-between gap-x-4 gap-y-2")],
						[
							h.div(
								[h.Class("space-y-1")],
								[
									h.div(
										[h.Class("flex flex-wrap items-center gap-2")],
										[
											h.h3([h.Class("text-sm font-semibold")], ["All checks"]),
											...(bucket != null
												? [
														badge(h, { variant: "secondary", className: "gap-1.5 font-mono text-xs" }, [
															formatBucketRange(bucket, timeZone),
															iconButton(
																h,
																{
																	size: "icon-2xs",
																	label: "Clear bucket filter",
																	hasTooltip: false,
																	className: "text-muted-foreground hover:text-foreground",
																	attributes: [h.OnClick(Message.ClickedClearBucket())],
																},
																[icon(h, "XmarkIcon")],
															),
														]),
													]
												: []),
										],
									),
									h.p(
										[h.Class("text-muted-foreground text-xs")],
										[
											bucket != null
												? model.isBucketLoading
													? "Loading this bucket's evaluations…"
													: `${countLabel(model.bucketChecks.length, "evaluation")} in this bucket, nothing hidden.`
												: totals.total > loadedChecks.length
													? `Showing the latest ${loadedChecks.length} of ${totals.total} in this window; the rail above covers all of them.`
													: `All ${countLabel(totals.total, "evaluation")} in this window.`,
										],
									),
								],
							),
							segmentedSelect(h, {
								options: filterOptions,
								value: model.checkStatusFilter,
								onChange: (filter) => Message.ClickedCheckStatusFilter({ filter }),
								size: "sm",
								ariaLabel: "Filter checks",
							}),
						],
					),
					table(h, {}, [
						tableHeader(h, [
							tableRow(h, [
								tableHead(h, ["Time"], "w-[170px]"),
								tableHead(h, ["Status"], "w-[110px]"),
								tableHead(h, ["Value / threshold"]),
								tableHead(h, ["Samples"], "w-[90px]"),
								...(isGrouped ? [tableHead(h, ["Group"], "w-[160px]")] : []),
								tableHead(h, ["Incident"], "w-[140px]"),
							]),
						]),
						tableBody(
							h,
							filtered.flatMap((check, rowIndex) => {
								const skipped = gapBefore(rowIndex)
								return [
									...(skipped != null
										? [
												tableRow(
													h,
													[
														h.td(
															[
																h.Attribute("colspan", isGrouped ? "6" : "5"),
																h.Attribute(
																	"class",
																	cn(tableCellStyles, "bg-muted/40 py-1.5 text-2xs text-muted-foreground"),
																),
																h.DataAttribute("slot", "table-cell"),
															],
															[countLabel(skipped, "evaluation"), " hidden by the status filter"],
														),
													],
													"hover:bg-transparent",
												),
											]
										: []),
									checkRow(h, rule, check, isGrouped, timeZone),
								]
							}),
						),
					]),
					...(bucket == null && nextCursor !== null
						? [
								h.div(
									[h.Class("flex items-center justify-between gap-4")],
									[
										h.span(
											[h.Class("text-2xs text-muted-foreground")],
											[String(loadedChecks.length), " of ", String(totals.total), " loaded"],
										),
										button(
											h,
											{
												variant: "outline",
												size: "sm",
												isLoading: model.isLoadingMoreChecks,
												attributes: [h.OnClick(Message.ClickedLoadMoreChecks())],
											},
											["Load 100 more"],
										),
									],
								),
							]
						: []),
				],
			),
		],
	)
}

const checkRow = (h: H, rule: AlertRuleDocument, check: AlertCheckDocument, isGrouped: boolean, timeZone: string): Html => {
	const state = check.status === "breached" || check.status === "error" ? "firing" : check.status === "healthy" ? "ok" : "pending"
	const transitionTone =
		check.incidentTransition === "opened"
			? "text-severity-error"
			: check.incidentTransition === "resolved"
				? "text-severity-info"
				: check.incidentTransition === "continued"
					? "text-muted-foreground"
					: ""
	const label =
		check.status === "breached" ? "Breached" : check.status === "healthy" ? "Healthy" : check.status === "error" ? "Failed" : "Skipped"
	return tableRow(
		h,
		[
			h.td(
				[
					h.Attribute("class", cn(tableCellStyles, "font-mono text-xs")),
					h.Title(`Evaluated in ${check.evaluationDurationMs}ms`),
					h.DataAttribute("slot", "table-cell"),
				],
				[formatTimestampInTimezone(check.timestamp, { timeZone, withYear: true })],
			),
			tableCell(h, [alertStatusBadge(h, state, { label })]),
			tableCell(h, [
				check.status === "error"
					? truncatedText(h, {
							text: check.errorMessage ?? "",
							tooltip: "title",
							className: cn("max-w-[320px] text-xs", TONE_TEXT.crit),
						}, [check.errorMessage ?? "Evaluation failed"])
					: check.observedValue == null
						? h.span([h.Class("text-muted-foreground")], [EMPTY_VALUE])
						: h.div(
								[h.Class("flex items-baseline gap-2")],
								[
									h.span(
										[
											h.Class(
												cn("font-mono font-medium tabular-nums", check.status === "breached" && "text-severity-error"),
											),
										],
										[formatSignalValue(rule.signalType, check.observedValue)],
									),
									h.span(
										[h.Class("font-mono text-xs text-muted-foreground/60 tabular-nums")],
										["/", " ", formatSignalValue(rule.signalType, check.threshold)],
									),
									...checkDelta(h, rule, check.observedValue, check.threshold, check.status === "breached"),
								],
							),
			]),
			h.td(
				[
					h.Attribute("class", cn(tableCellStyles, "tabular-nums text-muted-foreground")),
					h.Title(check.sampleCount.toLocaleString("en-US")),
					h.DataAttribute("slot", "table-cell"),
				],
				[formatNumber(check.sampleCount)],
			),
			...(isGrouped
				? [
						tableCell(
							h,
							[
								h.span(
									[h.Class("block max-w-[180px] truncate"), h.Title(check.groupKey || "all")],
									[check.groupKey || "all"],
								),
							],
							"font-mono text-muted-foreground",
						),
					]
				: []),
			tableCell(h, [
				check.incidentTransition === "none"
					? h.span([h.Class("text-muted-foreground")], [EMPTY_VALUE])
					: badge(h, { variant: "outline", className: cn("text-xs capitalize", transitionTone) }, [
							check.incidentTransition,
						]),
			]),
		],
		cn(check.status === "breached" && "bg-severity-error/[0.04]", check.status === "error" && "bg-severity-warn/[0.05]"),
	)
}
