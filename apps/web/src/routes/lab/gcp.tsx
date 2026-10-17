import { createFileRoute } from "@tanstack/react-router"

import { GcpLab } from "@/lab/gcp-lab"

export const Route = createFileRoute("/lab/gcp")({ component: GcpLab })
