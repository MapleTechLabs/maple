import {
	ChatBubbleIcon,
	ChatBubbleSparkleIcon,
	DatabaseIcon,
	FloppyDiskIcon,
	PaperPlaneIcon,
	type IconComponent,
} from "@/components/icons"

import type { SessionTokenTotals } from "./session-summary"

/**
 * The five disjoint usage buckets, each with the fill its bar segment draws
 * in, the matching text colour, and a glyph for what the tokens WERE — sent,
 * replayed from cache, written to it, replied, thought. Shared by the detail
 * page's Tokens rail and the list row's bar, so a session reads the same in
 * both places. Chart tokens rather than new hues, like the rest of the
 * session page's vocabulary (`span-visuals.ts`), but designated ones: the five
 * are always drawn side by side in a 6px bar, so they need hues spread evenly
 * rather than the per-theme spacing of the chart-1..5 slots.
 */
export const TOKEN_BUCKETS = [
	{
		key: "input",
		label: "Input",
		fill: "bg-chart-tok-input",
		text: "text-chart-tok-input",
		icon: PaperPlaneIcon,
	},
	{
		key: "cacheRead",
		label: "Cache read",
		fill: "bg-chart-tok-cache-read",
		text: "text-chart-tok-cache-read",
		icon: DatabaseIcon,
	},
	{
		key: "cacheWrite",
		label: "Cache write",
		fill: "bg-chart-tok-cache-write",
		text: "text-chart-tok-cache-write",
		icon: FloppyDiskIcon,
	},
	{
		key: "output",
		label: "Output",
		fill: "bg-chart-tok-output",
		text: "text-chart-tok-output",
		icon: ChatBubbleIcon,
	},
	{
		key: "reasoning",
		label: "Reasoning",
		fill: "bg-chart-tok-reasoning",
		text: "text-chart-tok-reasoning",
		icon: ChatBubbleSparkleIcon,
	},
] as const satisfies ReadonlyArray<{
	key: keyof Omit<SessionTokenTotals, "total">
	label: string
	fill: string
	text: string
	icon: IconComponent
}>

export type TokenBucketKey = (typeof TOKEN_BUCKETS)[number]["key"]
