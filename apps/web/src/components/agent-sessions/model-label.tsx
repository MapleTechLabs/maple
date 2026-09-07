import { cn } from "@maple/ui/lib/utils"

import type { DetectedModel } from "@/hooks/use-detected-models"
import { modelVendorIcon } from "@/lib/agent-sessions/model-vendor-icon"

/**
 * A model as a reader should see it: the vendor's mark and the model's name,
 * in place of the raw id an instrumentation reported.
 *
 * The name is prose (`Claude Sonnet 4.5`), so it is not set in mono the way
 * the id was — and the id is never lost, it moves to the `title` its callers
 * pass. Nothing here waits on detection: an unresolved model renders its last
 * path segment beside the generic mark, at the same size, so the row does not
 * reflow when the batch lands.
 *
 * `moreCount` is the "+2" a lane too narrow for a list falls back to. It sits
 * outside the truncating name so it survives a long first model.
 */
export function ModelLabel({
	detected,
	moreCount = 0,
	size = 13,
	title,
	className,
}: {
	detected: DetectedModel
	moreCount?: number
	size?: number
	title?: string
	className?: string
}) {
	const Icon = modelVendorIcon(detected)
	return (
		<span
			className={cn("flex min-w-0 items-center gap-1.5", className)}
			title={title ?? modelTitle(detected)}
		>
			<Icon size={size} className="shrink-0" aria-hidden />
			<span className="min-w-0 truncate">{detected.displayName}</span>
			{moreCount > 0 && <span className="shrink-0 tabular-nums">+{moreCount}</span>}
		</span>
	)
}

/** The `title` for a model shown by name: the vendor, then the id it was reported under. */
export function modelTitle(detected: DetectedModel): string {
	return detected.vendorName === null ? detected.model : `${detected.vendorName} · ${detected.model}`
}
