import { pluralize } from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { card, cardPanel } from "../../ui/card"
import { eyebrow } from "../../ui/eyebrow"
import { statusDot } from "../../ui/status-dot"

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
				h.div(
					[h.Class("flex min-w-0 items-center gap-3")],
					[
						statusDot(h, { tone: "ok", size: "lg" }),
						h.div(
							[h.Class("flex flex-wrap items-baseline gap-x-2 gap-y-0.5")],
							[
								h.span([h.Class("text-base font-semibold tracking-tight")], ["All clear"]),
								h.span(
									[h.Class("text-muted-foreground text-sm")],
									[
										h.span(
											[h.Class("text-foreground font-medium tabular-nums")],
											[String(counts.rulesEnabled)],
										),
										h.span([h.Class("text-muted-foreground/70")], [" / "]),
										h.span([h.Class("tabular-nums")], [String(counts.rulesTotal)]),
										h.span([h.Class("ml-1")], ["rules watching"]),
									],
								),
							],
						),
					],
				),
			],
			PANEL,
		),
	])

const rulesSummary = <M>(h: HtmlBuilder<M>, counts: HeroCounts): Html =>
	h.span(
		[h.Class("tabular-nums")],
		[
			h.span([h.Class("text-foreground font-medium")], [String(counts.rulesEnabled)]),
			h.span([h.Class("text-muted-foreground/70")], ["/"]),
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
					h.div(
						[h.Class("flex min-w-0 items-center gap-3")],
						[
							statusDot(h, { tone: "crit", size: "lg" }),
							h.div(
								[h.Class("flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5")],
								[
									eyebrow(h, { variant: "label", className: "text-severity-error" }, [
										"Firing now",
									]),
									h.span(
										[h.Class("flex items-baseline gap-1.5")],
										[
											h.span(
												[
													h.Class(
														"text-severity-error text-2xl font-semibold tabular-nums leading-none",
													),
												],
												[String(counts.openCount)],
											),
											h.span(
												[h.Class("text-muted-foreground text-sm")],
												[pluralize(counts.openCount, "incident")],
											),
										],
									),
									h.span([h.Class("text-muted-foreground/40")], ["·"]),
									h.span([h.Class("text-muted-foreground text-sm")], [label]),
								],
							),
						],
					),
					h.div(
						[h.Class("text-muted-foreground flex shrink-0 items-center gap-2 text-xs")],
						[rulesSummary(h, counts)],
					),
				],
				PANEL,
			),
		],
		"border-severity-error/30 bg-severity-error/[0.04]",
	)
}

export const alertFiringHero = <M>(h: HtmlBuilder<M>, counts: HeroCounts): Html =>
	counts.openCount > 0 ? firing(h, counts) : allClear(h, counts)
