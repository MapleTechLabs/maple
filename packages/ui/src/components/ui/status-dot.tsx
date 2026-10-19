import type { VariantProps } from "class-variance-authority"
import type React from "react"
import { cn } from "../../lib/utils"
import { statusDotVariants } from "./status-dot.styles"

export { statusDotVariants }

export interface StatusDotProps extends Omit<React.ComponentProps<"span">, "children"> {
	tone?: VariantProps<typeof statusDotVariants>["tone"]
	size?: VariantProps<typeof statusDotVariants>["size"]
}

/** A static status dot. Deliberately never animated: live state reads from tone and copy. */
export function StatusDot({ tone, size, className, ...props }: StatusDotProps): React.ReactElement {
	return (
		<span
			aria-hidden
			className={cn(statusDotVariants({ tone, size }), className)}
			data-slot="status-dot"
			{...props}
		/>
	)
}
