import { LoaderIcon } from "../icons"
import type React from "react"
import { cn } from "../../lib/utils"

export function Spinner({
	className,
	...props
}: React.ComponentProps<typeof LoaderIcon>): React.ReactElement {
	return (
		<LoaderIcon aria-label="Loading" className={cn("animate-spin", className)} role="status" {...props} />
	)
}
