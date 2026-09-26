/**
 * A settled proposal's `tool-result`, as something a person in a channel wants to read.
 *
 * The recorded result is written for the model: who decided on the first line, then the tool's
 * whole markdown report, then the `__maple_ui` JSON the web transcript draws from. Posting that
 * verbatim put a report's headings and a dashboard's validation table into a thread. The record
 * stays as it is — the model reads it on its next turn — and a channel gets one sentence and a link.
 */
import { Option, Schema } from "effect"
import { MAX_APPROVAL_OUTCOME_CHARS, type ChatApprovalOutcome, type ChatRenderContext } from "./blocks"

/** A decision line longer than this is not a name any more. */
const MAX_DECISION_CHARS = 80
/** What a sentence is never cut below, even next to a long link. */
const MIN_TEXT_CHARS = 40

export const approvalOutcome = (
	output: unknown,
	isError: boolean,
	context: ChatRenderContext,
): ChatApprovalOutcome => {
	const recorded = typeof output === "string" ? output : (JSON.stringify(output) ?? "")
	// `ChatSession.settleProposal` and `applyChatProposal` both open the result with the decision.
	const [first = "", ...rest] = recorded.split("\n")
	const decision = truncate(first.trim(), MAX_DECISION_CHARS)

	const described = isError ? null : structuredOf(rest, context.appBaseUrl)
	const url = described?.url ?? null
	const text = described?.text ?? (isError ? firstReportLine(rest) : "The change went through.")
	const room = Math.max(MIN_TEXT_CHARS, MAX_APPROVAL_OUTCOME_CHARS - decision.length - (url?.length ?? 0))
	return { approved: !isError, decision, text: truncate(text, room), url }
}

/** A refusal's reason: the report's first line of prose — not a heading, not the payload. */
const firstReportLine = (lines: ReadonlyArray<string>): string => {
	for (const line of lines) {
		const text = line.trim()
		if (text.length > 0 && !text.startsWith("#") && !text.startsWith("{")) return text
	}
	return ""
}

interface Described {
	readonly text: string
	readonly url: string | null
}

// The fields of each mutating tool's `__maple_ui` payload a sentence reads — decoded rather than
// trusted, so a payload recorded by an older build of a tool falls to the generic line instead of
// failing the whole message's render.
const Named = Schema.Struct({ id: Schema.String, name: Schema.String })
const OnDashboard = Schema.Struct({ dashboard: Named })
const OnRule = Schema.Struct({ rule: Named })
const OnIssue = Schema.Struct({ id: Schema.String })
const Payload = <Tool extends string, Data extends Schema.Top>(tool: Tool, data: Data) =>
	Schema.Struct({ __maple_ui: Schema.Literal(true), tool: Schema.Literal(tool), data })

const MutationPayload = Schema.Union([
	Payload("create_dashboard", OnDashboard),
	Payload("update_dashboard", OnDashboard),
	Payload("add_dashboard_widget", OnDashboard),
	Payload("update_dashboard_widget", OnDashboard),
	Payload("remove_dashboard_widget", OnDashboard),
	Payload("reorder_dashboard_widgets", OnDashboard),
	Payload("replace_dashboard_widgets", OnDashboard),
	Payload("create_alert_rule", OnRule),
	Payload("update_alert_rule", OnRule),
	Payload("delete_alert_rule", Schema.Struct({})),
	Payload(
		"transition_error_issue",
		Schema.Struct({ id: Schema.String, fromState: Schema.String, toState: Schema.String }),
	),
	Payload(
		"set_issue_severity",
		Schema.Struct({ id: Schema.String, severity: Schema.NullOr(Schema.String), applied: Schema.Boolean }),
	),
	Payload("claim_error_issue", OnIssue),
	Payload("release_error_issue", OnIssue),
	Payload("comment_on_error_issue", Schema.Struct({ issueId: Schema.String })),
	Payload("propose_fix", Schema.Struct({ issueId: Schema.String })),
	Payload(
		"link_pull_request",
		Schema.Struct({ issueId: Schema.String, repoFullName: Schema.String, number: Schema.Number }),
	),
	Payload("register_agent", Schema.Struct({ agentName: Schema.NullOr(Schema.String) })),
	Payload("update_error_notification_policy", Schema.Struct({ enabled: Schema.Boolean })),
])
type MutationPayload = typeof MutationPayload.Type

