import { pluralize } from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { card, cardPanel } from "@maple/views/ui/card"
import { statusDot } from "@maple/views/ui/status-dot"
import { typography } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"
import type { Incident } from "./model"

// The one-line alert strip above the health rail; nothing when all is clear.
// Open anomalies count apart from firing incidents.

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

type Tone = "crit" | "warn"

const TONE_TEXT = { crit: "text-severity-error", warn: "text-severity-warn" } satisfies Record<Tone, string>
const TONE_CARD = {
	crit: "border-severity-error-a3 bg-severity-error/[0.04]",
	warn: "border-severity-warn-a3 bg-severity-warn/[0.04]",
} satisfies Record<Tone, string>

const joinParts = (parts: ReadonlyArray<string>): string =>
	Arr.join(
		Arr.filter(parts, (part) => part !== ""),
		" · ",
	)

const countOf = (count: number, singular: string, plural?: string): string =>
	count > 0 ? `${count} ${pluralize(count, singular, plural)}` : ""

const strip = <M>(h: HtmlBuilder<M>, tone: Tone, title: string, detail: string, counts: HeroCounts): Html =>
	card(
		h,
		[
			cardPanel(
				h,
				[
					hstack(h, { gap: "2", shrink: true }, [
						statusDot(h, { tone }),
						typography(h, { size: "sm", truncate: true }, [
							typography(h, { weight: "medium", className: TONE_TEXT[tone] }, [title]),
							typography(h, { tone: "muted", className: "ml-1" }, [detail]),
						]),
					]),
					typography(h, { size: "xs", tone: "muted", numeric: true, className: "shrink-0" }, [
						typography(h, { tone: "foreground", weight: "medium" }, [
							String(counts.rulesEnabled),
						]),
						typography(h, { tone: "subtle" }, ["/"]),
						`${counts.rulesTotal} rules`,
					]),
				],
				"flex items-center justify-between gap-4 px-4 py-2",
			),
		],
		TONE_CARD[tone],
	)

/** The alert strip: red while incidents fire, amber when only anomalies are open, absent when all clear. */
export const alertFiringHero = <M>(h: HtmlBuilder<M>, counts: HeroCounts): ReadonlyArray<Html> =>
	counts.openCount > 0
		? [
				strip(
					h,
					"crit",
					"Firing now:",
					joinParts([
						countOf(counts.openCount, "incident"),
						countOf(counts.criticalCount, "critical", "critical"),
						countOf(counts.warningCount, "warning"),
						countOf(counts.anomalyCount, "open anomaly", "open anomalies"),
					]),
					counts,
				),
			]
		: counts.anomalyCount > 0
			? [strip(h, "warn", "Open:", countOf(counts.anomalyCount, "anomaly", "anomalies"), counts)]
			: []
