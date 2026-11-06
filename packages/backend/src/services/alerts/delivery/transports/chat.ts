import type { ChatAlertBlock, ChatBlock } from "@maple/chat-platform"
import { Effect } from "effect"
import { buildSummaryLine } from "../../AlertDeliveryDispatch"
import {
	displayGroup,
	eventTypeEmoji,
	formatAlertHeadline,
	formatSeverityLabel,
	severityEmoji,
	alertAccentColor,
	truncate,
} from "../../alert-formatting"
import type { DispatchContext } from "../context"
import type { EffectTransport, RenderInput, SecretConfigOf } from "../Transport"

type Config = SecretConfigOf<"chat">

/**
 * A templated body's budget. Under every connector's own message budget, so an alert is always
 * one message — the rest of it is one click away in Maple.
 */
const MAX_TEMPLATED_BODY_CHARS = 1200

/** What the card reads: no destination, so a direct message to a person renders the same card. */
export interface ChatAlertCardInput {
	readonly context: Omit<DispatchContext, "deliveryKey" | "destination" | "publicConfig" | "secretConfig"> & {
		readonly incidentAcknowledgedBy?: string | null
	}
	readonly templated: RenderInput<Config>["templated"]
	readonly linkUrl: string
}

/**
 * The alert as one neutral alert card, which the connector renders in its own dialect — and
 * which is where its mention-neutralising lives, so a rule named `@everyone` pings nobody.
 *
 * The same card the legacy bot destination posts: the event and rule as the title, what was
 * observed against the threshold, severity and group as fields, the chart, an Open in Maple button,
 * and a footer carrying the sparkline, the incident and the time. A rule's own template, when it
 * has one, replaces the title and the summary and drops the fields, as it does there.
 */
/** The name an open, acknowledged incident shows on its alert cards; null otherwise. */
export const incidentAcknowledgedBy = (
	incident: {
		readonly status: string
		readonly acknowledgedAt: number | null
		readonly acknowledgedByName: string | null
	} | null,
): string | null =>
	incident === null || incident.status !== "open" || incident.acknowledgedAt === null
		? null
		: (incident.acknowledgedByName ?? "someone")

/** Only a firing card of an open incident can be acknowledged from chat. */
const ackControl = (context: ChatAlertCardInput["context"]): Pick<ChatAlertBlock, "acknowledge"> =>
	context.incidentId !== null &&
	context.incidentStatus === "open" &&
	(context.eventType === "trigger" || context.eventType === "renotify")
		? {
				acknowledge: {
					incidentId: context.incidentId,
					acknowledgedBy: context.incidentAcknowledgedBy ?? null,
				},
			}
		: {}

export const buildChatAlertBlocks = (input: ChatAlertCardInput): ReadonlyArray<ChatBlock> => {
	const { context, templated, linkUrl } = input
	const group = displayGroup(context)
	const card: Omit<ChatAlertBlock, "title" | "summary" | "fields"> = {
		...ackControl(context),
		kind: "alert",
		color: alertAccentColor(context.eventType, context.severity),
		imageUrl: context.chartUrl ?? null,
		imageAlt: `${context.ruleName} over the alert window`,
		links: [{ label: "Open in Maple", url: linkUrl, primary: true }],
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
			title: `${eventTypeEmoji(context.eventType)} ${formatAlertHeadline(context)}`,
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
