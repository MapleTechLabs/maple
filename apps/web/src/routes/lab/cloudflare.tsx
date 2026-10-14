import { createFileRoute } from "@tanstack/react-router"

import { CloudflareLab } from "@/lab/cloudflare-lab"

export const Route = createFileRoute("/lab/cloudflare")({ component: CloudflareLab })