const decodePayload = Schema.decodeUnknownOption(Schema.fromJsonString(MutationPayload))

/** `createDualContent` writes the payload as one line of its own, after the report. */
const structuredOf = (lines: ReadonlyArray<string>, app: string): Described | null => {
	for (const line of lines) {
		const trimmed = line.trim()
		if (!trimmed.startsWith("{")) continue
		const payload = decodePayload(trimmed)
		if (Option.isSome(payload)) return describe(payload.value, app)
	}
	return null
}

/** One sentence per mutating tool, in the bot's voice, and the page in Maple that shows it. */
const describe = (output: MutationPayload, app: string): Described => {
	const dashboard = (id: string) => `${app}/dashboards/${encodeURIComponent(id)}`
	const alert = (id: string) => `${app}/alerts/${encodeURIComponent(id)}`
	const issue = (id: string) => `${app}/errors/issues/${encodeURIComponent(id)}`
	switch (output.tool) {
		case "create_dashboard":
			return {
				text: `I created the dashboard "${output.data.dashboard.name}".`,
				url: dashboard(output.data.dashboard.id),
			}
		case "update_dashboard":
			return {
				text: `I updated the dashboard "${output.data.dashboard.name}".`,
				url: dashboard(output.data.dashboard.id),
			}
		case "add_dashboard_widget":
			return {
				text: `I added a widget to "${output.data.dashboard.name}".`,
				url: dashboard(output.data.dashboard.id),
			}
		case "update_dashboard_widget":
			return {
				text: `I updated a widget on "${output.data.dashboard.name}".`,
				url: dashboard(output.data.dashboard.id),
			}
		case "remove_dashboard_widget":
			return {
				text: `I removed a widget from "${output.data.dashboard.name}".`,
				url: dashboard(output.data.dashboard.id),
			}
		case "reorder_dashboard_widgets":
			return {
				text: `I reordered the widgets on "${output.data.dashboard.name}".`,
				url: dashboard(output.data.dashboard.id),
			}
		case "replace_dashboard_widgets":
			return {
				text: `I replaced the widgets on "${output.data.dashboard.name}".`,
				url: dashboard(output.data.dashboard.id),
			}
		case "create_alert_rule":
			return {
				text: `I created the alert rule "${output.data.rule.name}".`,
				url: alert(output.data.rule.id),
			}
		case "update_alert_rule":
			return {
				text: `I updated the alert rule "${output.data.rule.name}".`,
				url: alert(output.data.rule.id),
			}
		case "delete_alert_rule":
			return { text: "I deleted the alert rule.", url: `${app}/alerts` }
		case "transition_error_issue":
			return {
				text: `I moved the issue from ${output.data.fromState} to ${output.data.toState}.`,
				url: issue(output.data.id),
			}
		case "set_issue_severity":
			return {
				text: output.data.applied
					? `I set the issue's severity to ${output.data.severity ?? "none"}.`
					: "The issue's severity was set by hand, so I left it as it is.",
				url: issue(output.data.id),
			}
		case "claim_error_issue":
			return { text: "I claimed the issue.", url: issue(output.data.id) }
		case "release_error_issue":
			return { text: "I released the issue.", url: issue(output.data.id) }
		case "comment_on_error_issue":
			return { text: "I commented on the issue.", url: issue(output.data.issueId) }
		// The issue rather than the pull request: the link reads "Open in Maple".
		case "propose_fix":
			return { text: "I proposed a fix for the issue.", url: issue(output.data.issueId) }
		case "link_pull_request":
			return {
				text: `I linked ${output.data.repoFullName}#${output.data.number} to the issue.`,
				url: issue(output.data.issueId),
			}
		case "register_agent":
			return {
				text:
					output.data.agentName === null
						? "I registered the agent."
						: `I registered the agent "${output.data.agentName}".`,
				url: null,
			}
		case "update_error_notification_policy":
			return {
				text: output.data.enabled
					? "I updated the error notification policy."
					: "I turned off error notifications.",
				url: null,
			}
	}
}

const truncate = (text: string, max: number): string =>
	text.length <= max ? text : `${text.slice(0, max - 1)}…`
