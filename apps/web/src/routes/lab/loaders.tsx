import { createFileRoute } from "@tanstack/react-router"

import { LoadersLab } from "@/lab/loaders-lab"

export const Route = createFileRoute("/lab/loaders")({ component: LoadersLab })
