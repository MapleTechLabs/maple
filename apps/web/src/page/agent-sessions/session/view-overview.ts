import {
	buildSessionChecks,
	type SessionSummary,
	type SessionToolCall,
	type SessionToolUsage,
} from "@maple/agent-sessions"
import { buildSessionAxis, type SessionAxis } from "../../../lib/agent-sessions/session-axis"
import { formatDuration, formatNumber } from "@maple/ui/lib/format"
import { formatSessionDuration } from "@maple/ui/lib/replay-format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { separator } from "@maple/views/ui/display"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import { keyValue, keyValueList } from "@maple/views/ui/key-value"
import { pressable } from "@maple/views/ui/pressable"
import { truncatedText } from "@maple/views/ui/truncated-text"
import { detectLookup } from "../kit/detected-models"
import type { LoadProgress, SessionData } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { sessionChecks } from "./view-checks"
import { disclosureChevron } from "./view-kit"
import { sectionHeading } from "../../kit/section-heading"
import { loadIndicator } from "./view-load"
import { rail } from "./view-rail"
import { errorChip, TOOL_CHIP } from "../kit/error-chip"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"

// The session overview: checks and the tool ledger, the rail.

type H = HtmlBuilder<Message>

const LEDGER_NAME = "w-44 min-w-0 shrink-0"
const LEDGER_COUNT = "w-11 shrink-0 text-right"
const LEDGER_TIME = "w-16 shrink-0 text-right"

const callWhen = (event: SessionToolCall, sessionStartMs: number): string => {
	const offsetMs = event.startMs - sessionStartMs
	const at = `${offsetMs <= 0 ? "0s" : formatSessionDuration(offsetMs)} in, ${formatDuration(event.durationMs)}`
	return event.turnIndex === undefined ? at : `turn ${event.turnIndex}, ${at}`
}

const callTitle = (toolName: string, event: SessionToolCall, sessionStartMs: number): string => {
	const where = `${toolName} — ${callWhen(event, sessionStartMs)}`
	return event.failed ? `${where} — ${event.errorLabel ?? "error"}` : where
}

const openSpan = (model: Model, spanId: string) =>
	Message.ClickedSpan({ spanId: model.search.span === spanId ? undefined : spanId })

const ledgerHeader = (h: H, summary: SessionSummary): Html => {
	const calls = Arr.reduce(summary.tools, 0, (total, tool) => total + tool.calls)
	const failed = Arr.reduce(summary.tools, 0, (total, tool) => total + tool.failed)
	const toolMs = Arr.reduce(summary.tools, 0, (total, tool) => total + tool.totalMs)
	return h.div(
		[h.Class("flex flex-wrap items-baseline justify-between gap-x-5 gap-y-2")],
		[
			sectionHeading(h, { variant: "eyebrow", as: "h3", title: "Tools", className: "mb-0" }),
			...(summary.tools.length > 0
				? [
						hstack(h, { align: "baseline", wrap: true, className: "gap-x-4 gap-y-1" }, [
							keyValueList(h, { layout: "inline" }, [
								keyValue(
									h,
									{ label: "Distinct", mono: true, valueClassName: "font-semibold" },
									[formatNumber(summary.tools.length)],
								),
								keyValue(h, { label: "Calls", mono: true, valueClassName: "font-semibold" }, [
									formatNumber(calls),
								]),
								keyValue(
									h,
									{
										label: "Tool time",
										mono: true,
										valueClassName: "font-semibold text-chart-4",
									},
									[formatDuration(toolMs)],
								),
							]),
							...(failed > 0
								? [
										errorChip(h, {
											iconName: "GearIcon",
											count: failed,
											noun: "failed call",
											className: TOOL_CHIP,
										}),
									]
								: []),
						]),
					]
				: []),
		],
	)
}

