import { createFileRoute } from "@tanstack/react-router"

import { AgentOverviewLab } from "@/lab/agent-overview-lab"

export const Route = createFileRoute("/lab/agent-overview")({ component: AgentOverviewLab })
