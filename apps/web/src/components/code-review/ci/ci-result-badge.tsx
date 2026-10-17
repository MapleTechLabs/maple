import { Badge } from "@maple/ui/components/ui/badge"
import { TONE_SOFT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"

import { ciResultLabel, ciResultTone } from "./ci-format"

/** A run's result; a rerun says which attempt it was. */
export function CiResultBadge({
	result,
	attempt = 1,
	className,
}: {
	result: string
	attempt?: number
	className?: string
}) {
	return (
		<span className={cn("inline-flex items-center gap-1.5", className)}>
			<Badge size="sm" className={TONE_SOFT[ciResultTone(result)]}>
				{ciResultLabel(result)}
			</Badge>
			{attempt > 1 ? <span className="text-xs text-muted-foreground">attempt {attempt}</span> : null}
		</span>
	)
}