const ledgerColumns = (h: H, axis: SessionAxis): Html =>
	eyebrow(h, { as: "div", className: "flex items-end gap-4 border-border border-b pb-2" }, [
		h.span([h.Class(LEDGER_NAME)], ["Tool"]),
		h.span([h.Class(LEDGER_COUNT)], ["Calls"]),
		h.span([h.Class(LEDGER_COUNT)], ["Fail"]),
		h.span([h.Class(LEDGER_TIME)], ["Total"]),
		h.span([h.Class(LEDGER_TIME)], ["Slowest"]),
		h.span(
			[h.Class("relative h-3.5 min-w-0 grow")],
			Arr.flatMap(axis.ticks, (tick) =>
				tick.fraction === 0
					? []
					: [
							h.span(
								[
									h.Key(tick.label),
									h.Class(
										cn(
											"absolute top-0 whitespace-nowrap font-mono font-normal text-3xs normal-case tracking-normal",
											tick.fraction < 0.92 && "-translate-x-1/2",
										),
									),
									h.Style(
										tick.fraction < 0.92
											? { left: `${tick.fraction * 100}%` }
											: { right: `${(1 - tick.fraction) * 100}%` },
									),
								],
								[tick.label],
							),
						],
			),
		),
	])

const callLane = (
	h: H,
	model: Model,
	tool: SessionToolUsage,
	axis: SessionAxis,
	sessionStartMs: number,
): Html =>
	h.span(
		[h.Class("relative h-6 min-w-0 grow")],
		[
			h.span([h.AriaHidden(true), h.Class("absolute top-1/2 left-0 h-px w-full bg-border")], []),
			...Arr.map(tool.events, (event) =>
				pressable(
					h,
					{
						onClick: openSpan(model, event.spanId),
						className: cn(
							"absolute rounded-2xs",
							event.failed ? "top-[5px] h-3.5 bg-severity-error" : "top-[7px] h-2.5 bg-chart-4",
						),
						attributes: [
							h.Key(event.spanId),
							h.AriaHasPopup("dialog"),
							h.Style({
								left: `min(${axis.fraction(event.startMs) * 100}%, 100% - 3px)`,
								width: `max(3px, ${(event.durationMs / axis.totalMs) * 100}%)`,
							}),
							h.Title(callTitle(tool.name, event, sessionStartMs)),
						],
					},
					[h.span([h.Class("sr-only")], [callTitle(tool.name, event, sessionStartMs)])],
				),
			),
		],
	)

const failedCallRow = (h: H, model: Model, event: SessionToolCall, sessionStartMs: number): Html =>
	h.div(
		[
			h.Key(event.spanId),
			h.Class(
				"flex flex-wrap items-baseline gap-x-3 gap-y-1 border-severity-error border-l-2 bg-severity-error/[0.06] py-1.5 pr-2 pl-2.5",
			),
		],
		[
			h.span(
				[h.Class("font-medium font-mono text-severity-error text-xs")],
				[event.errorLabel ?? "error"],
			),
			typography(h, { size: "xs", tone: "muted", mono: true }, [callWhen(event, sessionStartMs)]),
			...(event.errorDetail === undefined
				? []
				: [typography(h, { size: "xs", tone: "muted", className: "min-w-0" }, [event.errorDetail])]),
			button(
				h,
				{
					variant: "link",
					size: "sm",
					className: "ml-auto h-auto p-0 text-xs",
					attributes: [h.AriaHasPopup("dialog"), h.OnClick(openSpan(model, event.spanId))],
				},
				["Open span", icon(h, "ArrowRightIcon")],
			),
		],
	)

