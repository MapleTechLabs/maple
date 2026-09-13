import { createFileRoute } from "@tanstack/react-router"

import { TimeRangeLab } from "@/lab/time-range-lab"

export const Route = createFileRoute("/lab/time-range")({ component: TimeRangeLab })
