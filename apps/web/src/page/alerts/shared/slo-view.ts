import type { Tone } from "@maple/ui/lib/tone"
import type { AlertIncidentRow } from "@maple/web-data/collections/alerts"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { meter } from "@maple/views/ui/meter"
import { hstack } from "@maple/views/ui/stack"
import { typography, type TypographyTone } from "@maple/views/ui/typography"
import { alertStatusBadge } from "./badges"
import { budgetTone, formatBudget, openIncident, type Slo } from "./slo-derive"

// The SLO marks the tab and the detail page share: the budget bar and the alerting state.

/** Budget left as a short bar and its percent; an overspent budget shows an empty red bar. */
export const budgetBar = <M>(h: HtmlBuilder<M>, budget: number, className?: string): Html => {
	const tone = budgetTone(budget)
	return hstack(h, { gap: "2", className }, [
		meter(h, {
			value: Math.max(0, Math.min(1, budget)),
			tone,
			minVisible: 0,
			label: `${formatBudget(budget)} of the error budget left`,
			className: "w-16 shrink-0",
		}),
		typography(h, { size: "xs", mono: true, numeric: true, tone: toneText(tone) }, [
			formatBudget(budget),
		]),
	])
}

/** The typography tone of a severity tone: red and amber, anything else the default ink. */
export const toneText = (tone: Tone): TypographyTone | undefined =>
	tone === "crit" ? "error" : tone === "warn" ? "warning" : undefined

/** "Incident open" while the burn-rate rule has one, else whether alerting is on. */
export const alertingState = <M>(
	h: HtmlBuilder<M>,
	slo: Pick<Slo, "alert_rule_id" | "alerting">,
	incidents: ReadonlyArray<AlertIncidentRow>,
): Html =>
	Option.isSome(openIncident(slo, incidents))
		? alertStatusBadge(h, "firing", { label: "Incident open" })
		: slo.alerting.enabled
			? alertStatusBadge(h, "ok", { label: "Alerting on" })
			: alertStatusBadge(h, "disabled", { label: "Alerting off" })
