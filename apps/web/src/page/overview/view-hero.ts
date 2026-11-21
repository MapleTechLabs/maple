import { pluralize } from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { card, cardPanel } from "@maple/views/ui/card"
import { statusDot } from "@maple/views/ui/status-dot"
import { typography } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"
import { textLink } from "@maple/views/ui/text-link"
import { alertsHref, ruleHref } from "../kit/alert-links"
import { Array as Arr, Order, Record as Rec } from "effect"
import type { HealthIncident } from "../kit/service-health"

// The one-line alert strip above the health rail; nothing when all is clear.
// It names what fires, rule by rule; open anomalies count apart and stay quiet.

/** One rule with open incidents: its worst severity and how many of its groups are open. */
export type FiringRule = Readonly<{
	ruleId: string
	ruleName: string
	severity: HealthIncident["severity"]
	openGroups: number
}>

export type HeroSummary = Readonly<{
	/** Rules with open incidents, anomaly rules' excluded: critical first, then most groups, then name. */
	firing: ReadonlyArray<FiringRule>
	/** Open incidents of anomaly rules. */
	anomalyCount: number
	rulesEnabled: number
	/** Firing rules that are enabled; a disabled rule's incident lingers until its resolve syncs. */
	enabledFiring: number
}>

/** Rules the strip names before "+N more". */
const NAMED_RULES = 2

const byUrgency = Order.combineAll<FiringRule>([
	Order.mapInput(Order.Boolean, (rule) => rule.severity !== "critical"),
	Order.mapInput(Order.flip(Order.Number), (rule) => rule.openGroups),
	Order.mapInput(Order.String, (rule) => rule.ruleName),
])

/** The strip's rules from the alert incidents and the enabled rules' ids. Anomaly rules' incidents are open anomalies. */
export const heroSummaryOf = (
	incidents: ReadonlyArray<HealthIncident>,
	enabledRuleIds: ReadonlyArray<string>,
): HeroSummary => {
	const openAll = Arr.filter(incidents, (incident) => incident.status === "open")
	const open = Arr.filter(openAll, (incident) => incident.signalType !== "anomaly")
	const firing = Arr.map(
		Rec.values(Arr.groupBy(open, (incident) => incident.ruleId)),
		(group): FiringRule => {
			const first = Arr.headNonEmpty(group)
			return {
				ruleId: first.ruleId,
				ruleName: first.ruleName,
				severity: Arr.some(group, (incident) => incident.severity === "critical")
					? "critical"
					: "warning",
				openGroups: group.length,
			}
		},
	)
	const enabled = new Set(enabledRuleIds)
	return {
		firing: Arr.sort(firing, byUrgency),
		anomalyCount: openAll.length - open.length,
		rulesEnabled: enabled.size,
		enabledFiring: Arr.filter(firing, (rule) => enabled.has(rule.ruleId)).length,
	}
}

const dotToneOf = (severity: FiringRule["severity"]) => (severity === "critical" ? "crit" : "warn")
const textToneOf = (severity: FiringRule["severity"]) => (severity === "critical" ? "error" : "warning")

// Anomalies are hints, not pages: a quiet link to the inbox, never a tinted card of their own.
const anomalyLink = <M>(h: HtmlBuilder<M>, count: number): Html =>
	textLink(h, { href: alertsHref({ signal: "anomaly" }), tone: "muted", className: "shrink-0 text-xs" }, [
		statusDot(h, { tone: "warn" }),
		`${count} ${pluralize(count, "open anomaly", "open anomalies")} →`,
	])

/** A firing rule: its name to its page, then its severity and, past one, its open groups. */
const ruleItem = <M>(h: HtmlBuilder<M>, rule: FiringRule): Html =>
	hstack(h, { gap: "1.5", shrink: true, className: "min-w-0" }, [
		textLink(h, { href: ruleHref(rule.ruleId), tone: "inherit", className: "min-w-0" }, [
			typography(h, { size: "sm", weight: "medium", truncate: true }, [rule.ruleName]),
		]),
		typography(h, { size: "xs", tone: "muted", numeric: true, className: "shrink-0" }, [
			typography(h, { tone: textToneOf(rule.severity) }, [rule.severity]),
			...(rule.openGroups > 1 ? [` · ${rule.openGroups} groups`] : []),
		]),
	])

/** "2 of 19 enabled rules firing", counting only enabled rules; "View alerts" when none of them fire. */
const firingShare = (summary: HeroSummary): string =>
	summary.enabledFiring > 0
		? `${summary.enabledFiring} of ${summary.rulesEnabled} enabled ${pluralize(summary.rulesEnabled, "rule")} firing`
		: "View alerts"

const firingStrip = <M>(
	h: HtmlBuilder<M>,
	firing: Arr.NonEmptyReadonlyArray<FiringRule>,
	summary: HeroSummary,
): Html => {
	const worst = Arr.headNonEmpty(firing).severity
	const named = Arr.take(firing, NAMED_RULES)
	const rest = firing.length - named.length
	const inbox = alertsHref({})
	return card(
		h,
		[
			cardPanel(
				h,
				[
					hstack(h, { gap: "2", shrink: true, wrap: true, className: "min-w-0 gap-y-1" }, [
						statusDot(h, { tone: dotToneOf(worst) }),
						typography(h, { size: "sm", weight: "medium", tone: textToneOf(worst) }, [
							"Firing now",
						]),
						hstack(h, { gap: "4", shrink: true, wrap: true, className: "min-w-0 gap-y-1" }, [
							...Arr.map(named, (rule) => ruleItem(h, rule)),
							...(rest > 0
								? [
										textLink(
											h,
											{ href: inbox, tone: "muted", className: "shrink-0 text-xs" },
											[`+${rest} more`],
										),
									]
								: []),
						]),
					]),
					hstack(h, { gap: "4", className: "ml-auto" }, [
						...(summary.anomalyCount > 0 ? [anomalyLink(h, summary.anomalyCount)] : []),
						textLink(h, { href: inbox, tone: "muted", className: "shrink-0 text-xs" }, [
							`${firingShare(summary)} →`,
						]),
					]),
				],
				"flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2",
			),
		],
		worst === "critical"
			? "border-severity-error-a3 bg-severity-error-a1"
			: "border-severity-warn-a3 bg-severity-warn-a1",
	)
}

/**
 * The alert strip, absent when all clear. Firing rules get a card toned by the worst of them; open
 * anomalies (anomaly rules' incidents, never firing) are a muted link beside it, or alone on a line when nothing fires.
 */
export const alertFiringHero = <M>(h: HtmlBuilder<M>, summary: HeroSummary): ReadonlyArray<Html> => {
	if (Arr.isReadonlyArrayNonEmpty(summary.firing)) return [firingStrip(h, summary.firing, summary)]
	if (summary.anomalyCount > 0)
		return [hstack(h, { justify: "end" }, [anomalyLink(h, summary.anomalyCount)])]
	return []
}
