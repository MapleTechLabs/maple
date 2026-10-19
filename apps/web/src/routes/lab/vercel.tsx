import { createFileRoute } from "@tanstack/react-router"

import { VercelIntegrationLab } from "@/lab/vercel-integration-lab"

export const Route = createFileRoute("/lab/vercel")({ component: VercelIntegrationLab })
