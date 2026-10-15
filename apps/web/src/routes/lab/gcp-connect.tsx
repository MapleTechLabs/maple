import { createFileRoute } from "@tanstack/react-router"

import { GcpConnectLab } from "@/lab/gcp-connect-lab"

export const Route = createFileRoute("/lab/gcp-connect")({ component: GcpConnectLab })
