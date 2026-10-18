import type { AutoContext } from "@maple/web/components/chat/auto-contexts"

// The page-context half of `buildContextPreamble` (apps/web components/chat/context-preamble.ts),
// verbatim: the model must see the same block legacy sends. The module itself is not importable
// (its investigation types pull in React-coupled code).
// TODO(chat-investigation-mode): the investigation and widget-fix blocks.

const formatAutoContextLine = (context: AutoContext): string => {
	switch (context.kind) {
		case "service":
			return `- service: ${context.serviceName}`
		case "trace":
			return `- trace: ${context.traceId}`
		case "dashboard":
			return context.widgetId
				? `- dashboard: ${context.dashboardId} (widget: ${context.widgetId})`
				: `- dashboard: ${context.dashboardId}`
		case "error_type":
			return `- error_type: ${context.errorType}`
		case "error_issue":
			return `- error_issue: ${context.issueId}`
		case "alert_rule":
			return `- alert_rule: ${context.ruleId}`
		case "host":
			return `- host: ${context.hostName}`
		case "container":
			return `- container: ${context.containerName}`
		case "logs_explorer":
			return "- view: logs explorer"
		case "metrics_explorer":
			return "- view: metrics explorer"
		case "traces_explorer":
			return "- view: traces explorer"
		case "service_map":
			return "- view: service map"
	}
}

/** The first message's context block for the page the user came from; "" with no contexts. */
export const pageContextPreamble = (pathname: string | null, contexts: ReadonlyArray<AutoContext>): string => {
	if (pathname === null || contexts.length === 0) return ""
	return [
		"",
		"## Current Page Context",
		'The user is viewing the following Maple page. Treat these entities as the implicit subject when the user says "this", "here", or asks open-ended questions without naming a target. The user can dismiss any of these chips, so respect what\'s listed below.',
		"",
		`page: ${pathname}`,
		...contexts.map(formatAutoContextLine),
	]
		.join("\n")
		.trim()
}
