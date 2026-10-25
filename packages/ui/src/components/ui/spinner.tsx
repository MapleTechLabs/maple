import { LoaderIcon } from "../icons"
import type React from "react"
import { cn } from "../../lib/utils"
import { spinnerStyles } from "./spinner.styles"

export function Spinner({
	className,
	...props
}: React.ComponentProps<typeof LoaderIcon>): React.ReactElement {
	return (
		<LoaderIcon aria-label="Loading" className={cn(spinnerStyles, className)} role="status" {...props} />
	)
}
