import { pluralize } from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { card, cardPanel } from "../../ui/card"
import { eyebrow } from "../../ui/eyebrow"
import { statusDot } from "../../ui/status-dot"
import { typography } from "../../ui/typography"
import { hstack } from "../../ui/stack"

// The firing-alerts hero, without the last-evaluated hint.

export type HeroCounts = Readonly<{
	openCount: number
	criticalCount: number
	warningCount: number
	rulesEnabled: number
	rulesTotal: number
}>

const PANEL = "flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-3.5"

const allClear = <M>(h: HtmlBuilder<M>, counts: HeroCounts): Html =>
	card(h, [
		cardPanel(
			h,
			[
				hstack(h, { gap: "3", shrink: true }, [
					statusDot(h, { tone: "ok", size: "lg" }),
					h.div(
						[h.Class("flex flex-wrap items-baseline gap-x-2 gap-y-0.5")],
						[
							h.span([h.Class("text-base font-semibold tracking-tight")], ["All clear"]),
							typography(h, { size: "sm", tone: "muted" }, [
								typography(h, { tone: "foreground", weight: "medium", numeric: true }, [
									String(counts.rulesEnabled),
								]),
								h.span([h.Class("text-foreground-subtle")], [" / "]),
								h.span([h.Class("tabular-nums")], [String(counts.rulesTotal)]),
								h.span([h.Class("ml-1")], ["rules watching"]),
							]),
						],
					),
				]),
			],
			PANEL,
		),
	])

const rulesSummary = <M>(h: HtmlBuilder<M>, counts: HeroCounts): Html =>
	h.span(
		[h.Class("tabular-nums")],
		[
			typography(h, { tone: "foreground", weight: "medium" }, [String(counts.rulesEnabled)]),
			h.span([h.Class("text-foreground-subtle")], ["/"]),
			h.span([], [String(counts.rulesTotal)]),
			h.span([h.Class("ml-1")], ["rules"]),
		],
	)

const firing = <M>(h: HtmlBuilder<M>, counts: HeroCounts): Html => {
	const label =
		[
			counts.criticalCount > 0 ? `${counts.criticalCount} critical` : "",
			counts.warningCount > 0 ? `${counts.warningCount} warning` : "",
		]
			.filter((part) => part !== "")
			.join(" · ") || `${counts.openCount} open`
	return card(
		h,
		[
			cardPanel(
				h,
				[
					hstack(h, { gap: "3", shrink: true }, [
						statusDot(h, { tone: "crit", size: "lg" }),
						h.div(
							[h.Class("flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5")],
							[
								eyebrow(h, { variant: "label", className: "text-severity-error" }, [
									"Firing now",
								]),
								hstack(h, { gap: "1.5", align: "baseline", as: "span" }, [
									h.span(
										[
											h.Class(
												"text-severity-error text-2xl font-semibold tabular-nums leading-none",
											),
										],
										[String(counts.openCount)],
									),
									typography(h, { size: "sm", tone: "muted" }, [
										pluralize(counts.openCount, "incident"),
									]),
								]),
								h.span([h.Class("text-foreground-faint")], ["·"]),
								typography(h, { size: "sm", tone: "muted" }, [label]),
							],
						),
					]),
					h.div(
						[h.Class("text-muted-foreground flex shrink-0 items-center gap-2 text-xs")],
						[rulesSummary(h, counts)],
					),
				],
				PANEL,
			),
		],
		"border-severity-error-a3 bg-severity-error/[0.04]",
	)
}

export const alertFiringHero = <M>(h: HtmlBuilder<M>, counts: HeroCounts): Html =>
	counts.openCount > 0 ? firing(h, counts) : allClear(h, counts)
