import { narrowAlertSignal } from "../../../components/ai-triage/breach"
import {
	type AlertContext,
	decodeAlertContextFromSearchParam,
	signalLabel,
} from "../../../components/chat/alert-context"
import { Option, Schema } from "effect"

// `/chat`'s explicit subjects: `?mode=alert&alert=` (an alert notification's investigation, see
// components/chat/alert-context.ts and page/investigations/detail/investigation-context.ts) and
// `?mode=widget-fix&widget=`.

const Fact = Schema.Struct({ key: Schema.String, label: Schema.String, value: Schema.String })

/** `InvestigationContext` (investigation-context.ts) as a Schema, so a page Model can hold it. */
export const InvestigationContext = Schema.Struct({
	kind: Schema.Literals(["alert", "anomaly", "error", "freeform"]),
	id: Schema.String,
	title: Schema.String,
	severity: Schema.String,
	status: Schema.String,
	signalType: Schema.optionalKey(Schema.String),
	scope: Schema.optionalKey(Schema.String),
	windowMinutes: Schema.optionalKey(Schema.Number),
	facts: Schema.mutable(Schema.Array(Fact)),
	refs: Schema.optionalKey(
		Schema.Struct({
			serviceName: Schema.optionalKey(Schema.String),
			ruleId: Schema.optionalKey(Schema.String),
			ruleName: Schema.optionalKey(Schema.String),
			detectorKey: Schema.optionalKey(Schema.String),
			issueId: Schema.optionalKey(Schema.String),
			incidentId: Schema.optionalKey(Schema.String),
		}),
	),
	aiSummary: Schema.optionalKey(Schema.String),
	aiSuspectedCause: Schema.optionalKey(Schema.String),
})
export type InvestigationContext = typeof InvestigationContext.Type

/** `WidgetFixContext`; `isWidgetFixContext` requires both error fields, string or null. */
export const WidgetFixContext = Schema.Struct({
	dashboardId: Schema.String,
	widgetId: Schema.String,
	widgetTitle: Schema.String,
	widgetJson: Schema.String,
	errorTitle: Schema.NullOr(Schema.String),
	errorMessage: Schema.NullOr(Schema.String),
})
export type WidgetFixContext = typeof WidgetFixContext.Type

export const ChatSubject = Schema.Union([
	Schema.TaggedStruct("Investigation", { context: InvestigationContext }),
	Schema.TaggedStruct("WidgetFix", { context: WidgetFixContext }),
])
export type ChatSubject = typeof ChatSubject.Type

const capitalize = (s: string): string => (s.length === 0 ? s : `${s.charAt(0).toUpperCase()}${s.slice(1)}`)

/** `alertContextToInvestigation`: the alert link's context in the generic investigation shape. */
export const alertContextToInvestigation = (alert: AlertContext): InvestigationContext => {
	const { breach } = narrowAlertSignal(alert)
	const observed = breach
		? `${breach.observed} vs ${breach.threshold}`
		: `${alert.value ?? "n/a"} vs ${alert.threshold}`
	return {
		kind: "alert",
		id: alert.incidentId ?? alert.ruleId,
		title: alert.ruleName,
		severity: alert.severity,
		status: alert.eventType === "resolve" ? "Resolved" : "Firing",
		signalType: alert.signalType,
		...(alert.groupKey === null ? undefined : { scope: alert.groupKey }),
		windowMinutes: alert.windowMinutes,
		facts: [
			{ key: "signal", label: "Signal", value: capitalize(signalLabel(alert.signalType)) },
			{ key: "observed", label: "Observed", value: observed },
			{ key: "window", label: "Window", value: `${alert.windowMinutes}m` },
			{ key: "group", label: "Group", value: alert.groupKey ?? "all" },
		],
		refs: {
			ruleId: alert.ruleId,
			ruleName: alert.ruleName,
			...(alert.incidentId ? { incidentId: alert.incidentId } : undefined),
		},
		...(alert.aiSummary ? { aiSummary: alert.aiSummary } : undefined),
		...(alert.aiSuspectedCause ? { aiSuspectedCause: alert.aiSuspectedCause } : undefined),
	}
}

// `fromBase64Url` (as in lib/base64url.ts), as an Option.
const fromBase64Url = (input: string): Option.Option<string> =>
	Option.liftThrowable(() => {
		const base64 = input.replace(/-/g, "+").replace(/_/g, "/")
		const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4)
		return decodeURIComponent(escape(atob(padded)))
	})()

const decodeWidgetFix = Schema.decodeUnknownOption(Schema.fromJsonString(WidgetFixContext))

/** The route's subject, picked by `mode`; an undecodable param is none. */
export const subjectOfSearch = (search: {
	readonly mode?: "alert" | "widget-fix" | undefined
	readonly alert?: string | undefined
	readonly widget?: string | undefined
}): ChatSubject | null => {
	if (search.mode === "widget-fix" && search.widget) {
		const decoded = Option.flatMap(fromBase64Url(search.widget), decodeWidgetFix)
		return Option.match(decoded, {
			onNone: () => null,
			onSome: (context) => ({ _tag: "WidgetFix", context }),
		})
	}
	if (search.mode !== "alert" || !search.alert) return null
	const alert = decodeAlertContextFromSearchParam(search.alert)
	return alert === undefined ? null : { _tag: "Investigation", context: alertContextToInvestigation(alert) }
}

/** `investigationTabId` / `widgetFixTabId`: alerts keep their legacy `alert-…` id. */
export const subjectTabId = (subject: ChatSubject): string => {
	if (subject._tag === "WidgetFix")
		return `widget-fix-${subject.context.dashboardId}-${subject.context.widgetId}`
	const ctx = subject.context
	return ctx.kind === "alert"
		? `alert-${ctx.refs?.incidentId ?? ctx.refs?.ruleId ?? ctx.id}`
		: `${ctx.kind}-${ctx.id}`
}

/** `investigationTabTitle` / `widgetFixTabTitle`. */
export const subjectTabTitle = (subject: ChatSubject): string => {
	if (subject._tag === "Investigation")
		return subject.context.title.length > 28
			? `${subject.context.title.slice(0, 28)}…`
			: subject.context.title
	const base = subject.context.widgetTitle.trim().length === 0 ? "widget" : subject.context.widgetTitle
	return `Fix: ${base.length > 24 ? `${base.slice(0, 24)}…` : base}`
}

/** `widgetFixSuggestions` and `widgetFixAutoPrompt`. */
export const WIDGET_FIX_SUGGESTIONS = ["Try a different fix", "Explain what's wrong", "Show me what changed"]
export const WIDGET_FIX_AUTO_PROMPT = "Fix this widget"
