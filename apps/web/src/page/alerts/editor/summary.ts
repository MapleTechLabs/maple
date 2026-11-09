import { Array as Arr, String as Str } from "effect"
import type { AlertDestinationId, EscalationChainId } from "@maple/domain/http"
import {
	comparatorSupportsTiers,
	isRangeComparator,
	RAW_QUERY_REDUCER_LABELS,
	signalLabels,
} from "@maple/web-data/alerts/form-utils"
import { anomalyScopeSummary } from "@maple/web-data/alerts/anomaly-rule"
import type { RuleCard, RuleForm } from "./form"
import { comparatorWords, conditionSubject, groupBySummary, thresholdValue, validationIssues } from "./derive"

// The rule editor's sentence cards: which card each field lives on, and each card's one-line summary.

export const RULE_CARDS: ReadonlyArray<RuleCard> = ["watch", "condition", "notify", "name"]

/** The cards an anomaly rule shows: the detector decides when, so it has no condition card. */
export const cardsOf = (form: RuleForm): ReadonlyArray<RuleCard> =>
	form.signalType === "anomaly" ? Arr.filter(RULE_CARDS, (card) => card !== "condition") : RULE_CARDS

const WATCH_ISSUES = new Set(["SQL query", "$__orgFilter in SQL", "SQL value column", "Scope"])
const NOTIFY_ISSUES = new Set(["Who gets notified", "Critical destinations"])

const cardOfIssue = (issue: string): RuleCard =>
	issue === "Rule name"
		? "name"
		: NOTIFY_ISSUES.has(issue)
			? "notify"
			: WATCH_ISSUES.has(issue) || Str.startsWith("Query:")(issue)
				? "watch"
				: "condition"

/** What blocks saving on one card, from the same list the action bar shows. */
export const cardIssues = (form: RuleForm, card: RuleCard, isDefault = false): ReadonlyArray<string> =>
	Arr.filter(validationIssues(form, isDefault), (issue) => cardOfIssue(issue) === card)

/** The cards with something missing, which stay open until it is filled in. */
export const missingCards = (form: RuleForm, isDefault = false): ReadonlyArray<RuleCard> =>
	Arr.filter(cardsOf(form), (card) => cardIssues(form, card, isDefault).length > 0)

const capitalize = (text: string): string => Str.toUpperCase(Str.slice(0, 1)(text)) + Str.slice(1)(text)

/** "a, b and c", or "a, b and 3 more" past three names. */
const listOf = (names: ReadonlyArray<string>): string => {
	if (names.length <= 1) return Arr.join(names, "")
	const shown = names.length > 3 ? Arr.take(names, 2) : Arr.take(names, names.length - 1)
	const rest = names.length > 3 ? `${names.length - 2} more` : (names[names.length - 1] ?? "")
	return `${Arr.join(shown, ", ")} and ${rest}`
}

const builtinScope = (form: RuleForm): ReadonlyArray<string> => [
	form.serviceNames.length === 0 ? "on all services" : `on ${listOf(form.serviceNames)}`,
	...(form.serviceNames.length === 0 && form.excludeServiceNames.length > 0
		? [`except ${listOf(form.excludeServiceNames)}`]
		: []),
	...(form.environments.length > 0 ? [`in ${listOf(form.environments)}`] : []),
]

/** The "When" card: the signal and what it watches. "Error rate on checkout-api in production". */
export const watchSummary = (form: RuleForm, isDefault = false): string => {
	if (form.signalType === "anomaly")
		return isDefault
			? "Every anomaly no narrower rule handles"
			: `Anomalies in ${anomalyScopeSummary(form)}`
	const groupBy = groupBySummary(form)
	const perGroup = groupBy === null ? [] : [`per ${groupBy}`]
	if (form.signalType === "raw_query")
		return `SQL query, ${Str.toLowerCase(RAW_QUERY_REDUCER_LABELS[form.rawQueryReducer])} of value`
	if (form.signalType === "builder_query") {
		const draft = form.queryBuilderDraft
		const source =
			draft.dataSource === "metrics" && draft.metricName.length > 0
				? draft.metricName
				: draft.dataSource
		const where = Str.trim(draft.whereClause)
		return Arr.join(
			[
				`${capitalize(conditionSubject(form))} of ${source}`,
				...(where.length > 0 ? [`where ${where}`] : []),
				...perGroup,
			],
			", ",
		)
	}
	return Arr.join([signalLabels[form.signalType], ...builtinScope(form), ...perGroup], " ")
}

