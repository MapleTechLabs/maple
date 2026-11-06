import { Array as Arr, Schema, String as Str } from "effect"
import { buildSummaryLine } from "../../AlertDeliveryDispatch"
import {
	displayGroupKey,
	eventTypeEmoji,
	formatAlertHeadline,
	formatEventTypeLabel,
	formatSeverityLabel,
	formatWindow,
	severityEmoji,
	truncate,
} from "../../alert-formatting"
import type { DispatchContext } from "../context"
import type { HttpTransport, RenderInput, SecretConfigOf } from "../Transport"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

type Config = SecretConfigOf<"microsoft-teams">

/** Teams caps a webhook message at 28 KB; this keeps a templated body well inside it. */
const MAX_TEMPLATED_BODY_CHARS = 4000

/** Teams renders TextBlock text as Markdown, so a rule name or group must not become a link or emphasis. */
const escapeMarkdown = (value: string): string => Str.replace(/([\\`*_[\]])/g, "\\$1")(value)

/** The header band's Adaptive Card container style: the alert's state at a glance. */
const headerStyle = (context: Pick<DispatchContext, "eventType" | "severity">): string => {
	if (context.eventType === "resolve") return "good"
	if (context.eventType === "test") return "accent"
	return context.severity === "critical" ? "attention" : "warning"
}

const textBlock = (text: string, extra?: Record<string, unknown>) => ({
	type: "TextBlock",
	text,
	wrap: true,
	...extra,
})

export const buildTeamsAdaptiveCard = (input: RenderInput<Config>) => {
	const { context, templated, linkUrl, chatUrl } = input
	const group = displayGroupKey(context.groupKey)
	const title = templated?.title ?? `${eventTypeEmoji(context.eventType)} ${formatAlertHeadline(context)}`
	const lead = templated
		? truncate(templated.body, MAX_TEMPLATED_BODY_CHARS)
		: escapeMarkdown(buildSummaryLine(context, (value) => value))
	const footer = Arr.join(
		[
			...(context.sparkline ? [context.sparkline] : []),
			...(context.incidentId ? [`Incident ${escapeMarkdown(context.incidentId)}`] : []),
			...(context.sentAtMs != null ? [new Date(context.sentAtMs).toISOString()] : []),
		],
		"  ·  ",
	)
	const facts = templated
		? []
		: [
				{ title: "Status", value: formatEventTypeLabel(context.eventType) },
				{
					title: "Severity",
					value: `${severityEmoji(context.severity)} ${formatSeverityLabel(context.severity)}`,
				},
				{ title: "Window", value: formatWindow(context.windowMinutes) },
				...(group == null ? [] : [{ title: "Group", value: escapeMarkdown(group) }]),
			]
	return {
		type: "AdaptiveCard",
		$schema: "http://adaptivecards.io/schemas/adaptive-card.json",
		version: "1.4",
		msteams: { width: "Full" },
		// Read by clients that cannot draw the card, and by screen readers.
		fallbackText: truncate(title, 300),
		body: [
			{
				type: "Container",
				style: headerStyle(context),
				bleed: true,
				items: [
					textBlock(escapeMarkdown(truncate(title, 200)), { size: "Medium", weight: "Bolder" }),
					textBlock("Maple Alerts", { size: "Small", isSubtle: true, spacing: "None" }),
				],
			},
			textBlock(lead),
			...(facts.length > 0 ? [{ type: "FactSet", facts }] : []),
			...(context.chartUrl
				? [
						{
							type: "Image",
							url: context.chartUrl,
							altText: `${context.ruleName} over the alert window`,
							size: "Stretch",
						},
					]
				: []),
			...(footer.length > 0 ? [textBlock(footer, { size: "Small", isSubtle: true })] : []),
		],
		actions: [
			{ type: "Action.OpenUrl", title: "Open in Maple", url: linkUrl },
			{ type: "Action.OpenUrl", title: "Ask Maple AI", url: chatUrl },
		],
	}
}

/** The body the Workflows "Post to a channel when a webhook request is received" trigger expects. */
export const buildTeamsMessage = (input: RenderInput<Config>) => ({
	type: "message",
	attachments: [
		{
			contentType: "application/vnd.microsoft.card.adaptive",
			contentUrl: null,
			content: buildTeamsAdaptiveCard(input),
		},
	],
})

export const microsoftTeamsTransport: HttpTransport<Config> = {
	kind: "http",
	type: "microsoft-teams",
	peerService: "microsoft-teams",
	providerLabel: "Microsoft Teams",
	render: (input: RenderInput<Config>) => ({
		url: input.config.webhookUrl,
		headers: { "content-type": "application/json" },
		// User-configured URL, checked at save time; the `sig` credential is in the query string,
		// which the span never records, and the path holds only the workflow id.
		guarded: true,
		sensitivePath: false,
		body: encodeJson(buildTeamsMessage(input)),
	}),
	describeStatus: (status) => {
		if (status === 401 || status === 403) {
			return 'Teams rejected the webhook: the flow\'s URL changed, or it only accepts signed-in users; set its trigger to "Anyone"'
		}
		if (status === 404) return "The Teams workflow no longer exists. Create a new one in the channel"
		if (status === 413) return "Teams rejected the card as too large (28 KB limit). Shorten the template"
		return null
	},
	ack: (input) => ({
		providerMessage: "Delivered to Microsoft Teams",
		providerReference: input.context.dedupeKey,
	}),
}
