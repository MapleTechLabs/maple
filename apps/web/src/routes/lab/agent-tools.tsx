import { createFileRoute } from "@tanstack/react-router"

import { AgentToolsLab } from "@/lab/agent-tools-lab"

export const Route = createFileRoute("/lab/agent-tools")({ component: AgentToolsLab })
