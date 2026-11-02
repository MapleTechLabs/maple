import type {
	SessionCheck,
	SessionCheckStatus,
	SessionChecksReport,
	SessionCoverage,
	SessionCoverageSignal,
	SessionFinding,
} from "@maple/agent-sessions"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { icon } from "../../../ui/icon"
import { inlineCode } from "../../../ui/inline-code"
import { pressable } from "../../../ui/pressable"
import { statusDot } from "../../../ui/status-dot"
import { Message } from "./message"
import type { Model } from "./model"
import { disclosureChevron } from "./view-kit"
import { sectionHeading } from "../../kit/section-heading"

// The session checks: the verdict, what needs attention, the rest.
// Headlines and actions are sentences, so they read in the prose face; codes and values stay mono.
// TODO(tooltip): the coverage signals' explanations are drawn as their triggers.

type H = HtmlBuilder<Message>

const STATUS_TONE = { failed: "crit", warning: "warn", passed: "ok", skipped: "neutral" } as const

const STATUS_TEXT = {
	failed: TONE_TEXT.crit,
	warning: TONE_TEXT.warn,
	passed: "text-severity-info",
	skipped: TONE_TEXT.neutral,
} satisfies Record<SessionCheckStatus, string>

const ROW_GRID = "grid grid-cols-[0.75rem_9.5rem_minmax(0,1fr)] items-baseline gap-x-3"

/** `withCode`: backticked spans as code, an odd backtick count left as text. */
const withCode = (h: H, text: string): ReadonlyArray<Html | string> => {
	const parts = text.split(/`([^`]+)`/)
	if (parts.length === 1 || (text.match(/`/g)?.length ?? 0) % 2 === 1) return [text]
	return parts.map((part, index) =>
		index % 2 === 1 ? inlineCode(h, { variant: "plain", className: "text-inherit" }, [part]) : part,
	)
}

const openSpan = (model: Model, spanId: string) =>
	Message.ClickedSpan({ spanId: model.search.span === spanId ? undefined : spanId })

const verdict = (h: H, model: Model, report: SessionChecksReport): Html => {
	const failed = report.verdict.status === "failed"
	const failingSpanId = report.verdict.spanId
	return h.section(
		[h.Class("flex flex-wrap items-start justify-between gap-x-6 gap-y-3")],
		[
			h.div(
				[h.Class("flex min-w-0 flex-col gap-1")],
				[
					h.p(
						[h.Class("flex min-w-0 flex-wrap items-baseline gap-x-2 font-semibold text-base")],
						[
							// The outcome only: failing checks carry their own severity under Needs attention.
							statusDot(h, {
								size: "lg",
								tone: failed ? "crit" : "ok",
								className: "self-center",
							}),
							h.span(
								[h.Class(failed ? TONE_TEXT.crit : "text-foreground")],
								[failed ? "Failed" : "Completed"],
							),
						],
					),
				],
			),
			...(failingSpanId === undefined
				? []
				: [
						button(
							h,
							{
								variant: "outline",
								size: "sm",
								attributes: [
									h.AriaHasPopup("dialog"),
									h.OnClick(openSpan(model, failingSpanId)),
								],
							},
							["Open failing span", icon(h, "ArrowRightIcon")],
						),
					]),
		],
	)
}

const checkDot = (h: H, status: SessionCheckStatus): Html =>
	statusDot(h, {
		tone: status === "skipped" ? "custom" : STATUS_TONE[status],
		className: cn(
			"translate-y-[-1px] justify-self-center",
			status === "skipped" && "border border-muted-foreground",
		),
	})

const evidenceRow = (h: H, model: Model, finding: SessionFinding, status: SessionCheckStatus): Html =>
	pressable(
		h,
		{
			onClick: openSpan(model, finding.spanId),
			className:
				"group flex w-full items-baseline gap-2 rounded-sm px-1.5 py-0.5 text-left font-mono text-xs hover:bg-surface-sunken active:bg-surface-sunken",
			attributes: [h.AriaHasPopup("dialog")],
		},
		[
			h.span(
				[h.Class(cn("shrink-0", STATUS_TEXT[status]))],
				[finding.label, ...(finding.count > 1 ? [` ×${finding.count}`] : [])],
			),
			h.span([h.Class("shrink-0 text-foreground-subtle")], [finding.turnText]),
			...(finding.detail === undefined
				? []
				: [h.span([h.Class("min-w-0 truncate text-muted-foreground")], [finding.detail])]),
			h.span(
				[
					h.Class(
						"ml-auto flex shrink-0 items-center gap-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100",
					),
				],
				["inspect", icon(h, "ArrowRightIcon", { size: 12 })],
			),
		],
	)

