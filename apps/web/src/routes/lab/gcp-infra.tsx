import { createFileRoute } from "@tanstack/react-router"

import { GcpInfraLab } from "@/lab/gcp-infra-lab"

export const Route = createFileRoute("/lab/gcp-infra")({ component: GcpInfraLab })
