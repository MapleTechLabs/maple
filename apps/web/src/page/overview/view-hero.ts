import { pluralize } from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { card, cardPanel } from "@maple/views/ui/card"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { statusDot } from "@maple/views/ui/status-dot"
import { typography } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"
import type { Incident } from "./model"

// The firing-alerts hero, without the last-evaluated hint. Open anomalies count apart from incidents.

export type HeroCounts = Readonly<{
	/** Open alert incidents, anomaly rules' excluded. */
	openCount: number
	criticalCount: number
	warningCount: number
	/** Open incidents of anomaly rules. */
	anomalyCount: number
	rulesEnabled: number
	rulesTotal: number
}>

/** The banner's counts from the alert incidents and each rule's `enabled`. Anomaly rules' incidents are open anomalies. */
export const heroCountsOf = (
	incidents: ReadonlyArray<Incident>,
	rules: ReadonlyArray<boolean>,
): HeroCounts => {
	const openAll = Arr.filter(incidents, (incident) => incident.status === "open")
	const open = Arr.filter(openAll, (incident) => incident.signalType !== "anomaly")
	return {
		openCount: open.length,
		criticalCount: Arr.filter(open, (incident) => incident.severity === "critical").length,
		warningCount: Arr.filter(open, (incident) => incident.severity === "warning").length,
		anomalyCount: openAll.length - open.length,
		rulesEnabled: Arr.filter(rules, (enabled) => enabled).length,
		rulesTotal: rules.length,
	}
}

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

type ActiveTone = "crit" | "warn"

const TONE_TEXT = { crit: "text-severity-error", warn: "text-severity-warn" } satisfies Record<
	ActiveTone,
	string
>
const TONE_CARD = {
	crit: "border-severity-error-a3 bg-severity-error/[0.04]",
	warn: "border-severity-warn-a3 bg-severity-warn/[0.04]",
} satisfies Record<ActiveTone, string>

type ActiveBanner = Readonly<{ tone: ActiveTone; title: string; count: number; noun: string; detail: string }>

// A banner for something open: the title, a big count and its noun, a detail, and the rules.
const active = <M>(h: HtmlBuilder<M>, banner: ActiveBanner, counts: HeroCounts): Html =>
	card(
		h,
		[
			cardPanel(
				h,
				[
					hstack(h, { gap: "3", shrink: true }, [
						statusDot(h, { tone: banner.tone, size: "lg" }),
						hstack(h, { align: "baseline", wrap: true, className: "gap-x-2.5 gap-y-0.5" }, [
							eyebrow(h, { variant: "label", className: TONE_TEXT[banner.tone] }, [
								banner.title,
							]),
							hstack(h, { gap: "1.5", align: "baseline", as: "span" }, [
								h.span(
									[
										h.Class(
											`${TONE_TEXT[banner.tone]} text-2xl font-semibold tabular-nums leading-none`,
										),
									],
									[String(banner.count)],
								),
								typography(h, { size: "sm", tone: "muted" }, [banner.noun]),
							]),
							...(banner.detail === ""
								? []
								: [
										typography(h, { tone: "faint" }, ["·"]),
										typography(h, { size: "sm", tone: "muted" }, [banner.detail]),
									]),
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
		TONE_CARD[banner.tone],
	)

const joinParts = (parts: ReadonlyArray<string>): string =>
	Arr.join(
		Arr.filter(parts, (part) => part !== ""),
		" · ",
	)

const openAnomalies = (count: number): string =>
	count > 0 ? `${count} ${pluralize(count, "open anomaly", "open anomalies")}` : ""

/**
 * Alert incidents fire; anomaly-rule incidents are open anomalies, never counted as firing.
 * Only anomalies open: an amber banner, not the red one.
 */
export const alertFiringHero = <M>(h: HtmlBuilder<M>, counts: HeroCounts): Html =>
	counts.openCount > 0
		? active(
				h,
				{
					tone: "crit",
					title: "Firing now",
					count: counts.openCount,
					noun: pluralize(counts.openCount, "incident"),
					detail: joinParts([
						joinParts([
							counts.criticalCount > 0 ? `${counts.criticalCount} critical` : "",
							counts.warningCount > 0 ? `${counts.warningCount} warning` : "",
						]) || `${counts.openCount} open`,
						openAnomalies(counts.anomalyCount),
					]),
				},
				counts,
			)
		: counts.anomalyCount > 0
			? active(
					h,
					{
						tone: "warn",
						title: "Open anomalies",
						count: counts.anomalyCount,
						noun: pluralize(counts.anomalyCount, "anomaly", "anomalies"),
						detail: "",
					},
					counts,
				)
			: allClear(h, counts)