const checkBlock = (h: H, model: Model, check: SessionCheck): Html => {
	const actionLine = (children: ReadonlyArray<Html | string>) =>
		h.p(
			[h.Class("flex items-start gap-1.5 font-prose text-muted-foreground text-xs leading-relaxed")],
			[
				icon(h, "ArrowRightIcon", {
					size: 12,
					className: "mt-[3px] shrink-0",
					attributes: [h.AriaHidden(true)],
				}),
				h.span([], children),
			],
		)
	return h.div(
		[h.Key(check.id), h.DataAttribute("testid", `check-${check.id}`), h.Class(cn(ROW_GRID, "py-3"))],
		[
			checkDot(h, check.status),
			h.span([h.Class("truncate font-semibold text-ui")], [check.name]),
			h.div(
				[h.Class("flex min-w-0 flex-col gap-1")],
				[
					h.p([h.Class("font-prose text-ui leading-relaxed")], withCode(h, check.headline)),
					...(check.id === "tool-errors"
						? [
								actionLine([
									"Check the",
									" ",
									button(
										h,
										{
											variant: "link",
											size: "xs",
											className:
												"h-auto p-0 align-baseline text-xs text-muted-foreground underline decoration-muted-foreground/40 hover:decoration-muted-foreground active:decoration-muted-foreground",
											attributes: [h.OnClick(Message.ClickedOpenTools())],
										},
										["Tools section"],
									),
									" ",
									"at the bottom of this page for details.",
								]),
							]
						: check.action === undefined
							? []
							: [actionLine(withCode(h, check.action))]),
					...(check.findings.length > 0
						? [
								h.div(
									[h.Class("-ml-1.5 mt-0.5 flex flex-col")],
									check.findings.map((finding) =>
										evidenceRow(h, model, finding, check.status),
									),
								),
							]
						: []),
				],
			),
		],
	)
}

const checkFact = (h: H, check: SessionCheck): Html =>
	h.div(
		[h.Key(check.id), h.Class(ROW_GRID)],
		[
			checkDot(h, check.status),
			h.span([h.Class("truncate text-ui")], [check.name]),
			h.span(
				[h.Class("min-w-0 font-prose text-muted-foreground text-xs leading-relaxed")],
				withCode(h, check.headline),
			),
		],
	)

/** `Disclosure`: Passed / Not checked, open on a clean session until the reader chooses. */
const disclosure = (
	h: H,
	options: Readonly<{
		which: "passed" | "skipped"
		title: string
		status: SessionCheckStatus
		checks: ReadonlyArray<SessionCheck>
		isOpenByDefault: boolean
		choice: boolean | null
		emptySummary: string
	}>,
): Html => {
	const isDisclosable = options.checks.length > 0
	const isExpanded = isDisclosable && (options.choice ?? options.isOpenByDefault)
	const head = [
		disclosureChevron(h, {
			isOpen: isExpanded,
			size: 12,
			className: cn(
				"translate-y-px justify-self-center text-muted-foreground",
				!isDisclosable && "invisible",
			),
		}),
		h.span(
			[h.Class("flex items-baseline gap-2")],
			[
				h.span(
					[
						h.Class(
							cn(
								"font-semibold text-ui",
								isDisclosable ? STATUS_TEXT[options.status] : "text-muted-foreground",
							),
						),
					],
					[options.title],
				),
				h.span(
					[h.Class("font-mono text-muted-foreground text-xs tabular-nums")],
					[String(options.checks.length)],
				),
			],
		),
		// Wraps so every collapsed check name stays readable.
		h.span(
			[h.Class("min-w-0 text-muted-foreground text-xs leading-relaxed")],
			[
				!isDisclosable
					? options.emptySummary
					: isExpanded
						? ""
						: options.checks.map((check) => check.name).join(" · "),
			],
		),
	]
	if (!isDisclosable) return h.div([h.Class(cn(ROW_GRID, "py-2.5"))], head)
	return h.div(
		[h.Class("flex flex-col")],
		[
			pressable(
				h,
				{
					onClick: Message.ToggledChecks({ which: options.which, isOpen: !isExpanded }),
					className: cn(ROW_GRID, "w-full py-2.5 text-left hover:bg-surface-sunken active:bg-surface-sunken"),
					attributes: [h.AriaExpanded(isExpanded)],
				},
				head,
			),
			...(isExpanded
				? [
						h.div(
							[h.Class(cn("pt-0.5 pb-3", "flex flex-col gap-1.5"))],
							options.checks.map((check) => checkFact(h, check)),
						),
					]
				: []),
		],
	)
}

