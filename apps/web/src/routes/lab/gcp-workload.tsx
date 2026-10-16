import { createFileRoute } from "@tanstack/react-router"

import { GcpWorkloadLab } from "@/lab/gcp-workload-lab"

export const Route = createFileRoute("/lab/gcp-workload")({ component: GcpWorkloadLab })
