import { createFileRoute } from "@tanstack/react-router"

import { KitDisplayLab } from "@/lab/kit/display"

export const Route = createFileRoute("/lab/kit/display")({ component: KitDisplayLab })
