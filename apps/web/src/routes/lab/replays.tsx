import { createFileRoute } from "@tanstack/react-router"

import { ReplaysListLab } from "@/lab/replays-list-lab"

export const Route = createFileRoute("/lab/replays")({ component: ReplaysListLab })
