import { createFileRoute } from "@tanstack/react-router"

import { AlertsLab } from "@/lab/alerts-lab"

export const Route = createFileRoute("/lab/alerts")({ component: AlertsLab })
