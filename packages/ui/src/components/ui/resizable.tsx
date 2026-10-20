"use client"

import * as ResizablePrimitive from "react-resizable-panels"

import { cn } from "../../lib/utils"
import {
	resizableHandleGripStyles,
	resizableHandleStyles,
	resizablePanelGroupStyles,
	resizablePanelStyles,
} from "./resizable.styles"

function ResizablePanelGroup({ className, ...props }: ResizablePrimitive.GroupProps) {
	return (
		<ResizablePrimitive.Group
			data-slot="resizable-panel-group"
			className={cn(resizablePanelGroupStyles, className)}
			{...props}
		/>
	)
}

function ResizablePanel({ className, ...props }: ResizablePrimitive.PanelProps) {
	return (
		<ResizablePrimitive.Panel
			data-slot="resizable-panel"
			className={cn(resizablePanelStyles, className)}
			{...props}
		/>
	)
}

function ResizableHandle({
	withHandle,
	className,
	...props
}: ResizablePrimitive.SeparatorProps & {
	withHandle?: boolean
}) {
	return (
		<ResizablePrimitive.Separator
			data-slot="resizable-handle"
			className={cn(resizableHandleStyles, className)}
			{...props}
		>
			{withHandle && <div className={resizableHandleGripStyles} />}
		</ResizablePrimitive.Separator>
	)
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
