import { Array as Arr, String as Str } from "effect"

// Blockers that are a problem with the rule, not a field left empty: a card says them in full.
const PROBLEM_ISSUES: ReadonlyArray<string> = [
	"Check interval longer than the window",
	"Query too slow for this check interval",
]

/** Whether a blocker is a problem to fix (said as it is), not a missing field (said after "Missing:"). */
export const isProblemIssue = (issue: string): boolean => Arr.contains(PROBLEM_ISSUES, issue)
import type { AlertDestinationId, AlertQueryTiming, EscalationChainId } from "@maple/domain/http"
import {
	comparatorSupportsTiers,
	isRangeComparator,
	RAW_QUERY_REDUCER_LABELS,
	signalLabels,
} from "@maple/web-data/alerts/form-utils"
import { anomalyScopeSummary } from "@maple/web-data/alerts/anomaly-rule"
import type { RuleCard, RuleForm } from "./form"
import {
	checksPhrase,
	comparatorWords,
	conditionSubject,
	groupBySummary,
	recoveryLabel,
	saveIssues,
	thresholdValue,
} from "./derive"

// The rule editor's sentence cards: which card each field lives on, and each card's one-line summary.

export const RULE_CARDS: ReadonlyArray<RuleCard> = ["watch", "condition", "notify", "name"]

/** The cards an anomaly rule shows: the detector decides when, so it has no condition card. */
export const cardsOf = (form: RuleForm): ReadonlyArray<RuleCard> =>
	form.signalType === "anomaly" ? Arr.filter(RULE_CARDS, (card) => card !== "condition") : RULE_CARDS

const WATCH_ISSUES = new Set(["SQL query", "$__orgFilter in SQL", "SQL value column", "Scope"])
const NOTIFY_ISSUES = new Set(["Who gets notified", "Critical destinations"])

/** The card an issue is fixed on. */
export const cardOfIssue = (issue: string): RuleCard =>
	issue === "Rule name"
		? "name"
		: NOTIFY_ISSUES.has(issue)
			? "notify"
			: WATCH_ISSUES.has(issue) || Str.startsWith("Query:")(issue)
				? "watch"
				: "condition"

// Each issue's control, by element id. A query that does not compile has no one field.
const ISSUE_FIELDS = new Map<string, string>([
	["Rule name", "rule-name"],
	["Threshold", "rule-threshold"],
	["Upper threshold", "rule-threshold-upper"],
	["Recovery value", "rule-recovery"],
	["Critical threshold", "rule-critical-threshold"],
	["Critical threshold past warning", "rule-critical-threshold"],
	["Critical recovery past warning", "rule-critical-recovery"],
	["Critical recovery value", "rule-critical-recovery"],
	["Window", "rule-window-minutes"],
	["Checks to fire", "rule-consecutive-breaches"],
	["Breach window", "rule-breaches-out-of"],
	["Min samples", "rule-minimum-samples"],
	["Checks to resolve", "rule-consecutive-healthy"],
	["Remind interval", "rule-renotify"],
	["Check interval longer than the window", "rule-interval-trigger"],
	["Query too slow for this check interval", "rule-interval-trigger"],
	["SQL query", "alert-rule-sql"],
	["$__orgFilter in SQL", "alert-rule-sql"],
	["SQL value column", "alert-rule-sql"],
	["Scope", "rule-services-input"],
	["Who gets notified", "rule-chain-warning-trigger"],
	["Critical destinations", "rule-chain-critical-trigger"],
])

/** The control that fixes an issue, by element id; `null` when the card itself is the best target. */
export const issueFieldId = (issue: string): string | null => ISSUE_FIELDS.get(issue) ?? null

/**
 * The fields that show their error: one with an issue, once the user left it or tried to save.
 * A pristine form shows none, only the card's "Missing" note.
 */
export const revealedInvalidFields = (
	issues: ReadonlyArray<string>,
	touchedFields: ReadonlyArray<string>,
	hasAttemptedSave: boolean,
): ReadonlyArray<string> =>
	Arr.dedupe(
		Arr.filter(
			Arr.flatMap(issues, (issue) => {
				const id = issueFieldId(issue)
				return id === null ? [] : [id]
			}),
			(id) => hasAttemptedSave || touchedFields.includes(id),
		),
	)

