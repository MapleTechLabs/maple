"use client"

import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible"
import type React from "react"
import { collapsiblePanelStyles } from "./collapsible.styles"

export function Collapsible({ ...props }: CollapsiblePrimitive.Root.Props): React.ReactElement {
	return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />
}

export function CollapsibleTrigger({
	className,
	...props
}: CollapsiblePrimitive.Trigger.Props): React.ReactElement {
	return <CollapsiblePrimitive.Trigger className={className} data-slot="collapsible-trigger" {...props} />
}

// `className` is narrowed to a plain string: it styles the inner wrapper below, so Base UI's
// state-function form has no panel state to resolve against.
export function CollapsiblePanel({
	className,
	children,
	...props
}: Omit<CollapsiblePrimitive.Panel.Props, "className"> & {
	className?: string
}): React.ReactElement {
	return (
		<CollapsiblePrimitive.Panel
			className={collapsiblePanelStyles}
			data-slot="collapsible-panel"
			{...props}
		>
			{/* Consumer styles go on an inner element, never on the panel itself: padding skews the
			    measured height, and flex/alignment properties are exactly what Base UI has to strip
			    before it can measure (see `resetLayoutStyles`). Mirrors `AccordionPanel`. */}
			<div className={className}>{children}</div>
		</CollapsiblePrimitive.Panel>
	)
}

export { CollapsiblePrimitive, CollapsiblePanel as CollapsibleContent }
