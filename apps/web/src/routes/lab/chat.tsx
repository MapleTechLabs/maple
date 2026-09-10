import { createFileRoute } from "@tanstack/react-router"

import { ChatLab } from "@/lab/chat-lab"

export const Route = createFileRoute("/lab/chat")({ component: ChatLab })
