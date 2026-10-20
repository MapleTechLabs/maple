import type { SessionTokenTotals } from "@maple/agent-sessions"
import type { IconName } from "../../../ui/icon"

export const TOKEN_BUCKETS = [
	{
		key: "input",
		label: "Input",
		fill: "bg-chart-tok-input",
		text: "text-chart-tok-input",
		icon: "PaperPlaneIcon",
	},
	{
		key: "cacheRead",
		label: "Cache read",
		fill: "bg-chart-tok-cache-read",
		text: "text-chart-tok-cache-read",
		icon: "DatabaseIcon",
	},
	{
		key: "cacheWrite",
		label: "Cache write",
		fill: "bg-chart-tok-cache-write",
		text: "text-chart-tok-cache-write",
		icon: "FloppyDiskIcon",
	},
	{
		key: "output",
		label: "Output",
		fill: "bg-chart-tok-output",
		text: "text-chart-tok-output",
		icon: "ChatBubbleIcon",
	},
	{
		key: "reasoning",
		label: "Reasoning",
		fill: "bg-chart-tok-reasoning",
		text: "text-chart-tok-reasoning",
		icon: "ChatBubbleSparkleIcon",
	},
] as const satisfies ReadonlyArray<{
	key: keyof Omit<SessionTokenTotals, "total">
	label: string
	fill: string
	text: string
	icon: IconName
}>
