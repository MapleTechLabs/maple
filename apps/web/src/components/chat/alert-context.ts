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
