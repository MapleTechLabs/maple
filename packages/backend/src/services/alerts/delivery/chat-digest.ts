import type { ChatBlock } from "@maple/chat-platform"
import type { AlertSeverity } from "@maple/domain/http"
import {
	alertAccentColor,
	displayGroup,
	eventTypeEmoji,
	formatEventTypeLabel,
	formatSeverityLabel,
	severityEmoji,
	truncate,
} from "../alert-formatting"
import { Array as Arr, String as Str } from "effect"

/** More queued deliveries than this for one chat destination in a tick go out as one digest. */
export const CHAT_DIGEST_THRESHOLD = 3

/** Lines a digest lists before it says how many more there are. */
export const CHAT_DIGEST_MAX_ITEMS = 10

export interface ChatDigestItem {
	readonly ruleName: string
	readonly eventType: string
	readonly severity: AlertSeverity
	readonly groupKey: string | null
	/** Shown in place of the group key when set, e.g. an anomaly's "checkout (production)". */
	readonly groupLabel?: string | null
	readonly signalType?: string
	readonly linkUrl: string
}

/** Markdown link text cannot carry its own brackets. */
const linkText = (value: string) => Str.replace(/[[\]]/g, "")(truncate(value, 80))

const itemLine = (item: ChatDigestItem): string => {
	const group = displayGroup(item)
	return Arr.join(
		[
			`${eventTypeEmoji(item.eventType)} [${linkText(item.ruleName)}](${item.linkUrl})`,
			formatEventTypeLabel(item.eventType),
			`${severityEmoji(item.severity)} ${formatSeverityLabel(item.severity)}`,
			...(group === null ? [] : [`\`${group}\``]),
		],
		" · ",
	)
}

/** One card standing in for a burst: a line per alert, capped, then a count of the rest. */
export const buildChatDigestBlocks = (
	items: ReadonlyArray<ChatDigestItem>,
	alertsUrl: string,
	sentAtMs: number,
): ReadonlyArray<ChatBlock> => {
	const shown = items.slice(0, CHAT_DIGEST_MAX_ITEMS)
	const hidden = items.length - shown.length
	const anyTrigger = Arr.some(items, (item) => item.eventType === "trigger")
	const anyCritical = Arr.some(items, (item) => item.severity === "critical")
	return [
		{
			kind: "alert",
			color: alertAccentColor(anyTrigger ? "trigger" : "resolve", anyCritical ? "critical" : "warning"),
			title: `\u{1F514} ${items.length} alert notifications`,
			summary: Arr.join(
				[...Arr.map(shown, itemLine), ...(hidden > 0 ? [`…and ${hidden} more`] : [])],
				"\n",
			),
			fields: [],
			imageUrl: null,
			imageAlt: "",
			links: [{ label: "Open alerts in Maple", url: alertsUrl, primary: true }],
			footer: ["\u{1F341} Maple Alerts"],
			sentAtMs,
		},
	]
}
