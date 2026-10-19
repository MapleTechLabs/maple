import { createFileRoute } from "@tanstack/react-router"

import { KitContentLab } from "@/lab/kit/content"

export const Route = createFileRoute("/lab/kit/content")({ component: KitContentLab })
