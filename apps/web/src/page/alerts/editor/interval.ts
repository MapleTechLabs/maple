import { alertQueryLimits, alertRuleIntervalMinutes } from "@maple/query-engine/datetime"
import { ALERT_EVALUATION_INTERVALS, type AlertQueryTiming } from "@maple/domain/http"
import { formEvaluationInterval } from "@maple/web-data/alerts/form-utils"
import type { RuleForm } from "./form"

// The check interval picker's pure half: its options, and what each one allows a raw SQL query.

/** The radio value for "checks every fifth of the window". */
export const AUTO_INTERVAL = "auto"

export const intervalRadioValue = (formValue: string): string =>
	formValue.trim().length === 0 ? AUTO_INTERVAL : formValue

export interface IntervalOption {
	readonly value: string
	readonly minutes: number
	readonly label: string
	/** The query time limit at this interval, in seconds. */
	readonly limitSeconds: number
	/** Longer than the window: data between checks would go unread. */
	readonly isLongerThanWindow: boolean
	/** The timed query does not fit this interval's limit. */
	readonly isTooSlow: boolean
}

const windowOf = (form: RuleForm): number | null => {
	const minutes = Number(form.windowMinutes.trim())
	return Number.isFinite(minutes) && minutes > 0 ? minutes : null
}

/** Minutes between checks as the form stands, the automatic one included. */
export const formIntervalMinutes = (form: RuleForm): number =>
	alertRuleIntervalMinutes({
		windowMinutes: windowOf(form) ?? 5,
		evaluationIntervalMinutes: formEvaluationInterval(form),
	})

const minutesLabel = (minutes: number): string => (minutes === 60 ? "1 hour" : `${minutes} min`)

/** The automatic interval for the form's window. */
export const autoIntervalMinutes = (form: RuleForm): number =>
	alertRuleIntervalMinutes({ windowMinutes: windowOf(form) ?? 5, evaluationIntervalMinutes: null })

/** "Auto" first, then every interval a rule can pick. */
export const intervalOptions = (form: RuleForm, timing: AlertQueryTiming | null): ReadonlyArray<IntervalOption> => {
	const window = windowOf(form)
	const auto = alertRuleIntervalMinutes({ windowMinutes: window ?? 5, evaluationIntervalMinutes: null })
	const option = (value: string, minutes: number, label: string): IntervalOption => ({
		value,
		minutes,
		label,
		limitSeconds: alertQueryLimits(minutes).timeSeconds,
		isLongerThanWindow: window !== null && minutes > window,
		isTooSlow: timing !== null && !timing.fitsIntervalMinutes.some((fits) => fits <= minutes),
	})
	return [
		option(AUTO_INTERVAL, auto, `Auto · ${minutesLabel(auto)}`),
		...ALERT_EVALUATION_INTERVALS.map((minutes) => option(String(minutes), minutes, minutesLabel(minutes))),
	]
}

/** The picked interval, when it is longer than the window. */
export const intervalWindowIssue = (form: RuleForm): string | null => {
	const picked = formEvaluationInterval(form)
	const window = windowOf(form)
	return picked !== null && window !== null && picked > window ? "Check interval longer than the window" : null
}

/** The shortest interval the timed query fits within the window, when it does not fit the one picked. */
export const shortestFittingInterval = (form: RuleForm, timing: AlertQueryTiming | null): number | null => {
	if (timing === null || timing.elapsedMs === null) return null
	const current = formIntervalMinutes(form)
	if (timing.fitsIntervalMinutes.some((fits) => fits <= current)) return null
	const window = windowOf(form)
	return timing.fitsIntervalMinutes.find((fits) => window === null || fits <= window) ?? null
}

/** Blocks saving when the query does not fit the picked interval but a slower one is a click away. */
export const queryTimingIssue = (form: RuleForm, timing: AlertQueryTiming | null): string | null =>
	form.signalType === "raw_query" && shortestFittingInterval(form, timing) !== null
		? "Query too slow for this check interval"
		: null
