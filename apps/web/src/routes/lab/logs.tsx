import { createFileRoute } from "@tanstack/react-router"

import { LogsLab } from "@/lab/logs-lab"

export const Route = createFileRoute("/lab/logs")({ component: LogsLab })
