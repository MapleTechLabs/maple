// The session page's shared color vocabulary: one token per kind of work, read
// identically by the header's breakdown bar, the waterfall's dots and bars and
// the flow view's nodes. The four kinds have designated `chart-ai-*` hues
// rather than chart-1..5 slots, for the reason the token buckets do: the
// numbered slots are spaced per theme, and in dark they landed TTFT (chart-3)
// and tool (chart-4) 0.08 apart in oklab — one band to the eye in a 16px bar,
// with inference only 0.18 off the same pair. The designated hues sit ~85°
// apart in both themes.

import {
	BoltIcon,
	DotsIcon,
	FaceRobotIcon,
	GearIcon,
	PixelSparkleIcon,
	type IconComponent,
} from "@/components/icons"

import type { AiSpanCategory } from "@/lib/agent-sessions/session-turns"
import type { AgentTimeKind } from "@/lib/agent-sessions/session-summary"

// A span that is neither a model call nor a tool is not a class of work, so it
// gets the neutral rather than a hue of its own.
const NO_WORK_FILL = "bg-muted-foreground/40"

/** Bar and dot background, per span category. */
export const CATEGORY_FILL = {
	agent: "bg-chart-ai-agent",
	inference: "bg-chart-ai-inference",
	tool: "bg-chart-ai-tool",
	other: NO_WORK_FILL,
} satisfies Record<AiSpanCategory, string>

/** Flow node glyph, per span category: the kind of work reads by shape, with
 *  the hue as reinforcement — the same rule `investigations/flow` follows.
 *  `other` never earns a flow node; the entry exists so the record is total. */
export const CATEGORY_ICON = {
	agent: FaceRobotIcon,
	inference: PixelSparkleIcon,
	tool: GearIcon,
	other: DotsIcon,
} satisfies Record<AiSpanCategory, IconComponent>

/** The same tokens as `CATEGORY_FILL`, as text color for the glyphs. */
export const CATEGORY_TEXT = {
	agent: "text-chart-ai-agent",
	inference: "text-chart-ai-inference",
	tool: "text-chart-ai-tool",
	other: "text-muted-foreground",
} satisfies Record<AiSpanCategory, string>

/** Band background in the agent-time breakdown. */
export const AGENT_TIME_FILL = {
	ttft: "bg-chart-ai-ttft",
	inference: "bg-chart-ai-inference",
	tool: "bg-chart-ai-tool",
} satisfies Record<AgentTimeKind, string>

/** Legend glyph for a class of agent time: the kind of work reads by shape
 *  first, with the band's hue as reinforcement — the same rule the flow view's
 *  nodes follow. */
export const AGENT_TIME_ICON = {
	ttft: BoltIcon,
	inference: PixelSparkleIcon,
	tool: GearIcon,
} satisfies Record<AgentTimeKind, IconComponent>

/** The bands' tokens as text color, for the legend glyphs. */
export const AGENT_TIME_TEXT = {
	ttft: "text-chart-ai-ttft",
	inference: "text-chart-ai-inference",
	tool: "text-chart-ai-tool",
} satisfies Record<AgentTimeKind, string>

/** Legend text for a class of agent time. */
export const AGENT_TIME_LABEL = {
	ttft: "Time to first token",
	inference: "Inference",
	tool: "Tool execution",
} satisfies Record<AgentTimeKind, string>
