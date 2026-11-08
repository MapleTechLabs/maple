import { pluralize } from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { card, cardPanel } from "@maple/views/ui/card"
import { statusDot } from "@maple/views/ui/status-dot"
import { typography } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"
import { textLink } from "@maple/views/ui/text-link"
import { alertsHref } from "../alerts/shared/links"
import { Array as Arr } from "effect"
import type { Incident } from "./model"

// The one-line alert strip above the health rail; nothing when all is clear.
// Open anomalies count apart from firing incidents and stay quiet.

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

/** The strip's counts from the alert incidents and each rule's `enabled`. Anomaly rules' incidents are open anomalies. */
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

const joinParts = (parts: ReadonlyArray<string>): string =>
	Arr.join(
		Arr.filter(parts, (part) => part !== ""),
		" · ",
	)

const countOf = (count: number, singular: string, plural?: string): string =>
	count > 0 ? `${count} ${pluralize(count, singular, plural)}` : ""

// Anomalies are hints, not pages: a quiet link to the inbox, never a tinted card of their own.
const anomalyLink = <M>(h: HtmlBuilder<M>, count: number): Html =>
	textLink(h, { href: alertsHref({ signal: "anomaly" }), tone: "muted", className: "shrink-0 text-xs" }, [
		statusDot(h, { tone: "warn" }),
		`${countOf(count, "open anomaly", "open anomalies")} →`,
	])

const rulesCount = <M>(h: HtmlBuilder<M>, counts: HeroCounts): Html =>
	typography(h, { size: "xs", tone: "muted", numeric: true, className: "shrink-0" }, [
		typography(h, { tone: "foreground", weight: "medium" }, [String(counts.rulesEnabled)]),
		typography(h, { tone: "subtle" }, ["/"]),
		`${counts.rulesTotal} rules`,
	])

const firingStrip = <M>(h: HtmlBuilder<M>, counts: HeroCounts): Html =>
	card(
		h,
		[
			cardPanel(
				h,
				[
					hstack(h, { gap: "2", shrink: true }, [
						statusDot(h, { tone: "crit" }),
						typography(h, { size: "sm", truncate: true }, [
							typography(h, { weight: "medium", className: "text-severity-error" }, [
								"Firing now:",
							]),
							typography(h, { tone: "muted", className: "ml-1" }, [
								joinParts([
									countOf(counts.openCount, "incident"),
									countOf(counts.criticalCount, "critical", "critical"),
									countOf(counts.warningCount, "warning"),
								]),
							]),
						]),
					]),
					hstack(h, { gap: "4", shrink: true }, [
						...(counts.anomalyCount > 0 ? [anomalyLink(h, counts.anomalyCount)] : []),
						rulesCount(h, counts),
					]),
				],
				"flex items-center justify-between gap-4 px-4 py-2",
			),
		],
		"border-severity-error-a3 bg-severity-error/[0.04]",
	)

/**
 * The alert strip, absent when all clear. Firing incidents get the red card; open anomalies (anomaly
 * rules' incidents, never firing) are a muted link beside it, or alone on a line when nothing fires.
 */
export const alertFiringHero = <M>(h: HtmlBuilder<M>, counts: HeroCounts): ReadonlyArray<Html> => {
	if (counts.openCount > 0) return [firingStrip(h, counts)]
	if (counts.anomalyCount > 0) return [hstack(h, { justify: "end" }, [anomalyLink(h, counts.anomalyCount)])]
	return []
}
