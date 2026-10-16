import { createFileRoute } from "@tanstack/react-router"

import { GcpConnectionsLab } from "@/lab/gcp-connections-lab"

export const Route = createFileRoute("/lab/gcp-connections")({ component: GcpConnectionsLab })
