import { pluralize } from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { card, cardPanel } from "@maple/views/ui/card"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { statusDot } from "@maple/views/ui/status-dot"
import { typography } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"

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
					hstack(h, { align: "baseline", wrap: true, className: "gap-x-2 gap-y-0.5" }, [
						typography(h, { size: "base", weight: "semibold", className: "tracking-tight" }, [
							"All clear",
						]),
						typography(h, { size: "sm", tone: "muted" }, [
							typography(h, { tone: "foreground", weight: "medium", numeric: true }, [
								String(counts.rulesEnabled),
							]),
							typography(h, { tone: "subtle" }, [" / "]),
							typography(h, { numeric: true }, [String(counts.rulesTotal)]),
							h.span([h.Class("ml-1")], ["rules watching"]),
						]),
					]),
				]),
			],
			PANEL,
		),
	])

const rulesSummary = <M>(h: HtmlBuilder<M>, counts: HeroCounts): Html =>
	typography(h, { numeric: true }, [
		typography(h, { tone: "foreground", weight: "medium" }, [String(counts.rulesEnabled)]),
		typography(h, { tone: "subtle" }, ["/"]),
		h.span([], [String(counts.rulesTotal)]),
		h.span([h.Class("ml-1")], ["rules"]),
	])

const firing = <M>(h: HtmlBuilder<M>, counts: HeroCounts): Html => {
	const label =
		Arr.join(
			Arr.filter(
				[
					counts.criticalCount > 0 ? `${counts.criticalCount} critical` : "",
					counts.warningCount > 0 ? `${counts.warningCount} warning` : "",
				],
				(part) => part !== "",
			),
			" · ",
		) || `${counts.openCount} open`
	return card(
		h,
		[
			cardPanel(
				h,
				[
					hstack(h, { gap: "3", shrink: true }, [
						statusDot(h, { tone: "crit", size: "lg" }),
						hstack(h, { align: "baseline", wrap: true, className: "gap-x-2.5 gap-y-0.5" }, [
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
							typography(h, { tone: "faint" }, ["·"]),
							typography(h, { size: "sm", tone: "muted" }, [label]),
						]),
					]),
					hstack(
						h,
						{ gap: "2", align: "center", className: "text-muted-foreground shrink-0 text-xs" },
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
