import { Link } from "@tanstack/react-router"

import { cn } from "@maple/ui/lib/utils"

/**
 * The two links a chat table can produce. They are their own components rather
 * than inline `Link`s in the cell renderer so that the hover card each of them
 * will eventually carry — a trace's root span and duration, a service's health —
 * has exactly one place to be added, on both this surface and any later one.
 *
 * Both open in a new tab, matching the inline reference cards: a chat panel is
 * usually the thing the user is reading, and navigating it away loses the thread.
 */

const REF_CLASS =
	"underline decoration-muted-foreground/40 decoration-dotted underline-offset-2 hover:text-primary hover:decoration-primary/50"

export function TraceRef({ traceId, className }: { traceId: string; className?: string }) {
	return (
		<Link
			to="/traces/$traceId"
			params={{ traceId }}
			target="_blank"
			rel="noreferrer"
			title={traceId}
			className={cn("font-mono text-foreground", REF_CLASS, className)}
		>
			{traceId}
		</Link>
	)
}

export function ServiceRef({ name, className }: { name: string; className?: string }) {
	return (
		<Link
			to="/services/$serviceName"
			params={{ serviceName: name }}
			target="_blank"
			rel="noreferrer"
			title={name}
			className={cn("text-foreground", REF_CLASS, className)}
		>
			{name}
		</Link>
	)
}
