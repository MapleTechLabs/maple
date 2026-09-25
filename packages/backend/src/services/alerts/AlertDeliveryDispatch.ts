/**
 * Message RENDERING for the chat-style providers, plus the "Ask Maple AI"
 * deep-link and the template resolver.
 *
 * Transport — which provider gets which request, how it is sent, how failures
 * are classified — lives in `./delivery`. This module is pure: everything here
 * is a value in, a value out, which is what makes the Discord/Telegram
 * output assertable without any HTTP stub.
 */
import type {
	AlertComparator,
	AlertDestinationType,
	AlertEventType,
	AlertSignalType,
	AlertSeverity,
} from "@maple/domain/http"
import type { DispatchContext } from "./delivery/context"
import {
	comparatorBreachPhrase,
	discordEmbedColor,
	displayGroupKey,
	eventTypeEmoji,
	formatComparator,
	formatEventTypeLabel,
	formatObservedSummary,
	formatSeverityLabel,
	formatSignalLabel,
	formatSignalMetric,
	formatThresholdSummary,
	formatWindow,
	signalDisplayOf,
	truncate,
	type TemplateRenderContext,
} from "./alert-formatting"
import { DEFAULT_BODY_TEMPLATE, DEFAULT_TITLE_TEMPLATE } from "./alert-templating/defaultTemplates"
import {
	hasCustomTemplate,
	renderTemplate,
	resolveTemplate,
	type TemplateContext,
} from "./alert-templating/renderer"

/* -------------------------------------------------------------------------- */
/*  Chat deep-link helper                                                     */
/* -------------------------------------------------------------------------- */

export interface ChatUrlContext {
	readonly ruleId: string
	readonly ruleName: string
	readonly incidentId: string | null
	readonly dedupeKey: string
	readonly eventType: AlertEventType
	readonly signalType: AlertSignalType
	readonly severity: AlertSeverity
	readonly comparator: AlertComparator
	readonly threshold: number
	readonly thresholdUpper: number | null
	readonly value: number | null
	readonly windowMinutes: number
	readonly groupKey: string | null
	readonly sampleCount: number | null
}

