import { createFileRoute } from "@tanstack/react-router"

import { VerdictLab } from "@/lab/verdict-lab"

export const Route = createFileRoute("/lab/verdict")({ component: VerdictLab })
