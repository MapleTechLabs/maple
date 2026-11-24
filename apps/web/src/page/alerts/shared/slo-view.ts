import type { Tone } from "@maple/ui/lib/tone"
import type { AlertIncidentRow } from "@maple/web-data/collections/alerts"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { infoHint } from "@maple/views/ui/info-hint"
import { meter } from "@maple/views/ui/meter"
import { hstack } from "@maple/views/ui/stack"
import { typography, type TypographyTone } from "@maple/views/ui/typography"
import { alertStatusBadge } from "./badges"
import {
	budgetTone,
	formatBudget,
	NO_DATA_HINT,
	openBudgetIncident,
	openBurnIncident,
	type Slo,
} from "./slo-derive"

/** "No data" with its hint, where a figure would be: the SLO's window counted no events. */
export const noDataLabel = <M>(h: HtmlBuilder<M>, className?: string): Html =>
	hstack(h, { gap: "1.5", className }, [
		typography(h, { size: "xs", tone: "muted" }, ["No data"]),
		infoHint(h, NO_DATA_HINT),
	])

/**
 * Budget left as a short bar and its percent; an overspent budget shows an empty red bar. `null`
 * (no events to measure against, see `budgetLeft`) reads "No data", never a full bar. `tone`
 * overrides the budget's own (`budgetToneOf`: neutral when too few events say it is spent).
 */
export const budgetBar = <M>(
	h: HtmlBuilder<M>,
	budget: number | null,
	options: Readonly<{ className?: string; tone?: Tone }> = {},
): Html => {
	const { className } = options
	if (budget === null) return noDataLabel(h, className)
	const tone = options.tone ?? budgetTone(budget)
	return hstack(h, { gap: "2", className }, [
		meter(h, {
			value: Math.max(0, Math.min(1, budget)),
			tone,
			minVisible: 0,
			label: `${formatBudget(budget)} of the error budget left`,
			className: "w-16 shrink-0",
		}),
		typography(h, { size: "xs", numeric: true, tone: toneText(tone) }, [formatBudget(budget)]),
	])
}

/** The typography tone of a severity tone: red and amber, anything else the default ink. */
export const toneText = (tone: Tone): TypographyTone | undefined =>
	tone === "crit" ? "error" : tone === "warn" ? "warning" : undefined

/**
 * "Incident open" while a burn incident is, "Budget spent" while only the budget one is, else
 * whether alerting is on.
 */
export const alertingState = <M>(
	h: HtmlBuilder<M>,
	slo: Pick<Slo, "alert_rule_id" | "alerting">,
	incidents: ReadonlyArray<AlertIncidentRow>,
): Html =>
	Option.isSome(openBurnIncident(slo, incidents))
		? alertStatusBadge(h, "firing", { label: "Incident open" })
		: Option.isSome(openBudgetIncident(slo, incidents))
			? alertStatusBadge(h, "pending", { label: "Budget spent" })
			: slo.alerting.enabled
				? alertStatusBadge(h, "ok", { label: "Alerting on" })
				: alertStatusBadge(h, "disabled", { label: "Alerting off" })
