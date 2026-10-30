import { Option } from "effect"
import { buildSummaryLine } from "../../AlertDeliveryDispatch"
import {
	alertAccentColor,
	displayGroupKey,
	eventTypeEmoji,
	formatAlertHeadline,
	formatSeverityLabel,
	severityEmoji,
	truncate,
} from "../../alert-formatting"
import type { HttpTransport, RenderInput, SecretConfigOf } from "../Transport"

type Config = SecretConfigOf<"google-chat">

const GOOGLE_CHAT_HOST = "chat.googleapis.com"
const SPACE_MESSAGES_PATH = /^\/v1\/spaces\/([A-Za-z0-9_-]+)\/messages$/

/** A card's text budget: well under Google Chat's 32k message cap, so an alert is one message. */
const MAX_TEMPLATED_BODY_CHARS = 2000

/**
 * An incoming webhook URL, as Google Chat's "Apps & integrations → Webhooks" hands it out. The
 * `key` and `token` query parameters are the credential; the path names the space.
 */
export const parseGoogleChatWebhookUrl = (raw: string): Option.Option<{ readonly spaceId: string }> =>
	Option.liftThrowable(() => new URL(raw.trim()))().pipe(
		Option.flatMap((url) => {
			const space = SPACE_MESSAGES_PATH.exec(url.pathname)
			return url.protocol === "https:" &&
				url.host === GOOGLE_CHAT_HOST &&
				space?.[1] !== undefined &&
				url.searchParams.has("key") &&
				url.searchParams.has("token")
				? Option.some({ spaceId: space[1] })
				: Option.none()
		}),
	)

/** Card text paragraphs take a small HTML subset, so every dynamic value is escaped first. */
const escapeHtml = (value: string): string =>
	value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/**
 * A template's Markdown in card HTML, the same subset Telegram gets: `**b**` and `[t](url)`, with
 * http(s) links only. Escaped first, so only the tags built here reach Google Chat.
 */
const markdownToCardHtml = (markdown: string): string =>
	escapeHtml(markdown)
		.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
		.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, text: string, url: string) =>
			/^https?:\/\//i.test(url) ? `<a href="${url}">${text}</a>` : match,
		)
		.replace(/\n/g, "<br>")

const paragraph = (html: string) => ({ textParagraph: { text: html } })

/**
 * Replies land in the alert's own thread: `dedupeKey` is one per rule and group, so a resolve or
 * renotify sits under the trigger it answers. A space without threads posts it top-level.
 */
const threadedUrl = (webhookUrl: string): string =>
	Option.liftThrowable(() => new URL(webhookUrl))().pipe(
		Option.match({
			onNone: () => webhookUrl,
			onSome: (url) => {
				url.searchParams.set("messageReplyOption", "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD")
				return url.toString()
			},
		}),
	)

export const buildGoogleChatMessage = (input: RenderInput<Config>) => {
	const { context, templated, linkUrl, chatUrl } = input
	const accent = alertAccentColor(context.eventType, context.severity)
	const group = displayGroupKey(context.groupKey)
	const title = templated?.title ?? `${eventTypeEmoji(context.eventType)} ${formatAlertHeadline(context)}`
	const lead = templated
		? markdownToCardHtml(truncate(templated.body, MAX_TEMPLATED_BODY_CHARS))
		: escapeHtml(buildSummaryLine(context, (value) => value))
	const footer = [
		...(context.sparkline ? [escapeHtml(context.sparkline)] : []),
		...(context.incidentId ? [`Incident ${escapeHtml(context.incidentId)}`] : []),
		...(context.sentAtMs != null ? [new Date(context.sentAtMs).toISOString()] : []),
	].join("  \u{00B7}  ")
	const details = templated
		? []
		: [
				{
					decoratedText: {
						topLabel: "Severity",
						text: `${severityEmoji(context.severity)} ${formatSeverityLabel(context.severity)}`,
					},
				},
				...(group == null ? [] : [{ decoratedText: { topLabel: "Group", text: escapeHtml(group) } }]),
			]
	return {
		// The notification and the text clients without cards show.
		text: truncate(title, 300),
		cardsV2: [
			{
				cardId: "maple-alert",
				card: {
					header: { title: truncate(title, 200), subtitle: "\u{1F341} Maple Alerts" },
					sections: [
						{
							widgets: [
								paragraph(templated ? lead : `<font color="${accent}"><b>${lead}</b></font>`),
								...details,
								...(context.chartUrl
									? [
											{
												image: {
													imageUrl: context.chartUrl,
													altText: `${context.ruleName} over the alert window`,
												},
											},
										]
									: []),
								{
									buttonList: {
										buttons: [
											{
												text: "Open in Maple",
												onClick: { openLink: { url: linkUrl } },
											},
											{
												text: "✨ Ask Maple AI",
												onClick: { openLink: { url: chatUrl } },
											},
										],
									},
								},
								...(footer.length > 0
									? [paragraph(`<font color="#80868b">${footer}</font>`)]
									: []),
							],
						},
					],
				},
			},
		],
		thread: { threadKey: context.dedupeKey },
	}
}

export const googleChatTransport: HttpTransport<Config> = {
	kind: "http",
	type: "google-chat",
	peerService: "google-chat",
	providerLabel: "Google Chat",
	render: (input: RenderInput<Config>) => ({
		url: threadedUrl(input.config.webhookUrl),
		headers: { "content-type": "application/json; charset=UTF-8" },
		// User-configured URL, checked at save time; the credential is in the query string, which
		// the span never records, so the path (a space id) is safe to annotate.
		guarded: true,
		sensitivePath: false,
		body: JSON.stringify(buildGoogleChatMessage(input)),
	}),
	describeStatus: (status) => {
		if (status === 401 || status === 403) {
			return "Google Chat rejected the webhook — it was revoked, or the space no longer allows apps"
		}
		if (status === 404) return "Google Chat webhook no longer exists — create a new one in the space"
		return null
	},
	ack: (input) => ({
		providerMessage: "Delivered to Google Chat",
		providerReference: input.context.dedupeKey,
	}),
}
