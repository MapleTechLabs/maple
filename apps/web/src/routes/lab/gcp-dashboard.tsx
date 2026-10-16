import { createFileRoute } from "@tanstack/react-router"

import { GcpDashboardLab } from "@/lab/gcp-dashboard-lab"

export const Route = createFileRoute("/lab/gcp-dashboard")({ component: GcpDashboardLab })
