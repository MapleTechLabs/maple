import type { ChatAlertBlock, ChatBlock } from "@maple/chat-platform"
import { Effect } from "effect"
import { buildSummaryLine } from "../../AlertDeliveryDispatch"
import {
	displayGroupKey,
	eventTypeEmoji,
	formatEventTypeLabel,
	formatSeverityLabel,
	severityEmoji,
	slackAttachmentColor,
	truncate,
} from "../../alert-formatting"
import type { EffectTransport, RenderInput, SecretConfigOf } from "../Transport"

type Config = SecretConfigOf<"chat">

/**
 * A templated body's budget. Under every connector's own message budget, so an alert is always
 * one message — the rest of it is one click away in Maple.
 */
const MAX_TEMPLATED_BODY_CHARS = 1200

/**
 * The alert as one neutral alert card, which the connector renders in its own dialect — and
 * which is where its mention-neutralising lives, so a rule named `@everyone` pings nobody.
 *
 * The same card the `slack-bot` destination posts: the event and rule as the title, what was
 * observed against the threshold, severity and group as fields, the chart, both links as buttons,
 * and a footer carrying the sparkline, the incident and the time. A rule's own template, when it
 * has one, replaces the title and the summary and drops the fields, as it does there.
 */
export const buildChatAlertBlocks = (input: RenderInput<Config>): ReadonlyArray<ChatBlock> => {
	const { context, templated, linkUrl, chatUrl } = input
	const group = displayGroupKey(context.groupKey)
	const card: Omit<ChatAlertBlock, "title" | "summary" | "fields"> = {
		kind: "alert",
		color: slackAttachmentColor(context.eventType, context.severity),
		imageUrl: context.chartUrl ?? null,
		imageAlt: `${context.ruleName} over the alert window`,
		links: [
			{ label: "Open in Maple", url: linkUrl, primary: true },
			{ label: "✨ Ask Maple AI", url: chatUrl, primary: false },
		],
		footer: [
			"\u{1F341} Maple Alerts",
			// Ahead of the incident: on a renotify it is the only part that differs from the last one.
			...(context.sparkline ? [`\`${context.sparkline}\``] : []),
			...(context.incidentId ? [`Incident \`${context.incidentId}\``] : []),
		],
		sentAtMs: context.sentAtMs ?? null,
	}
	if (templated) {
		return [
			{
				...card,
				title: templated.title,
				summary: truncate(templated.body, MAX_TEMPLATED_BODY_CHARS),
				fields: [],
			},
		]
	}
	return [
		{
			...card,
			title: `${eventTypeEmoji(context.eventType)} ${context.ruleName} — ${formatEventTypeLabel(context.eventType)}`,
			summary: buildSummaryLine(context, (value) => `**${value}**`),
			fields: [
				{
					label: "Severity",
					value: `${severityEmoji(context.severity)} ${formatSeverityLabel(context.severity)}`,
				},
				...(group == null ? [] : [{ label: "Group", value: `\`${group}\`` }]),
			],
		},
	]
}

/**
 * A channel in a chat workspace linked through a chat connector. The connector posts it, with its
 * own HTTP, spans and rate-limit handling; this only says what to post and where.
 */
export const chatTransport: EffectTransport<Config> = {
	kind: "effect",
	type: "chat",
	peerService: "chat",
	providerLabel: "Chat",
	send: (input, deps) =>
		deps
			.postChatAlert({
				orgId: input.context.destination.orgId,
				workspaceId: input.config.workspaceId,
				channelId: input.config.channelId,
				blocks: buildChatAlertBlocks(input),
			})
			.pipe(
				Effect.map((posted) => ({
					providerMessage: `Delivered to ${posted.connectorName} #${input.config.channelName}`,
					providerReference: posted.messageId,
					responseCode: null,
				})),
			),
}
