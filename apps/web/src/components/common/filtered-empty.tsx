import type React from "react"
import { Button } from "@maple/ui/components/ui/button"
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@maple/ui/components/ui/empty"
import { SlidersIcon } from "@/components/icons"

interface FilteredEmptyProps {
	/** Plural noun for the title: "No {noun} match these filters". */
	readonly noun: string
	readonly title?: React.ReactNode
	readonly description?: React.ReactNode
	readonly onClear?: () => void
	readonly clearLabel?: React.ReactNode
	readonly icon?: React.ReactNode
	/** Extra content above the clear button. */
	readonly detail?: React.ReactNode
	readonly className?: string
}

/** The list is empty because the user's own filters or search excluded everything. */
export function FilteredEmpty({
	noun,
	title,
	description = "Everything in this time range was excluded by the current filters.",
	onClear,
	clearLabel = "Clear filters",
	icon,
	detail,
	className,
}: FilteredEmptyProps): React.ReactElement {
	return (
		<Empty className={className}>
			<EmptyHeader>
				<EmptyMedia variant="icon">{icon ?? <SlidersIcon />}</EmptyMedia>
				<EmptyTitle>{title ?? `No ${noun} match these filters`}</EmptyTitle>
				{description ? <EmptyDescription>{description}</EmptyDescription> : null}
			</EmptyHeader>
			{(detail !== undefined || onClear !== undefined) && (
				<EmptyContent>
					{detail}
					{onClear !== undefined && (
						<Button variant="outline" size="sm" onClick={onClear}>
							{clearLabel}
						</Button>
					)}
				</EmptyContent>
			)}
		</Empty>
	)
}
