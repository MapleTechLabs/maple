import { Separator as SeparatorPrimitive } from "@base-ui/react/separator"
import type React from "react"
import { cn } from "../../lib/utils"
import { separatorStyles } from "./separator.styles"

export function Separator({
	className,
	orientation = "horizontal",
	...props
}: SeparatorPrimitive.Props): React.ReactElement {
	return (
		<SeparatorPrimitive
			className={cn(separatorStyles, className)}
			data-slot="separator"
			orientation={orientation}
			{...props}
		/>
	)
}

export { SeparatorPrimitive }
