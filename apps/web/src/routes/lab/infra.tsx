import { createFileRoute } from "@tanstack/react-router"

import { InfraLab } from "@/lab/infra-lab"

export const Route = createFileRoute("/lab/infra")({ component: InfraLab })
