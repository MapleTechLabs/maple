import type * as React from "react"
import { cn } from "../../lib/utils"
import { kbdGroupStyles, kbdStyles } from "./kbd.styles"

export function Kbd({ className, ...props }: React.ComponentProps<"kbd">): React.ReactElement {
	return <kbd className={cn(kbdStyles, className)} data-slot="kbd" {...props} />
}

export function KbdGroup({ className, ...props }: React.ComponentProps<"kbd">): React.ReactElement {
	return <kbd className={cn(kbdGroupStyles, className)} data-slot="kbd-group" {...props} />
}
