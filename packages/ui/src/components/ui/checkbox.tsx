"use client"

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox"
import type React from "react"
import { cn } from "../../lib/utils"
import { checkboxIconStyles, checkboxIndicatorStyles, checkboxStyles } from "./checkbox.styles"

export function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props): React.ReactElement {
	return (
		<CheckboxPrimitive.Root className={cn(checkboxStyles, className)} data-slot="checkbox" {...props}>
			<CheckboxPrimitive.Indicator
				className={checkboxIndicatorStyles}
				data-slot="checkbox-indicator"
				render={(props: React.ComponentProps<"span">, state: CheckboxPrimitive.Indicator.State) => (
					<span {...props}>
						{state.indeterminate ? (
							<svg
								aria-hidden="true"
								className={checkboxIconStyles}
								fill="none"
								height="24"
								stroke="currentColor"
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth="3"
								viewBox="0 0 24 24"
								width="24"
								xmlns="http://www.w3.org/2000/svg"
							>
								<path d="M5.252 12h13.496" />
							</svg>
						) : (
							<svg
								aria-hidden="true"
								className={checkboxIconStyles}
								fill="none"
								height="24"
								stroke="currentColor"
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth="3"
								viewBox="0 0 24 24"
								width="24"
								xmlns="http://www.w3.org/2000/svg"
							>
								<path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
							</svg>
						)}
					</span>
				)}
			/>
		</CheckboxPrimitive.Root>
	)
}

export { CheckboxPrimitive }