const SIGNAL_MARK = {
	captured: { glyph: "✓", tone: "text-severity-info", says: "captured:" },
	missing: { glyph: "✕", tone: "text-severity-error", says: "not captured:" },
	absent: { glyph: "–", tone: "text-foreground-subtle", says: "nothing to capture:" },
} satisfies Record<SessionCoverageSignal, { glyph: string; tone: string; says: string }>

/** `coverageSignals`, labels and states only (the explanations live in the tooltips). */
const coverageSignals = (
	coverage: SessionCoverage,
): ReadonlyArray<Readonly<{ label: string; state: SessionCoverageSignal }>> => {
	const { usage, turns } = coverage
	return [
		{ label: "messages", state: coverage.messages },
		{ label: "tool args & results", state: coverage.toolPayloads },
		{
			label: usage === "absent" || usage === "none" ? "token usage" : `token usage ${usage}`,
			state: usage === "absent" ? "absent" : usage === "none" ? "missing" : "captured",
		},
		{ label: "cost", state: coverage.cost },
		{
			label:
				turns === "conversation"
					? "turns by conversation id"
					: turns === "agent-root"
						? "turns by agent root"
						: "turns by trace",
			state: turns === "conversation" || turns === "agent-root" ? "captured" : "missing",
		},
	]
}

const coverageLine = (h: H, coverage: SessionCoverage): Html =>
	h.p(
		[h.Class(cn(ROW_GRID, "text-xs"))],
		[
			h.span([], []),
			h.span([h.Class("text-muted-foreground")], ["Captured"]),
			h.span(
				[h.Class("flex flex-wrap gap-x-4 gap-y-1")],
				coverageSignals(coverage).map((signal) => {
					const mark = SIGNAL_MARK[signal.state]
					return h.span(
						[
							h.Key(signal.label),
							h.Class(
								cn(
									"flex cursor-default items-baseline gap-1.5",
									signal.state === "captured"
										? "text-muted-foreground"
										: "text-foreground-subtle",
									signal.state === "missing" && "line-through",
								),
							),
							h.DataAttribute("base-ui-tooltip-trigger", ""),
							h.DataAttribute("slot", "tooltip-trigger"),
						],
						[
							h.span([h.AriaHidden(true), h.Class(mark.tone)], [mark.glyph]),
							h.span([h.Class("sr-only")], [mark.says]),
							signal.label,
						],
					)
				}),
			),
		],
	)

export const sessionChecks = (h: H, model: Model, report: SessionChecksReport): Html => {
	const attention = report.checks.filter((check) => check.status === "failed" || check.status === "warning")
	const passed = report.checks.filter((check) => check.status === "passed")
	const skipped = report.checks.filter((check) => check.status === "skipped")
	const isClean = attention.length === 0
	return h.div(
		[h.Class("flex flex-col gap-5")],
		[
			verdict(h, model, report),
			h.section(
				[h.Class("flex flex-col gap-2")],
				[
					sectionHeading(h, {
						variant: "eyebrow",
						as: "h3",
						title: "Needs attention",
						className: "mb-0",
					}),
					isClean
						? h.p(
								[h.Class("flex items-center gap-2 py-2 font-prose text-ui")],
								[
									icon(h, "CheckIcon", {
										size: 14,
										className: "shrink-0 text-severity-info",
										attributes: [h.AriaHidden(true)],
									}),
									skipped.length === 0
										? "Nothing to fix. Every check below carries what it measured."
										: `Nothing to fix in what could be checked; ${skipped.length === 1 ? "one check" : `${skipped.length} checks`} had no signal to read.`,
								],
							)
						: h.div(
								[h.Class("flex flex-col divide-y divide-border border-border border-y")],
								attention.map((check) => checkBlock(h, model, check)),
							),
				],
			),
			h.div(
				[h.Class("flex flex-col divide-y divide-border border-border border-y")],
				[
					disclosure(h, {
						which: "passed",
						title: "Passed",
						status: "passed",
						checks: passed,
						isOpenByDefault: isClean,
						choice: model.checksChoice.passed,
						emptySummary: "Nothing passed",
					}),
					...(skipped.length > 0
						? [
								disclosure(h, {
									which: "skipped",
									title: "Not checked",
									status: "skipped",
									checks: skipped,
									isOpenByDefault: isClean,
									choice: model.checksChoice.skipped,
									emptySummary: "Every check had the signal it needed",
								}),
							]
						: []),
				],
			),
			coverageLine(h, report.coverage),
		],
	)
}