const checksText = (form: RuleForm): string => {
	const checks = Str.trim(form.consecutiveBreachesRequired) || "?"
	const outOf = Str.trim(form.breachesOutOf)
	const windowText = `over ${Str.trim(form.windowMinutes) || "?"} min`
	if (outOf.length > 0) return `${windowText}, ${checks} of the last ${outOf} checks`
	return checks === "1" ? windowText : `${windowText}, ${checks} checks in a row`
}

/** The "Alert when" card: "Above 5%, critical above 10%, over 5 min, 3 checks in a row". */
export const conditionSummary = (form: RuleForm): string => {
	const words = Str.replace(/^is /, "")(comparatorWords(form.comparator))
	const threshold = isRangeComparator(form.comparator)
		? `${thresholdValue(form, form.threshold)} and ${thresholdValue(form, form.thresholdUpper)}`
		: thresholdValue(form, form.threshold)
	const escalation = comparatorSupportsTiers(form.comparator) ? form.escalation : null
	const healthy = Str.trim(form.consecutiveHealthyRequired)
	return Arr.join(
		[
			`${capitalize(words)} ${threshold}${escalation === null && form.severity === "critical" ? " (critical)" : ""}`,
			...(escalation === null
				? []
				: [`critical ${words} ${thresholdValue(form, escalation.threshold)}`]),
			checksText(form),
			...(healthy.length > 0 && healthy !== "1" ? [`resolves after ${healthy} healthy checks`] : []),
			...(form.alertOnNoData ? ["no data counts"] : []),
		],
		", ",
	)
}

/** How the summary names a destination and a chain; `null` for one the lists no longer hold. */
export type NotifyNames = Readonly<{
	destination: (id: AlertDestinationId) => string | null
	chain: (id: EscalationChainId) => string | null
}>

type Route = Readonly<{
	destinationIds: ReadonlyArray<AlertDestinationId>
	escalationChainId: EscalationChainId | null
}>

const routeText = (route: Route, names: NotifyNames): string | null => {
	const destinations = Arr.map(
		route.destinationIds,
		(id) => names.destination(id) ?? "a removed destination",
	)
	const chain =
		route.escalationChainId === null
			? null
			: (names.chain(route.escalationChainId) ?? "an escalation chain")
	if (destinations.length === 0) return chain === null ? null : `escalate to ${chain}`
	return chain === null ? listOf(destinations) : `${listOf(destinations)}, then escalate to ${chain}`
}

/** The "Notify" card: "#oncall, critical escalates to Checkout on-call". */
export const notifySummary = (form: RuleForm, names: NotifyNames): string => {
	const primary = routeText(form, names)
	const tiered = form.signalType === "anomaly" || comparatorSupportsTiers(form.comparator)
	// Critical pages on top of warning, so a destination already on warning is not named twice.
	const critical =
		tiered && form.escalation !== null
			? routeText(
					{
						...form.escalation,
						destinationIds: Arr.filter(
							form.escalation.destinationIds,
							(id) => !form.destinationIds.includes(id),
						),
					},
					names,
				)
			: null
	if (primary === null && critical === null) return "No one is notified"
	const criticalText =
		critical === null
			? null
			: Str.startsWith("escalate to ")(critical)
				? `critical ${Str.replace(/^escalate/, "escalates")(critical)}`
				: `critical also ${critical}`
	// Only the leading verb is capitalised: a destination keeps its own spelling ("#oncall", an email).
	const lead = (text: string) =>
		Str.startsWith("escalate")(text) || Str.startsWith("critical")(text) ? capitalize(text) : text
	if (primary === null) return lead(criticalText ?? "")
	return Arr.join(
		Arr.filter([lead(primary), criticalText], (part): part is string => part !== null),
		", ",
	)
}

/** The "Name" card: the name, then its tags. */
export const nameSummary = (form: RuleForm): string => {
	const name = Str.trim(form.name)
	const tags = form.tags.length === 0 ? [] : [listOf(form.tags)]
	return Arr.join([name.length > 0 ? name : "Unnamed rule", ...tags], " · ")
}