/**
 * What blocks saving on one card: the action bar's own list (`saveIssues`), so a closed card never
 * hides a blocker. A query too slow for its check interval lands on "Alert when", where the interval is.
 */
export const cardIssues = (
	form: RuleForm,
	card: RuleCard,
	timing: AlertQueryTiming | null,
	isDefault = false,
): ReadonlyArray<string> =>
	Arr.filter(saveIssues(form, timing, isDefault), (issue) => cardOfIssue(issue) === card)

/** The cards with something missing, which stay open until it is filled in. */
export const missingCards = (
	form: RuleForm,
	timing: AlertQueryTiming | null,
	isDefault = false,
): ReadonlyArray<RuleCard> =>
	Arr.filter(cardsOf(form), (card) => cardIssues(form, card, timing, isDefault).length > 0)

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

/** The "Alert when" card: "Above 5%, critical above 10%, in 3 checks in a row (5 min each)". */
export const conditionSummary = (form: RuleForm): string => {
	const words = Str.replace(/^is /, "")(comparatorWords(form.comparator))
	const threshold = isRangeComparator(form.comparator)
		? `${thresholdValue(form, form.threshold)} and ${thresholdValue(form, form.thresholdUpper)}`
		: thresholdValue(form, form.threshold)
	const escalation = comparatorSupportsTiers(form.comparator) ? form.escalation : null
	const healthy = Str.trim(form.consecutiveHealthyRequired)
	const recovery = comparatorSupportsTiers(form.comparator) ? Str.trim(form.recoveryValue) : ""
	return Arr.join(
		[
			`${capitalize(words)} ${threshold}${escalation === null && form.severity === "critical" ? " (critical)" : ""}`,
			...(escalation === null
				? []
				: [`critical ${words} ${thresholdValue(form, escalation.threshold)}`]),
			checksPhrase(form),
			...(recovery.length > 0
				? [`${Str.toLowerCase(recoveryLabel(form.comparator))} ${thresholdValue(form, recovery)}`]
				: []),
			...(healthy.length > 0 && healthy !== "1" ? [`resolves after ${healthy} healthy checks`] : []),
			...(form.alertOnNoData ? ["alerts on no data"] : []),
		],
		", ",
	)
}

/** A destination or chain by id: its list still loading, its name, or gone from the loaded list. */
export type NameLookup =
	| Readonly<{ _tag: "Loading" }>
	| Readonly<{ _tag: "Found"; name: string }>
	| Readonly<{ _tag: "Gone" }>

/** How the summary names destinations and chains. */
export type NotifyNames = Readonly<{
	destination: (id: AlertDestinationId) => NameLookup
	chain: (id: EscalationChainId) => NameLookup
}>

const nameOf = (lookup: NameLookup, noun: string): string =>
	lookup._tag === "Found" ? lookup.name : lookup._tag === "Gone" ? `a removed ${noun}` : `a ${noun}`

type Route = Readonly<{
	destinationIds: ReadonlyArray<AlertDestinationId>
	escalationChainId: EscalationChainId | null
}>

const routeText = (route: Route, names: NotifyNames): string | null => {
	const destinations = Arr.map(route.destinationIds, (id) => nameOf(names.destination(id), "destination"))
	const chain =
		route.escalationChainId === null ? null : nameOf(names.chain(route.escalationChainId), "chain")
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
	// With no warning route, critical is the whole route: "Critical: #pager", not "Critical also".
	const criticalText =
		critical === null
			? null
			: Str.startsWith("escalate to ")(critical)
				? `critical ${Str.replace(/^escalate/, "escalates")(critical)}`
				: primary === null
					? `critical: ${critical}`
					: `critical also ${critical}`
	// Only our own words are capitalised: a destination keeps its spelling ("#oncall", an email).
	const lead = (text: string) => (/^(escalate|critical|a |an )/.test(text) ? capitalize(text) : text)
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
