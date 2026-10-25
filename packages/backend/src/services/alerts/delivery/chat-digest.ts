import type { ChatBlock } from "@maple/chat-platform"
import type { AlertSeverity } from "@maple/domain/http"
import {
	alertAccentColor,
	displayGroupKey,
	eventTypeEmoji,
	formatEventTypeLabel,
	formatSeverityLabel,
	severityEmoji,
	truncate,
} from "../alert-formatting"

/** More queued deliveries than this for one chat destination in a tick go out as one digest. */
export const CHAT_DIGEST_THRESHOLD = 3

/** Lines a digest lists before it says how many more there are. */
export const CHAT_DIGEST_MAX_ITEMS = 10

export interface ChatDigestItem {
	readonly ruleName: string
	readonly eventType: string
	readonly severity: AlertSeverity
	readonly groupKey: string | null
	readonly linkUrl: string
}

/** Markdown link text cannot carry its own brackets. */
const linkText = (value: string) => truncate(value, 80).replace(/[[\]]/g, "")

const itemLine = (item: ChatDigestItem): string => {
	const group = displayGroupKey(item.groupKey)
	return [
		`${eventTypeEmoji(item.eventType)} [${linkText(item.ruleName)}](${item.linkUrl})`,
		formatEventTypeLabel(item.eventType),
		`${severityEmoji(item.severity)} ${formatSeverityLabel(item.severity)}`,
		...(group === null ? [] : [`\`${group}\``]),
	].join(" · ")
}

/** One card standing in for a burst: a line per alert, capped, then a count of the rest. */
export const buildChatDigestBlocks = (
	items: ReadonlyArray<ChatDigestItem>,
	alertsUrl: string,
	sentAtMs: number,
): ReadonlyArray<ChatBlock> => {
	const shown = items.slice(0, CHAT_DIGEST_MAX_ITEMS)
	const hidden = items.length - shown.length
	const anyTrigger = items.some((item) => item.eventType === "trigger")
	const anyCritical = items.some((item) => item.severity === "critical")
	return [
		{
			kind: "alert",
			color: alertAccentColor(anyTrigger ? "trigger" : "resolve", anyCritical ? "critical" : "warning"),
			title: `\u{1F514} ${items.length} alert notifications`,
			summary: [...shown.map(itemLine), ...(hidden > 0 ? [`…and ${hidden} more`] : [])].join("\n"),
			fields: [],
			imageUrl: null,
			imageAlt: "",
			links: [{ label: "Open alerts in Maple", url: alertsUrl, primary: true }],
			footer: ["\u{1F341} Maple Alerts"],
			sentAtMs,
		},
	]
}
