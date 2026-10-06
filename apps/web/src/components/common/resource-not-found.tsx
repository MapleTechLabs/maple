import type React from "react"
import { Button } from "@maple/ui/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { CircleWarningIcon } from "@/components/icons"

interface ResourceNotFoundProps {
	/** "Rule not found". */
	readonly title: React.ReactNode
	readonly description?: React.ReactNode
	/** The link the back button renders as, e.g. `<Link to="/alerts" />`. */
	readonly backLink?: React.ReactElement
	/** "Back to rules". */
	readonly backLabel?: React.ReactNode
	readonly icon?: React.ReactNode
	readonly className?: string
}

/** A detail route whose id resolved to nothing: say so and offer the way back to the list. */
export function ResourceNotFound({
	title,
	description,
	backLink,
	backLabel,
	icon,
	className = "py-12",
}: ResourceNotFoundProps): React.ReactElement {
	return (
		<Empty className={className}>
			<EmptyHeader>
				<EmptyMedia variant="icon">{icon ?? <CircleWarningIcon size={18} />}</EmptyMedia>
				<EmptyTitle>{title}</EmptyTitle>
				{description ? <EmptyDescription>{description}</EmptyDescription> : null}
			</EmptyHeader>
			{backLink ? (
				<Button variant="outline" size="sm" render={backLink}>
					{backLabel}
				</Button>
			) : null}
		</Empty>
	)
}
