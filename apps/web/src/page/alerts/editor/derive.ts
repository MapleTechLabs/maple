import { Schema, Array as Arr, String as Str } from "effect"
import type { AlertComparator, AlertDestinationDocument, AlertQueryTiming } from "@maple/domain/http"
import {
	buildRuleCreateParamsV2,
	comparatorSupportsTiers,
	deriveRuleQueryIssues,
	deriveTierIssues,
	isFilledNumber,
	isRangeComparator,
	signalLabels,
	thresholdUnitLabel,
} from "@maple/web-data/alerts/form-utils"
import { destinationProvider } from "../shared/providers"
import type { RuleForm } from "./form"
import { intervalWindowIssue, queryTimingIssue } from "./interval"
import { nonZeroOr } from "@maple/ui/lib/number"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

// The rule editor's pure helpers: form surface, condition bar, live chart hero, notifications.

export const COMPARATOR_WORDS = new Map<AlertComparator, string>([
	["gt", "is above"],
	["gte", "is at or above"],
	["lt", "is below"],
	["lte", "is at or below"],
	["eq", "equals"],
	["neq", "is not"],
	["between", "is between"],
	["not_between", "is outside"],
])
export const comparatorWords = (comparator: AlertComparator): string => COMPARATOR_WORDS.get(comparator) ?? ""

/** What the threshold is compared against, in words: the aggregation for a query, the signal otherwise. */
export const conditionSubject = (form: RuleForm): string => {
	if (form.signalType === "raw_query") return "the SQL value"
	if (form.signalType === "builder_query") {
		const aggregation = Str.trim(Str.replaceAll("_", " ")(form.queryBuilderDraft.aggregation))
		return aggregation.length > 0 ? aggregation : "the query value"
	}
	return Str.toLowerCase(signalLabels[form.signalType])
}

/** The rule in one plain sentence, shown in the action bar. */
export const describeRuleCondition = (form: RuleForm): string => {
	const unit = thresholdUnitLabel(form) ?? ""
	const value = (raw: string) => `${Str.trim(raw) || "?"}${unit === "%" ? "%" : unit ? ` ${unit}` : ""}`
	const threshold = isRangeComparator(form.comparator)
		? `${value(form.threshold)} and ${value(form.thresholdUpper)}`
		: value(form.threshold)
	const escalation = comparatorSupportsTiers(form.comparator) ? form.escalation : null
	const checks = Str.trim(form.consecutiveBreachesRequired) || "?"
	const outOf = Str.trim(form.breachesOutOf)
	const windowText = `${Str.trim(form.windowMinutes) || "?"} min`
	const when =
		outOf.length > 0
			? `in ${checks} of the last ${outOf} checks (${windowText} each)`
			: checks === "1"
				? `over ${windowText}`
				: `in ${checks} checks in a row (${windowText} each)`
	const severity = escalation === null && form.severity === "critical" ? "Critical" : "Warning"
	const critical =
		escalation === null
			? ""
			: `, critical ${Str.replace(/^is /, "")(comparatorWords(form.comparator))} ${value(escalation.threshold)},`
	return `${severity} when ${conditionSubject(form)} ${comparatorWords(form.comparator)} ${threshold}${critical} ${when}`
}

/** What crossing back looks like for a comparator, as the recovery field's label. */
export const recoveryLabel = (comparator: AlertComparator): string =>
	comparator === "gt" || comparator === "gte" ? "Recovers below" : "Recovers above"

/** A starting critical value one step worse than the warning one, so the new row is never blank. */
export const suggestCriticalThreshold = (form: RuleForm): string => {
	const warning = Number(form.threshold)
	if (Str.trim(form.threshold).length === 0 || !Number.isFinite(warning)) return ""
	const step = nonZeroOr(Math.abs(warning), 1)
	const worse = form.comparator === "gt" || form.comparator === "gte" ? warning + step : warning - step
	return String(Number(worse.toPrecision(12)))
}

