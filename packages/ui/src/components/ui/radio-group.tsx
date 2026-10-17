"use client"

import { Radio as RadioPrimitive } from "@base-ui/react/radio"
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group"
import type React from "react"
import { cn } from "../../lib/utils"
import { radioGroupStyles, radioIndicatorStyles, radioStyles } from "./radio-group.styles"

export function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props): React.ReactElement {
	return (
		<RadioGroupPrimitive className={cn(radioGroupStyles, className)} data-slot="radio-group" {...props} />
	)
}

export function Radio({ className, ...props }: RadioPrimitive.Root.Props): React.ReactElement {
	return (
		<RadioPrimitive.Root className={cn(radioStyles, className)} data-slot="radio" {...props}>
			<RadioPrimitive.Indicator className={radioIndicatorStyles} data-slot="radio-indicator" />
		</RadioPrimitive.Root>
	)
}

export { RadioGroupPrimitive, RadioPrimitive, Radio as RadioGroupItem }
