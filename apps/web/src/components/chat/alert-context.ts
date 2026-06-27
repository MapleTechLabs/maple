import type { AiTriageResult, AlertIncidentDocument, AlertRuleDocument } from "@maple/domain/http"
import { fromBase64Url, toBase64Url } from "@/lib/base64url"

export interface AlertContext {
	ruleId: string
	ruleName: string
	incidentId: string | null
	eventType: string
	signalType: string
	severity: string
	comparator: string
	threshold: number
	value: number | null
	windowMinutes: number
	groupKey: string | null
	sampleCount: number | null
	/** Prior AI-triage findings, folded into the chat preamble so the agent starts from them. */
	aiSummary?: string
	aiSuspectedCause?: string
}

const isAlertContext = (value: unknown): value is AlertContext => {
	if (!value || typeof value !== "object") return false
	const v = value as Record<string, unknown>
	if (typeof v.ruleId !== "string") return false
	if (typeof v.ruleName !== "string") return false
	if (v.incidentId !== null && typeof v.incidentId !== "string") return false
	if (typeof v.eventType !== "string") return false
	if (typeof v.signalType !== "string") return false
	if (typeof v.severity !== "string") return false
	if (typeof v.comparator !== "string") return false
	if (typeof v.threshold !== "number") return false
	if (v.value !== null && typeof v.value !== "number") return false
	if (typeof v.windowMinutes !== "number") return false
	if (v.groupKey !== null && typeof v.groupKey !== "string") return false
	if (v.sampleCount !== null && typeof v.sampleCount !== "number") return false
	if (v.aiSummary !== undefined && typeof v.aiSummary !== "string") return false
	if (v.aiSuspectedCause !== undefined && typeof v.aiSuspectedCause !== "string") return false
	return true
}

/**
 * Build the chat `AlertContext` from a rule + the incident under investigation,
 * optionally folding in a prior triage result so the chat opens already aware of
 * the AI's findings.
 */
export const toAlertContext = (
	rule: AlertRuleDocument,
	incident: AlertIncidentDocument,
	result?: AiTriageResult | null,
): AlertContext => ({
	ruleId: rule.id,
	ruleName: rule.name,
	incidentId: incident.id,
	eventType: incident.status === "open" ? "trigger" : "resolve",
	signalType: rule.signalType,
	severity: incident.severity,
	comparator: rule.comparator,
	threshold: incident.threshold,
	value: incident.lastObservedValue,
	windowMinutes: rule.windowMinutes,
	groupKey: incident.groupKey,
	sampleCount: incident.lastSampleCount,
	...(result?.summary ? { aiSummary: result.summary } : {}),
	...(result?.suspectedCause ? { aiSuspectedCause: result.suspectedCause } : {}),
})

export const encodeAlertContextToSearchParam = (ctx: AlertContext): string =>
	toBase64Url(JSON.stringify(ctx))

export const decodeAlertContextFromSearchParam = (raw: string): AlertContext | undefined => {
	try {
		const json = fromBase64Url(raw)
		const parsed = JSON.parse(json) as unknown
		if (!isAlertContext(parsed)) return undefined
		return parsed
	} catch {
		return undefined
	}
}

export const alertTabId = (alert: AlertContext): string => `alert-${alert.incidentId ?? alert.ruleId}`

export const alertTabTitle = (alert: AlertContext): string => {
	const base = alert.ruleName.length > 28 ? `${alert.ruleName.slice(0, 28)}…` : alert.ruleName
	return base
}

export const signalLabel = (signalType: string): string => {
	switch (signalType) {
		case "error_rate":
			return "error rate"
		case "p95_latency":
			return "p95 latency"
		case "p99_latency":
			return "p99 latency"
		case "apdex":
			return "Apdex"
		case "throughput":
			return "throughput"
		case "metric":
			return "metric"
		default:
			return signalType
	}
}

const groupLabel = (alert: AlertContext): string => alert.groupKey ?? "the affected service"

export const alertPromptSuggestions = (alert: AlertContext): string[] => {
	const group = groupLabel(alert)
	const sig = alert.signalType
	const windowM = alert.windowMinutes

	if (alert.eventType === "test") return []

	if (alert.eventType === "resolve") {
		const base = [
			`Summarize what happened in ${group}`,
			`Timeline of traces, errors, and throughput during the incident`,
			`Root cause candidates for ${alert.ruleName}`,
		]
		if (sig.includes("latency")) base.push(`Which operations in ${group} recovered last?`)
		else if (sig === "error_rate") base.push(`Which exceptions drove the spike?`)
		return base
	}

	if (sig === "p95_latency" || sig === "p99_latency") {
		return [
			`Slowest operations in ${group} right now`,
			`Top 10 slowest traces in ${group}`,
			`Compare ${group} ${signalLabel(sig)} to the past week`,
			`Recent deploys or config changes in ${group}`,
		]
	}
	if (sig === "error_rate") {
		const newSince = Math.max(windowM * 12, 60)
		return [
			`Top exceptions in ${group} in the last ${windowM}m`,
			`New error types since ${newSince}m ago`,
			`Group errors in ${group} by endpoint`,
			`Sample stack traces per error class`,
		]
	}
	if (sig === "throughput") {
		return [
			`Plot ${group} throughput vs yesterday`,
			`Upstream callers of ${group} — any drops?`,
			`Operations in ${group} with biggest volume delta`,
		]
	}
	if (sig === "apdex") {
		return [
			`Is ${group} Apdex drop driven by latency or errors?`,
			`Slowest 20 traces in ${group} in the last ${windowM}m`,
			`Error rate vs latency correlation in ${group}`,
		]
	}
	if (sig === "metric") {
		return [
			`Raw metric values for ${group} last ${windowM}m`,
			`Compare this metric to the past week`,
			`Chart this metric for ${group} over 6h`,
		]
	}

	return [`Diagnose ${group}`, `Recent errors in ${group}`, `Slowest traces in ${group}`]
}
