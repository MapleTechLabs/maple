import type { IconName } from "@maple/views/ui/icons.generated"

/**
 * The nine features the Product menu and `/features` lead with, in grid order, each with the
 * dashboard's icon for it. Every other feature (and one added later) is listed after them.
 */
export const PILLARS = [
	{ slug: "distributed-tracing", icon: "NetworkNodesIcon" },
	{ slug: "log-management", icon: "FileIcon" },
	{ slug: "metrics-dashboards", icon: "ChartLineIcon" },
	{ slug: "error-tracking", icon: "CircleXmarkIcon" },
	{ slug: "browser-sessions", icon: "PlayRotateClockwiseIcon" },
	{ slug: "alerts", icon: "BellIcon" },
	{ slug: "uptime-monitoring", icon: "GlobeIcon" },
	{ slug: "ai-mcp-integration", icon: "SparkleIcon" },
	{ slug: "github", icon: "PullRequestIcon" },
] as const satisfies ReadonlyArray<Readonly<{ slug: string; icon: IconName }>>

export type PillarIcon = (typeof PILLARS)[number]["icon"]

export const isPillar = (slug: string): boolean => PILLARS.some((pillar) => pillar.slug === slug)