/** `deriveValidationIssues`: what the action bar lists as missing. */
export const validationIssues = (form: RuleForm): ReadonlyArray<string> => {
	const issues: Array<string> = []
	if (Str.trim(form.name).length === 0) issues.push("Rule name")
	if (!isFilledNumber(form.threshold)) issues.push("Threshold")
	if (isRangeComparator(form.comparator) && !isFilledNumber(form.thresholdUpper))
		issues.push("Upper threshold")
	const timing: ReadonlyArray<readonly [string, string]> = [
		["Window", form.windowMinutes],
		["Checks to fire", form.consecutiveBreachesRequired],
		["Checks to resolve", form.consecutiveHealthyRequired],
		["Remind interval", form.renotifyIntervalMinutes],
	]
	Arr.forEach(timing, ([label, value]) => {
		const parsed = Number(value)
		if (!Number.isFinite(parsed) || parsed <= 0) issues.push(label)
	})
	const minSamples = Number(form.minimumSampleCount)
	if (!Number.isFinite(minSamples) || minSamples < 0) issues.push("Min samples")
	if (form.signalType === "raw_query") {
		const sql = Str.trim(form.rawQuerySql)
		if (sql.length === 0) issues.push("SQL query")
		else if (!Str.includes("$__orgFilter")(form.rawQuerySql)) issues.push("$__orgFilter in SQL")
	}
	const intervalIssue = intervalWindowIssue(form)
	if (intervalIssue !== null) issues.push(intervalIssue)
	issues.push(...deriveRuleQueryIssues(form), ...deriveTierIssues(form))
	if (form.destinationIds.length === 0) issues.push("Who gets notified")
	return issues
}

/** What blocks saving: the form's own issues and a query too slow for its interval. */
export const saveIssues = (form: RuleForm, timing: AlertQueryTiming | null): ReadonlyArray<string> => {
	const timingIssue = queryTimingIssue(form, timing)
	return timingIssue === null ? validationIssues(form) : [...validationIssues(form), timingIssue]
}

/** `previewIdentityKey`: the rule as evaluated; a dry-run verdict is only shown while it matches. */
export const previewIdentityKey = (form: RuleForm): string => {
	const {
		name: _name,
		notes: _notes,
		tags: _tags,
		destination_ids: _destinationIds,
		notification_template: _notificationTemplate,
		enabled: _enabled,
		thresholds,
		...evaluated
	} = buildRuleCreateParamsV2(form)
	const tiers =
		thresholds === undefined
			? undefined
			: Arr.map(thresholds, ({ destination_ids: _ids, ...tier }) => tier)
	return encodeJson({ ...evaluated, tiers })
}

/** `makeSuggestedName`: signal and scope, offered while the name is empty. */
export const suggestedName = (form: RuleForm): string | null => {
	if (Str.trim(form.name).length > 0) return null
	const subject = conditionSubject(form)
	const base = Str.toUpperCase(Str.slice(0, 1)(subject)) + Str.slice(1)(subject)
	const queryGroupBy =
		form.signalType === "builder_query" && form.queryBuilderDraft.addOns.groupBy
			? form.queryBuilderDraft.groupBy
			: []
	const queryOwnsScope = form.signalType === "builder_query" || form.signalType === "raw_query"
	const scope = queryOwnsScope
		? queryGroupBy.length > 0
			? `per ${Arr.join(queryGroupBy, " · ")}`
			: null
		: form.serviceNames.length === 1
			? (form.serviceNames[0] ?? null)
			: form.serviceNames.length > 1
				? `${form.serviceNames.length} services`
				: form.groupBy.length > 0
					? `per ${Arr.join(form.groupBy, " · ")}`
					: null
	const env = !queryOwnsScope && form.environments.length > 0 ? Arr.join(form.environments, " · ") : null
	const suffix = Arr.join(
		Arr.filter([scope, env], (part) => part !== null),
		" · ",
	)
	return suffix.length > 0 ? `${base} · ${suffix}` : base
}

/** `formatGroupBySummary`: the hero's "per …" next to the subject. */
export const groupBySummary = (form: RuleForm): string | null => {
	const groupBy =
		form.signalType === "builder_query" && form.queryBuilderDraft.addOns.groupBy
			? form.queryBuilderDraft.groupBy
			: form.groupBy
	const visible = Arr.filter(groupBy, (value) => value !== "none")
	return visible.length === 0 ? null : Arr.join(visible, ", ")
}

/** `destinationTarget`: where a destination delivers, ahead of its name. */
export const destinationTarget = (
	destination: AlertDestinationDocument,
): { primary: string; secondary: string } => {
	const provider = destinationProvider(destination.type, destination.chatConnector ?? undefined).label
	const primary =
		destination.type === "chat"
			? (destination.channelLabel ?? destination.name)
			: destination.type === "webhook"
				? Str.replace(/^POST /, "")(destination.summary)
				: destination.type === "email" || destination.type === "telegram"
					? destination.summary
					: destination.type === "linear"
						? Str.replace(/^Linear · /, "")(destination.summary)
						: destination.name
	const where = destination.type === "chat" ? destination.summary : null
	const secondary = Arr.join(
		Arr.filter(
			[provider, where, Str.includes(destination.name)(primary) ? null : destination.name],
			(part): part is string => part !== null && part.length > 0,
		),
		" · ",
	)
	return { primary, secondary }
}
