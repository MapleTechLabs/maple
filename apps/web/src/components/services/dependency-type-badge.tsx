import { cn } from "@maple/ui/utils"
import {
	DatabaseIcon,
	GlobeIcon,
	NetworkNodesIcon,
	PaperPlaneIcon,
	ServerIcon,
} from "@/components/icons"

/**
 * Visual identity for one downstream-dependency category surfaced on the
 * service-detail Dependencies tab.
 *
 *  - service   → another internal service (from `serviceDependencies`)
 *  - database  → DB target          (from `serviceDbEdges`)
 *  - http      → external HTTP host (from `serviceExternalEdges`)
 *  - messaging → message queue      (from `serviceExternalEdges`)
 *  - rpc       → RPC target         (from `serviceExternalEdges`)
 */
export type DependencyKind = "service" | "database" | "http" | "messaging" | "rpc"

interface DependencyTypeBadgeProps {
	kind: DependencyKind
	className?: string
}

const labels: Record<DependencyKind, string> = {
	service: "Service",
	database: "Database",
	http: "HTTP",
	messaging: "Queue",
	rpc: "RPC",
}

// Token-based palette so the badge tracks the user's theme. Each tone pairs a
// soft tinted background with a muted foreground; consistent visual weight so
// no single category dominates the column read.
const tones: Record<DependencyKind, string> = {
	service: "bg-severity-info/10 text-severity-info border-severity-info/20",
	database: "bg-amber-500/10 text-amber-600 border-amber-500/20 dark:text-amber-300",
	http: "bg-foreground/5 text-muted-foreground border-border",
	messaging: "bg-violet-500/10 text-violet-600 border-violet-500/20 dark:text-violet-300",
	rpc: "bg-cyan-500/10 text-cyan-600 border-cyan-500/20 dark:text-cyan-300",
}

function getIcon(kind: DependencyKind) {
	switch (kind) {
		case "service":
			return ServerIcon
		case "database":
			return DatabaseIcon
		case "http":
			return GlobeIcon
		case "messaging":
			return PaperPlaneIcon
		case "rpc":
			return NetworkNodesIcon
	}
}

export function DependencyTypeBadge({ kind, className }: DependencyTypeBadgeProps) {
	const Icon = getIcon(kind)
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
				tones[kind],
				className,
			)}
		>
			<Icon size={10} />
			{labels[kind]}
		</span>
	)
}