const toBase64Url = (raw: string): string =>
	Buffer.from(raw, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

/**
 * "Ask Maple AI" deep-link. Points at the incident-scoped diagnosis page, which
 * auto-generates the AI diagnosis and hosts the alert chat alongside it. The
 * encoded alert context is carried so the page renders + seeds the chat without
 * a round-trip. When there is no incident row yet (e.g. a `test` notification)
 * we fall back to the generic chat surface.
 */
export const buildAlertChatUrl = (baseUrl: string, context: ChatUrlContext): string => {
	const alertJson = JSON.stringify({
		ruleId: context.ruleId,
		ruleName: context.ruleName,
		incidentId: context.incidentId,
		eventType: context.eventType,
		signalType: context.signalType,
		severity: context.severity,
		comparator: context.comparator,
		threshold: context.threshold,
		thresholdUpper: context.thresholdUpper,
		value: context.value,
		windowMinutes: context.windowMinutes,
		groupKey: context.groupKey,
		sampleCount: context.sampleCount,
	})
	const encoded = toBase64Url(alertJson)
	if (context.incidentId) {
		return `${baseUrl}/alerts/incidents/${encodeURIComponent(context.incidentId)}?alert=${encoded}`
	}
	const params = new URLSearchParams({
		mode: "alert",
		tab: `alert-${context.dedupeKey}`,
		alert: encoded,
	})
	return `${baseUrl}/chat?${params.toString()}`
}

/**
 * One human-readable sentence describing what happened — the message lead
 * (title as subject line, then a short clear sentence, with details relegated
 * to fields/footer).
 */
type SummaryLineContext = Pick<
	DispatchContext,
	| "eventType"
	| "signalType"
	| "signalDisplay"
	| "comparator"
	| "threshold"
	| "thresholdUpper"
	| "value"
	| "windowMinutes"
>

/**
 * Parameterized over `em` (the provider's emphasis marker) rather than
 * duplicated per provider: the three-branch wording is the part that would
 * drift, and emphasis is the only thing the providers disagree on here.
 * Telegram passes the identity — it escapes the finished line and puts its bold
 * in the title, because `comparatorBreachPhrase` embeds `<`/`>` comparators
 * that HTML mode would otherwise read as tags.
 */
export const buildSummaryLine = (context: SummaryLineContext, em: (value: string) => string): string => {
	const signal = formatSignalLabel(context)
	const observed = formatSignalMetric(context.value, signalDisplayOf(context))
	const window = formatWindow(context.windowMinutes)
	if (context.eventType === "test") {
		return `This is a test notification. Live alerts fire when ${em(signal)} is ${comparatorBreachPhrase(context)} over a ${window} window.`
	}
	if (context.eventType === "resolve") {
		const now = context.value != null ? ` — now ${em(observed)}` : ""
		return `${em(signal)} is back within its threshold (${formatThresholdSummary(context)})${now}.`
	}
	return `${em(signal)} is ${em(observed)} — ${comparatorBreachPhrase(context)}, measured over the last ${window}.`
}

/**
 * Discord has no context block, so the sparkline rides in the footer — the one
 * line that is small enough not to compete with the numbers above it. Shared by
 * both embed builders: they had drifted apart once already.
 */
/** Discord renders `embed.image` full width under the fields. */
const discordImage = (context: Pick<DispatchContext, "chartUrl">) =>
	context.chartUrl ? { image: { url: context.chartUrl } } : {}

const discordFooterText = (context: Pick<DispatchContext, "sparkline">): string =>
	context.sparkline ? `\u{1F341} Maple Alerts  ·  ${context.sparkline}` : "\u{1F341} Maple Alerts"

export const buildDiscordEmbeds = (context: DispatchContext, linkUrl: string, chatUrl: string) => [
	{
		title: `${eventTypeEmoji(context.eventType)} ${context.ruleName} — ${formatEventTypeLabel(context.eventType)}`,
		url: linkUrl,
		color: discordEmbedColor(context.eventType, context.severity),
		fields: [
			{ name: "Severity", value: context.severity, inline: true },
			{ name: "Signal", value: formatSignalLabel(context), inline: true },
			{ name: "Group", value: displayGroupKey(context.groupKey) ?? "all", inline: true },
			{ name: "Observed", value: formatObservedSummary(context), inline: true },
			{ name: "Window", value: formatWindow(context.windowMinutes), inline: true },
			{
				name: "Links",
				value: `[Open in Maple](${linkUrl}) · [Ask Maple AI](${chatUrl})`,
				inline: false,
			},
		],
		...discordImage(context),
		footer: { text: discordFooterText(context) },
	},
]

/* -------------------------------------------------------------------------- */
/*  Telegram                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Telegram's `parse_mode: "HTML"` accepts only a small tag set (`b`, `i`,
 * `code`, `pre`, `a`, `s`, `u`, `tg-spoiler`) and rejects the whole message
 * with 400 `can't parse entities` if anything else looks like a tag. So every
 * dynamic value is escaped and the markup is added afterwards — note that this
 * is not merely an injection concern: `comparatorBreachPhrase` legitimately
 * produces `> 5%`, which is a parse failure unescaped.
 */
const escapeTelegramHtml = (value: string): string =>
	value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/** Telegram's hard cap on `sendMessage.text`. */
const TELEGRAM_TEXT_LIMIT = 4096

const telegramFooter = (context: Pick<DispatchContext, "sentAtMs" | "incidentId" | "sparkline">): string => {
	const parts = ["\u{1F341} Maple Alerts"]
	if (context.sparkline) parts.push(`<code>${escapeTelegramHtml(context.sparkline)}</code>`)
	if (context.incidentId) parts.push(`Incident <code>${escapeTelegramHtml(context.incidentId)}</code>`)
	if (context.sentAtMs != null) parts.push(new Date(context.sentAtMs).toISOString())
	return parts.join("  \u{00B7}  ")
}

const telegramDetailLine = (
	context: Pick<DispatchContext, "severity" | "groupKey" | "windowMinutes">,
): string => {
	const group = displayGroupKey(context.groupKey)
	const parts = [
		`<b>Severity</b> ${escapeTelegramHtml(formatSeverityLabel(context.severity))}`,
		`<b>Window</b> ${escapeTelegramHtml(formatWindow(context.windowMinutes))}`,
	]
	if (group != null) parts.push(`<b>Group</b> <code>${escapeTelegramHtml(group)}</code>`)
	return parts.join("  \u{00B7}  ")
}

const telegramBody = (title: string, lines: ReadonlyArray<string>): string =>
	truncate([title, "", ...lines].join("\n"), TELEGRAM_TEXT_LIMIT)

/** No link arguments: Telegram carries both links in the inline keyboard. */
export const buildTelegramText = (context: DispatchContext): string => {
	const title = `${eventTypeEmoji(context.eventType)} <b>${escapeTelegramHtml(context.ruleName)}</b> \u{2014} ${escapeTelegramHtml(formatEventTypeLabel(context.eventType))}`
	return telegramBody(title, [
		escapeTelegramHtml(buildSummaryLine(context, (value) => value)),
		"",
		telegramDetailLine(context),
		telegramFooter(context),
	])
}

/**
 * Minimal Markdown -> Telegram HTML transform for user-authored templates:
 * `**b**` -> `<b>b</b>`, `[t](url)` -> `<a href="url">t</a>`.
 *
 * Escaped BEFORE the rewrites, so only the tags this function builds itself
 * reach Telegram. Link targets are
 * restricted to http/https: Telegram also resolves `tg://` URLs, which would
 * let a template author aim a button at an arbitrary in-app action.
 */
const markdownToTelegramHtml = (markdown: string): string =>
	escapeTelegramHtml(markdown)
		.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
		.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, text: string, url: string) =>
			/^https?:\/\//i.test(url) ? `<a href="${url.replaceAll('"', "%22")}">${text}</a>` : match,
		)

