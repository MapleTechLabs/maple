import { Schema } from "effect"
import type { IconName } from "@maple/views/ui/icon"

/** The tools and places a setup step runs in. */
export const ToolId = Schema.Literals([
	"helm",
	"alchemy",
	"terraform",
	"kubernetes",
	"docker",
	"host",
	"cloudshell",
	"console",
])
export type ToolId = typeof ToolId.Type

/** Each tool's one label and mark, which every picker and tab shows. */
export const TOOL_MARKS = {
	helm: { label: "Helm", icon: "HelmIcon" },
	alchemy: { label: "Alchemy", icon: "AlchemyIcon" },
	terraform: { label: "Terraform", icon: "TerraformIcon" },
	kubernetes: { label: "Kubernetes", icon: "KubernetesIcon" },
	docker: { label: "Docker", icon: "DockerIcon" },
	host: { label: "Host", icon: "ServerIcon" },
	cloudshell: { label: "CloudShell", icon: "SquareTerminalIcon" },
	console: { label: "Console", icon: "MonitorIcon" },
} as const satisfies Record<ToolId, Readonly<{ label: string; icon: IconName }>>

export const toolMark = (tool: ToolId): Readonly<{ label: string; icon: IconName }> => TOOL_MARKS[tool]
