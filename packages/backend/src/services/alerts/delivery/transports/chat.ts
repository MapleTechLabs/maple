import type { ChatBlock } from "@maple/chat-platform"
import { Effect } from "effect"
import { buildSummaryLine } from "../../AlertDeliveryDispatch"
import {
	displayGroupKey,
	eventTypeEmoji,
	formatEventTypeLabel,
	formatSeverityLabel,
	formatWindow,
	severityEmoji,
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
 * The alert as neutral blocks: one prose block of standard markdown, which the connector renders
 * in its own dialect — and which is where its mention-neutralising lives, so a rule named
 * `@everyone` pings nobody.
 *
 * The same facts the other chat providers surface: the event and rule, what was observed against
 * the threshold, severity, window and group, the sparkline, and both links. A rule's own template,
 * when it has one, replaces the title and summary.
 */
export const buildChatAlertBlocks = (input: RenderInput<Config>): ReadonlyArray<ChatBlock> => {
	const { context, templated, linkUrl, chatUrl } = input
	const links = `[Open in Maple](${linkUrl}) · [Ask Maple AI](${chatUrl})`
	const sparkline = context.sparkline ? [`\`${context.sparkline}\``] : []
	if (templated) {
		return [
			{
				kind: "prose",
				markdown: [
					`**${templated.title}**`,
					truncate(templated.body, MAX_TEMPLATED_BODY_CHARS),
					...sparkline,
					links,
				].join("\n\n"),
			},
		]
	}
	const group = displayGroupKey(context.groupKey)
	const details = [
		`**Severity** ${severityEmoji(context.severity)} ${formatSeverityLabel(context.severity)}`,
		`**Window** ${formatWindow(context.windowMinutes)}`,
		...(group == null ? [] : [`**Group** \`${group}\``]),
	].join(" · ")
	return [
		{
			kind: "prose",
			markdown: [
				`${eventTypeEmoji(context.eventType)} **${context.ruleName}** — ${formatEventTypeLabel(context.eventType)}`,
				buildSummaryLine(context, (value) => `**${value}**`),
				details,
				...sparkline,
				links,
			].join("\n\n"),
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
