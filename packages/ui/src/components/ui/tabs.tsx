"use client"

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import type React from "react"
import { cn } from "../../lib/utils"
import {
	tabsIndicatorDefaultStyles,
	tabsIndicatorStyles,
	tabsIndicatorUnderlineStyles,
	tabsListDefaultStyles,
	tabsListStyles,
	tabsListUnderlineStyles,
	tabsListVerticalStyles,
	tabsPanelStyles,
	tabsStyles,
	tabsTabStyles,
} from "./tabs.styles"

export type TabsVariant = "default" | "underline"

export function Tabs({ className, ...props }: TabsPrimitive.Root.Props): React.ReactElement {
	return <TabsPrimitive.Root className={cn(tabsStyles, className)} data-slot="tabs" {...props} />
}

export function TabsList({
	variant = "default",
	className,
	children,
	...props
}: TabsPrimitive.List.Props & {
	variant?: TabsVariant
}): React.ReactElement {
	return (
		<TabsPrimitive.List
			className={cn(
				tabsListStyles,
				tabsListVerticalStyles,
				variant === "default" ? tabsListDefaultStyles : tabsListUnderlineStyles,
				className,
			)}
			data-slot="tabs-list"
			{...props}
		>
			{children}
			<TabsPrimitive.Indicator
				className={cn(
					tabsIndicatorStyles,
					variant === "underline" ? tabsIndicatorUnderlineStyles : tabsIndicatorDefaultStyles,
				)}
				data-slot="tab-indicator"
			/>
		</TabsPrimitive.List>
	)
}

export function TabsTab({ className, ...props }: TabsPrimitive.Tab.Props): React.ReactElement {
	return <TabsPrimitive.Tab className={cn(tabsTabStyles, className)} data-slot="tabs-tab" {...props} />
}

export function TabsPanel({ className, ...props }: TabsPrimitive.Panel.Props): React.ReactElement {
	return (
		<TabsPrimitive.Panel className={cn(tabsPanelStyles, className)} data-slot="tabs-content" {...props} />
	)
}

export { TabsPrimitive, TabsTab as TabsTrigger, TabsPanel as TabsContent }