const ledgerRow = (
	h: H,
	model: Model,
	tool: SessionToolUsage,
	axis: SessionAxis,
	sessionStartMs: number,
): Html => {
	const failures = Arr.filter(tool.events, (event) => event.failed)
	const isDisclosable = tool.description !== undefined || failures.length > 0
	const isExpanded = model.ledgerOpen === tool.name
	return h.div(
		[h.Key(tool.name), h.Class(cn("flex flex-col", tool.failed > 0 && "bg-severity-error/[0.06]"))],
		[
			h.div(
				[h.Class("flex h-6 items-center gap-4")],
				[
					isDisclosable
						? pressable(
								h,
								{
									onClick: Message.ToggledLedgerTool({ name: tool.name }),
									className: cn(
										LEDGER_NAME,
										"flex items-center gap-1.5 text-left hover:text-primary active:text-primary",
									),
									attributes: [h.AriaExpanded(isExpanded)],
								},
								[
									disclosureChevron(h, { isOpen: isExpanded, size: 9 }),
									truncatedText(h, { text: tool.name, mono: true, className: "text-xs" }),
								],
							)
						: truncatedText(h, {
								text: tool.name,
								mono: true,
								className: cn(LEDGER_NAME, "pl-[15px] text-xs"),
							}),
					h.span(
						[
							h.Class(
								cn(LEDGER_COUNT, typographyClass({ size: "xs", mono: true, numeric: true })),
							),
						],
						[String(tool.calls)],
					),
					h.span(
						[
							h.Class(
								cn(
									LEDGER_COUNT,
									typographyClass({ size: "xs", mono: true, numeric: true }),
									tool.failed > 0 ? "text-severity-error" : "text-foreground-faint",
								),
							),
						],
						[String(tool.failed)],
					),
					h.span(
						[
							h.Class(
								cn(LEDGER_TIME, typographyClass({ size: "xs", mono: true, numeric: true })),
							),
						],
						[formatDuration(tool.totalMs)],
					),
					h.span(
						[
							h.Class(
								cn(
									LEDGER_TIME,
									typographyClass({ size: "xs", tone: "muted", mono: true, numeric: true }),
								),
							),
						],
						[formatDuration(tool.slowestMs)],
					),
					callLane(h, model, tool, axis, sessionStartMs),
				],
			),
			...(isExpanded
				? [
						h.div(
							[h.Class("flex flex-col gap-2 py-2 pr-3 pl-[15px]")],
							[
								...(tool.description === undefined
									? []
									: [
											h.p(
												[
													h.Class(
														"max-w-[70ch] text-muted-foreground text-xs leading-relaxed",
													),
												],
												[tool.description],
											),
										]),
								...Arr.map(failures, (event) =>
									failedCallRow(h, model, event, sessionStartMs),
								),
							],
						),
					]
				: []),
		],
	)
}

const toolUsage = (h: H, model: Model, summary: SessionSummary): Html => {
	const axis = buildSessionAxis({ startMs: summary.startMs, endMs: summary.endMs, collapsedGaps: [] })
	return h.section(
		[h.Class("flex scroll-mt-14 flex-col gap-3"), h.DataAttribute("session-tools", "")],
		[
			ledgerHeader(h, summary),
			summary.tools.length === 0
				? typography(h, { size: "xs", tone: "muted", as: "p" }, ["no tool calls"])
				: h.div(
						[h.Class("flex flex-col")],
						[
							ledgerColumns(h, axis),
							...Arr.map(summary.tools, (tool) =>
								ledgerRow(h, model, tool, axis, summary.startMs),
							),
						],
					),
		],
	)
}

const waiting = (h: H, model: Model, progress: LoadProgress): Html =>
	h.div(
		[
			h.DataAttribute("testid", "overview-waiting"),
			h.Class("flex grow flex-col items-center justify-center gap-3 py-16 text-center"),
		],
		[
			typography(h, { size: "sm", tone: "muted", as: "p" }, [
				"The overview reads the whole session, and this one is still arriving.",
			]),
			loadIndicator(h, model, progress, "items-center"),
			typography(h, { size: "xs", tone: "subtle", as: "p" }, [
				"The Traces, Flow and Transcript views already show what has loaded.",
			]),
		],
	)

export const overview = (h: H, model: Model, data: SessionData): Html => {
	if (data.progress !== undefined && !data.progress.agentSpansComplete)
		return waiting(h, model, data.progress)
	const checks = buildSessionChecks(data.turns, data.summary)
	return h.div(
		[h.Class("@container flex grow flex-col pt-5 pb-10")],
		[
			h.div(
				[h.Class("flex flex-col gap-8 @4xl:flex-row @4xl:gap-8")],
				[
					h.div(
						[h.Class("flex min-w-0 grow flex-col gap-6")],
						[
							sessionChecks(h, model, checks),
							separator(h, "horizontal", undefined),
							toolUsage(h, model, data.summary),
						],
					),
					rail(h, data.summary, detectLookup(model.detections)),
				],
			),
		],
	)
}
