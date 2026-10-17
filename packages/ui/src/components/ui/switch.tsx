"use client"

import { Switch as SwitchPrimitive } from "@base-ui/react/switch"
import type React from "react"
import { cn } from "../../lib/utils"
import { switchStyles, switchThumbStyles } from "./switch.styles"

export function Switch({ className, ...props }: SwitchPrimitive.Root.Props): React.ReactElement {
	return (
		<SwitchPrimitive.Root className={cn(switchStyles, className)} data-slot="switch" {...props}>
			<SwitchPrimitive.Thumb className={cn(switchThumbStyles)} data-slot="switch-thumb" />
		</SwitchPrimitive.Root>
	)
}

export { SwitchPrimitive }
