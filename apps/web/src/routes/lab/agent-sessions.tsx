import { createFileRoute } from "@tanstack/react-router"

import { AgentSessionsListLab } from "@/lab/agent-sessions-list-lab"

export const Route = createFileRoute("/lab/agent-sessions")({ component: AgentSessionsListLab })
