import type { AgentTimeKind, AiSpanCategory } from "@maple/agent-sessions"
import type { IconName } from "../../../ui/icon"

// Span visuals, as icon names: one token
// per kind of work, read by the time breakdown, the waterfall and the flow.

const NO_WORK_FILL = "bg-muted-foreground/40"

export const CATEGORY_FILL = {
	agent: "bg-chart-ai-agent",
	inference: "bg-chart-ai-inference",
	tool: "bg-chart-ai-tool",
	other: NO_WORK_FILL,
} satisfies Record<AiSpanCategory, string>

export const CATEGORY_ICON = {
	agent: "FaceRobotIcon",
	inference: "PixelSparkleIcon",
	tool: "GearIcon",
	other: "DotsIcon",
} satisfies Record<AiSpanCategory, IconName>

export const CATEGORY_TEXT = {
	agent: "text-chart-ai-agent",
	inference: "text-chart-ai-inference",
	tool: "text-chart-ai-tool",
	other: "text-muted-foreground",
} satisfies Record<AiSpanCategory, string>

export type TimeBandKind = AgentTimeKind | "idle"

export const AGENT_TIME_FILL = {
	ttft: "bg-chart-ai-ttft",
	inference: "bg-chart-ai-inference",
	tool: "bg-chart-ai-tool",
	idle: NO_WORK_FILL,
} satisfies Record<TimeBandKind, string>

export const AGENT_TIME_ICON = {
	ttft: "BoltIcon",
	inference: "PixelSparkleIcon",
	tool: "GearIcon",
	idle: "MediaPauseIcon",
} satisfies Record<TimeBandKind, IconName>

export const AGENT_TIME_TEXT = {
	ttft: "text-chart-ai-ttft",
	inference: "text-chart-ai-inference",
	tool: "text-chart-ai-tool",
	idle: "text-foreground-subtle",
} satisfies Record<TimeBandKind, string>

export const AGENT_TIME_LABEL = {
	ttft: "Time to first token",
	inference: "Inference",
	tool: "Tool execution",
	idle: "Idle",
} satisfies Record<TimeBandKind, string>
