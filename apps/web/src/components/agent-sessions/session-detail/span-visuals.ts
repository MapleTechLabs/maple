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
	CircleQuestionIcon,
	DotsIcon,
	FaceRobotIcon,
	GearIcon,
	MediaPauseIcon,
	PixelSparkleIcon,
	type IconComponent,
} from "@/components/icons"

import type { AiSpanCategory } from "@/lib/agent-sessions/session-turns"
import type { OccupancyKind } from "@/lib/agent-sessions/session-summary"

// Idle and unaccounted are the absence of work, so they get the neutral rather
// than a hue; unaccounted is denser because it is usually a percent or two of
// the bar and washes out at that width.
const NO_WORK_FILL = "bg-muted-foreground/40"
const UNACCOUNTED_FILL = "bg-muted-foreground/70"

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

/** Segment background in the header's occupancy bar. */
export const OCCUPANCY_FILL = {
	idle: NO_WORK_FILL,
	ttft: "bg-chart-ai-ttft",
	inference: "bg-chart-ai-inference",
	tool: "bg-chart-ai-tool",
	unaccounted: UNACCOUNTED_FILL,
} satisfies Record<OccupancyKind, string>

/** Legend glyph for an occupancy segment: the kind of time reads by shape
 *  first, with the bar's hue as reinforcement — the same rule the flow view's
 *  nodes follow. */
export const OCCUPANCY_ICON = {
	idle: MediaPauseIcon,
	ttft: BoltIcon,
	inference: PixelSparkleIcon,
	tool: GearIcon,
	unaccounted: CircleQuestionIcon,
} satisfies Record<OccupancyKind, IconComponent>

/** The bar's tokens as text color, for the legend glyphs. */
export const OCCUPANCY_TEXT = {
	idle: "text-muted-foreground/70",
	ttft: "text-chart-ai-ttft",
	inference: "text-chart-ai-inference",
	tool: "text-chart-ai-tool",
	unaccounted: "text-muted-foreground",
} satisfies Record<OccupancyKind, string>

/** Legend text for an occupancy segment. */
export const OCCUPANCY_LABEL = {
	idle: "Idle",
	ttft: "Time to first token",
	inference: "Inference",
	tool: "Tool execution",
	unaccounted: "Unaccounted",
} satisfies Record<OccupancyKind, string>