export const buildTelegramTextFromTemplate = (
	title: string,
	body: string,
	context: Pick<DispatchContext, "sentAtMs" | "incidentId" | "sparkline">,
): string =>
	telegramBody(`<b>${escapeTelegramHtml(title)}</b>`, [
		markdownToTelegramHtml(body),
		"",
		telegramFooter(context),
	])

/* -------------------------------------------------------------------------- */
/*  Templated notifications                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The subset of {@link DispatchContext} the templating layer reads. Narrowed so
 * it can be exercised in tests without constructing a destination row / secret
 * config (which a full `DispatchContext` requires). The full context satisfies it.
 */
/**
 * Build the flat `{{ variable }}` context for templated notifications. Every
 * value is a pre-formatted string, reusing the same helpers the hardcoded
 * formatters use, so templated and default output stay consistent.
 */
export const buildTemplateContext = (
	context: TemplateRenderContext,
	linkUrl: string,
	chatUrl: string,
): TemplateContext => {
	const display = signalDisplayOf(context)
	return {
		"rule.name": context.ruleName,
		"rule.id": context.ruleId,
		"event.type": context.eventType,
		"event.label": formatEventTypeLabel(context.eventType),
		"event.emoji": eventTypeEmoji(context.eventType),
		severity: context.severity,
		// Stays the raw query-kind enum for template back-compat; `signal.label`
		// is the human-readable name of what the rule measures.
		signal: context.signalType,
		"signal.label": display.label,
		"comparator.label": formatComparator(context.comparator),
		threshold: formatSignalMetric(context.threshold, display),
		thresholdUpper:
			context.thresholdUpper != null ? formatSignalMetric(context.thresholdUpper, display) : "",
		value: formatSignalMetric(context.value, display),
		observed: formatSignalMetric(context.value, display),
		"observed.summary": formatObservedSummary(context),
		sampleCount: context.sampleCount != null ? String(context.sampleCount) : "",
		group: displayGroupKey(context.groupKey) ?? "all",
		window: formatWindow(context.windowMinutes),
		incidentId: context.incidentId ?? "",
		incidentStatus: context.incidentStatus,
		dedupeKey: context.dedupeKey,
		"links.app": linkUrl,
		linkUrl,
		"links.chat": chatUrl,
		chatUrl,
		sentAt: context.sentAtMs != null ? new Date(context.sentAtMs).toISOString() : "",
	}
}

/**
 * Resolve + render the effective title/body for a destination. Returns `null`
 * when the rule has no custom template (caller falls back to the hardcoded
 * formatter) or when rendering fails for any reason — templating must never
 * block delivery.
 */
export const renderTitleBody = (
	context: TemplateRenderContext,
	destinationType: AlertDestinationType,
	linkUrl: string,
	chatUrl: string,
): { title: string; body: string } | null => {
	const resolved = resolveTemplate(context.template, destinationType)
	if (!hasCustomTemplate(resolved)) return null
	try {
		const templateCtx = buildTemplateContext(context, linkUrl, chatUrl)
		const title =
			renderTemplate(resolved.title ?? DEFAULT_TITLE_TEMPLATE, templateCtx).text.trim() ||
			context.ruleName
		const body = renderTemplate(resolved.body ?? DEFAULT_BODY_TEMPLATE, templateCtx).text
		return { title, body }
	} catch {
		return null
	}
}

export const buildDiscordEmbedsFromTemplate = (
	title: string,
	body: string,
	context: Pick<DispatchContext, "eventType" | "severity" | "sparkline" | "chartUrl">,
	linkUrl: string,
	chatUrl: string,
) => [
	{
		title: truncate(title, 256),
		url: linkUrl,
		color: discordEmbedColor(context.eventType, context.severity),
		description: truncate(body, 4096),
		fields: [
			{
				name: "Links",
				value: `[Open in Maple](${linkUrl}) · [Ask Maple AI](${chatUrl})`,
				inline: false,
			},
		],
		...discordImage(context),
		footer: { text: discordFooterText(context) },
	},
]

/**
 * Re-exported for the many call sites that still import the dispatch value
 * types from here. They now live in `./delivery/context`; the collapse onto one
 * canonical notification value is a later stage.
 */
export type { DispatchContext } from "./delivery/context"
