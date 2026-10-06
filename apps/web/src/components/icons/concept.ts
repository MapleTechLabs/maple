// The one glyph per product concept, matching the sidebar (dashboard/nav-items.ts).
// A trace, log, error, service or metric reads with the same icon wherever it appears.

import { ChartLineIcon, CircleWarningIcon, FileIcon, PulseIcon, ServerIcon } from "./index"
import type { IconComponent } from "./icon"

export type Concept = "trace" | "log" | "error" | "service" | "metric"

export const CONCEPT_ICON: Record<Concept, IconComponent> = {
	trace: PulseIcon,
	log: FileIcon,
	error: CircleWarningIcon,
	service: ServerIcon,
	metric: ChartLineIcon,
} satisfies Record<Concept, IconComponent>
