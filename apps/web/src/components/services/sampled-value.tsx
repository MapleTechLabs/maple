import type { ReactNode } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import { cn } from "@maple/ui/lib/utils"

interface SampledValueProps {
	value: ReactNode
	/** True when the value was extrapolated from sampled traces; prefixes "~". */
	estimated: boolean
	/** Shown on hover when estimated, e.g. "Estimated ×10 from 1.2 traced req/s". */
	tooltip?: ReactNode
	className?: string
}

/** A count or rate that may be a sampling estimate. Renders inline (no wrapper) unless styled or explained. */
export function SampledValue({ value, estimated, tooltip, className }: SampledValueProps) {
	const content = (
		<>
			{estimated ? "~" : ""}
			{value}
		</>
	)
	if (estimated && tooltip !== undefined) {
		return (
			<Tooltip>
				<TooltipTrigger render={<span />} className={cn("cursor-help", className)}>
					{content}
				</TooltipTrigger>
				<TooltipContent>{tooltip}</TooltipContent>
			</Tooltip>
		)
	}
	if (className === undefined) return content
	return <span className={className}>{content}</span>
}
