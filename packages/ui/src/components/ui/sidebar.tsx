"use client"

import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import type { VariantProps } from "class-variance-authority"
import { LayoutMoveToLeftIcon, LayoutMoveToRightIcon } from "../icons"
import * as React from "react"
import { useMediaQuery } from "../../hooks/use-media-query"
import { cn } from "../../lib/utils"
import { Button } from "./button"
import {
	sidebarContainerDefaultStyles,
	sidebarContainerInsetStyles,
	sidebarContainerLeftStyles,
	sidebarContainerRightStyles,
	sidebarContainerStyles,
	sidebarContentScrollAreaStyles,
	sidebarContentStyles,
	sidebarDesktopStyles,
	sidebarFooterStyles,
	sidebarGapDefaultStyles,
	sidebarGapInsetStyles,
	sidebarGapStyles,
	sidebarGroupActionStyles,
	sidebarGroupContentStyles,
	sidebarGroupLabelStyles,
	sidebarGroupStyles,
	sidebarHeaderStyles,
	sidebarInnerStyles,
	sidebarInputStyles,
	sidebarInsetStyles,
	sidebarMenuActionShowOnHoverStyles,
	sidebarMenuActionStyles,
	sidebarMenuBadgeStyles,
	sidebarMenuButtonVariants,
	sidebarMenuItemStyles,
	sidebarMenuSkeletonIconStyles,
	sidebarMenuSkeletonStyles,
	sidebarMenuSkeletonTextStyles,
	sidebarMenuStyles,
	sidebarMenuSubButtonIconCollapsibleStyles,
	sidebarMenuSubButtonMdStyles,
	sidebarMenuSubButtonSmStyles,
	sidebarMenuSubButtonStyles,
	sidebarMenuSubItemStyles,
	sidebarMenuSubStyles,
	sidebarMobileHeaderStyles,
	sidebarMobileInnerStyles,
	sidebarMobileStyles,
	sidebarRailStyles,
	sidebarSeparatorStyles,
	sidebarStaticStyles,
	sidebarTriggerLabelStyles,
	sidebarTriggerStyles,
	sidebarWrapperStyles,
} from "./sidebar.styles"
import { Input } from "./input"
import { ScrollArea } from "./scroll-area"
import { Separator } from "./separator"
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "./sheet"
import { Skeleton } from "./skeleton"
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip"

const SIDEBAR_COOKIE_NAME: string = "sidebar_state"
const SIDEBAR_COOKIE_MAX_AGE: number = 60 * 60 * 24 * 7
const SIDEBAR_WIDTH: string = "16rem"
const SIDEBAR_WIDTH_MOBILE: string = "18rem"
const SIDEBAR_WIDTH_ICON: string = "3rem"
const SIDEBAR_KEYBOARD_SHORTCUT: string = "b"

export type SidebarContextProps = {
	state: "expanded" | "collapsed"
	open: boolean
	setOpen: (open: boolean) => void
	openMobile: boolean
	setOpenMobile: (open: boolean) => void
	isMobile: boolean
	toggleSidebar: () => void
}

export const SidebarContext: React.Context<SidebarContextProps | null> =
	React.createContext<SidebarContextProps | null>(null)

export function useSidebar(): SidebarContextProps {
	const context = React.useContext(SidebarContext)
	if (!context) {
		throw new Error("useSidebar must be used within a SidebarProvider.")
	}

	return context
}

export function SidebarProvider({
	defaultOpen = true,
	open: openProp,
	onOpenChange: setOpenProp,
	className,
	style,
	children,
	...props
}: React.ComponentProps<"div"> & {
	defaultOpen?: boolean
	open?: boolean
	onOpenChange?: (open: boolean) => void
}): React.ReactElement {
	const isMobile = useMediaQuery("max-md")
	const [openMobile, setOpenMobile] = React.useState(false)

	const [_open, _setOpen] = React.useState(defaultOpen)
	const open = openProp ?? _open
	const setOpen = React.useCallback(
		async (value: boolean | ((value: boolean) => boolean)) => {
			const openState = typeof value === "function" ? value(open) : value
			if (setOpenProp) {
				setOpenProp(openState)
			} else {
				_setOpen(openState)
			}

			await cookieStore.set({
				expires: Date.now() + SIDEBAR_COOKIE_MAX_AGE * 1000,
				name: SIDEBAR_COOKIE_NAME,
				path: "/",
				value: String(openState),
			})
		},
		[setOpenProp, open],
	)

	const toggleSidebar = React.useCallback(() => {
		return isMobile ? setOpenMobile((open) => !open) : setOpen((open) => !open)
	}, [isMobile, setOpen])

	React.useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent): void => {
			if (event.key === SIDEBAR_KEYBOARD_SHORTCUT && (event.metaKey || event.ctrlKey)) {
				event.preventDefault()
				toggleSidebar()
			}
		}

		window.addEventListener("keydown", handleKeyDown)
		return () => window.removeEventListener("keydown", handleKeyDown)
	}, [toggleSidebar])

	const state = open ? "expanded" : "collapsed"

	const contextValue = React.useMemo<SidebarContextProps>(
		() => ({
			isMobile,
			open,
			openMobile,
			setOpen,
			setOpenMobile,
			state,
			toggleSidebar,
		}),
		[state, open, setOpen, isMobile, openMobile, toggleSidebar],
	)

	return (
		<SidebarContext.Provider value={contextValue}>
			<div
				className={cn(sidebarWrapperStyles, className)}
				data-slot="sidebar-wrapper"
				style={
					{
						"--sidebar-width": SIDEBAR_WIDTH,
						"--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
						...style,
					} as React.CSSProperties
				}
				{...props}
			>
				{children}
			</div>
		</SidebarContext.Provider>
	)
}

export function Sidebar({
	side = "left",
	variant = "sidebar",
	collapsible = "offcanvas",
	className,
	children,
	...props
}: React.ComponentProps<"div"> & {
	side?: "left" | "right"
	variant?: "sidebar" | "floating" | "inset"
	collapsible?: "offcanvas" | "icon" | "none"
}): React.ReactElement {
	const { isMobile, state, openMobile, setOpenMobile } = useSidebar()

	if (collapsible === "none") {
		return (
			<div className={cn(sidebarStaticStyles, className)} data-slot="sidebar" {...props}>
				{children}
			</div>
		)
	}

	if (isMobile) {
		return (
			<Sheet onOpenChange={setOpenMobile} open={openMobile} {...props}>
				<SheetPopup
					className={sidebarMobileStyles}
					data-mobile="true"
					data-sidebar="sidebar"
					data-slot="sidebar"
					side={side}
					style={
						{
							"--sidebar-width": SIDEBAR_WIDTH_MOBILE,
						} as React.CSSProperties
					}
				>
					<SheetHeader className={sidebarMobileHeaderStyles}>
						<SheetTitle>Sidebar</SheetTitle>
						<SheetDescription>Displays the mobile sidebar.</SheetDescription>
					</SheetHeader>
					<div className={sidebarMobileInnerStyles}>{children}</div>
				</SheetPopup>
			</Sheet>
		)
	}

	return (
		<div
			className={sidebarDesktopStyles}
			data-collapsible={state === "collapsed" ? collapsible : ""}
			data-side={side}
			data-slot="sidebar"
			data-state={state}
			data-variant={variant}
		>
			{/* This is what handles the sidebar gap on desktop */}
			<div
				className={cn(
					...sidebarGapStyles,
					variant === "floating" || variant === "inset"
						? sidebarGapInsetStyles
						: sidebarGapDefaultStyles,
				)}
				data-slot="sidebar-gap"
			/>
			<div
				className={cn(
					sidebarContainerStyles,
					side === "left" ? sidebarContainerLeftStyles : sidebarContainerRightStyles,
					variant === "floating" || variant === "inset"
						? sidebarContainerInsetStyles
						: sidebarContainerDefaultStyles,
					className,
				)}
				data-slot="sidebar-container"
				{...props}
			>
				<div className={sidebarInnerStyles} data-sidebar="sidebar" data-slot="sidebar-inner">
					{children}
				</div>
			</div>
		</div>
	)
}

export function SidebarTrigger({
	className,
	onClick,
	...props
}: React.ComponentProps<typeof Button>): React.ReactElement {
	const { toggleSidebar, state } = useSidebar()

	return (
		<Button
			className={cn(sidebarTriggerStyles, className)}
			data-sidebar="trigger"
			data-slot="sidebar-trigger"
			onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
				onClick?.(event)
				toggleSidebar()
			}}
			size="icon"
			variant="ghost"
			{...props}
		>
			{state === "expanded" ? <LayoutMoveToLeftIcon /> : <LayoutMoveToRightIcon />}
			<span className={sidebarTriggerLabelStyles}>Toggle sidebar</span>
		</Button>
	)
}

export function SidebarRail({ className, ...props }: React.ComponentProps<"button">): React.ReactElement {
	const { toggleSidebar } = useSidebar()

	return (
		<button
			aria-label="Toggle sidebar"
			className={cn(...sidebarRailStyles, className)}
			data-sidebar="rail"
			data-slot="sidebar-rail"
			onClick={toggleSidebar}
			tabIndex={-1}
			title="Toggle sidebar"
			type="button"
			{...props}
		/>
	)
}

export function SidebarInset({ className, ...props }: React.ComponentProps<"main">): React.ReactElement {
	return (
		<main
			// `h-svh` bounds the flex chain so PageLayout.ScrollArea, not the window,
			// scrolls; `min-h-0` lets descendant flex items shrink within that bound.
			className={cn(...sidebarInsetStyles, className)}
			data-slot="sidebar-inset"
			{...props}
		/>
	)
}

export function SidebarInput({
	className,
	...props
}: React.ComponentProps<typeof Input>): React.ReactElement {
	return (
		<Input
			className={cn(sidebarInputStyles, className)}
			data-sidebar="input"
			data-slot="sidebar-input"
			{...props}
		/>
	)
}

export function SidebarHeader({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
	return (
		<div
			className={cn(sidebarHeaderStyles, className)}
			data-sidebar="header"
			data-slot="sidebar-header"
			{...props}
		/>
	)
}

export function SidebarFooter({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
	return (
		<div
			className={cn(sidebarFooterStyles, className)}
			data-sidebar="footer"
			data-slot="sidebar-footer"
			{...props}
		/>
	)
}

export function SidebarSeparator({
	className,
	...props
}: React.ComponentProps<typeof Separator>): React.ReactElement {
	return (
		<Separator
			className={cn(sidebarSeparatorStyles, className)}
			data-sidebar="separator"
			data-slot="sidebar-separator"
			{...props}
		/>
	)
}

export function SidebarContent({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
	return (
		<ScrollArea className={sidebarContentScrollAreaStyles} scrollFade>
			<div
				className={cn(sidebarContentStyles, className)}
				data-sidebar="content"
				data-slot="sidebar-content"
				{...props}
			/>
		</ScrollArea>
	)
}

export function SidebarGroup({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
	return (
		<div
			className={cn(sidebarGroupStyles, className)}
			data-sidebar="group"
			data-slot="sidebar-group"
			{...props}
		/>
	)
}

export function SidebarGroupLabel({
	className,
	render,
	...props
}: useRender.ComponentProps<"div">): React.ReactElement {
	const defaultProps = {
		className: cn(...sidebarGroupLabelStyles, className),
		"data-sidebar": "group-label",
		"data-slot": "sidebar-group-label",
	}

	return useRender({
		defaultTagName: "div",
		props: mergeProps(defaultProps, props),
		render,
	})
}

export function SidebarGroupAction({
	className,
	render,
	...props
}: useRender.ComponentProps<"button">): React.ReactElement {
	const defaultProps = {
		className: cn(...sidebarGroupActionStyles, className),
		"data-sidebar": "group-action",
		"data-slot": "sidebar-group-action",
	}

	return useRender({
		defaultTagName: "button",
		props: mergeProps(defaultProps, props),
		render,
	})
}

export function SidebarGroupContent({
	className,
	...props
}: React.ComponentProps<"div">): React.ReactElement {
	return (
		<div
			className={cn(sidebarGroupContentStyles, className)}
			data-sidebar="group-content"
			data-slot="sidebar-group-content"
			{...props}
		/>
	)
}

export function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">): React.ReactElement {
	return (
		<ul
			className={cn(sidebarMenuStyles, className)}
			data-sidebar="menu"
			data-slot="sidebar-menu"
			{...props}
		/>
	)
}

export function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">): React.ReactElement {
	return (
		<li
			className={cn(sidebarMenuItemStyles, className)}
			data-sidebar="menu-item"
			data-slot="sidebar-menu-item"
			{...props}
		/>
	)
}

export function SidebarMenuButton({
	isActive = false,
	variant = "default",
	size = "default",
	tooltip,
	className,
	render,
	...props
}: useRender.ComponentProps<"button"> & {
	isActive?: boolean
	tooltip?: string | React.ComponentProps<typeof TooltipPopup>
} & VariantProps<typeof sidebarMenuButtonVariants>): React.ReactElement {
	const { isMobile, state } = useSidebar()

	const defaultProps = {
		className: cn(sidebarMenuButtonVariants({ size, variant }), className),
		"data-active": isActive,
		"data-sidebar": "menu-button",
		"data-size": size,
		"data-slot": "sidebar-menu-button",
	}

	const buttonProps = mergeProps<"button">(defaultProps, props)

	const buttonElement = useRender({
		defaultTagName: "button",
		props: buttonProps,
		render,
	})

	if (!tooltip) {
		return buttonElement
	}

	if (typeof tooltip === "string") {
		tooltip = {
			children: tooltip,
		}
	}

	return (
		<Tooltip>
			<TooltipTrigger render={buttonElement as React.ReactElement<Record<string, unknown>>} />
			<TooltipPopup
				align="center"
				hidden={state !== "collapsed" || isMobile}
				side="right"
				{...tooltip}
			/>
		</Tooltip>
	)
}

export function SidebarMenuAction({
	className,
	showOnHover = false,
	render,
	...props
}: useRender.ComponentProps<"button"> & {
	showOnHover?: boolean
}): React.ReactElement {
	const defaultProps = {
		className: cn(
			...sidebarMenuActionStyles,
			showOnHover && sidebarMenuActionShowOnHoverStyles,
			className,
		),
		"data-sidebar": "menu-action",
		"data-slot": "sidebar-menu-action",
	}

	return useRender({
		defaultTagName: "button",
		props: mergeProps<"button">(defaultProps, props),
		render,
	})
}

export function SidebarMenuBadge({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
	return (
		<div
			className={cn(...sidebarMenuBadgeStyles, className)}
			data-sidebar="menu-badge"
			data-slot="sidebar-menu-badge"
			{...props}
		/>
	)
}

export function SidebarMenuSkeleton({
	className,
	showIcon = false,
	...props
}: React.ComponentProps<"div"> & {
	showIcon?: boolean
}): React.ReactElement {
	const width = React.useMemo(() => {
		return `${Math.floor(Math.random() * 40) + 50}%`
	}, [])

	return (
		<div
			className={cn(sidebarMenuSkeletonStyles, className)}
			data-sidebar="menu-skeleton"
			data-slot="sidebar-menu-skeleton"
			{...props}
		>
			{showIcon && (
				<Skeleton className={sidebarMenuSkeletonIconStyles} data-sidebar="menu-skeleton-icon" />
			)}
			<Skeleton
				className={sidebarMenuSkeletonTextStyles}
				data-sidebar="menu-skeleton-text"
				style={
					{
						"--skeleton-width": width,
					} as React.CSSProperties
				}
			/>
		</div>
	)
}

export function SidebarMenuSub({ className, ...props }: React.ComponentProps<"ul">): React.ReactElement {
	return (
		<ul
			className={cn(...sidebarMenuSubStyles, className)}
			data-sidebar="menu-sub"
			data-slot="sidebar-menu-sub"
			{...props}
		/>
	)
}

export function SidebarMenuSubItem({ className, ...props }: React.ComponentProps<"li">): React.ReactElement {
	return (
		<li
			className={cn(sidebarMenuSubItemStyles, className)}
			data-sidebar="menu-sub-item"
			data-slot="sidebar-menu-sub-item"
			{...props}
		/>
	)
}

export function SidebarMenuSubButton({
	size = "md",
	isActive = false,
	className,
	render,
	...props
}: useRender.ComponentProps<"a"> & {
	size?: "sm" | "md"
	isActive?: boolean
}): React.ReactElement {
	const defaultProps = {
		className: cn(
			...sidebarMenuSubButtonStyles,
			size === "sm" && sidebarMenuSubButtonSmStyles,
			size === "md" && sidebarMenuSubButtonMdStyles,
			sidebarMenuSubButtonIconCollapsibleStyles,
			className,
		),
		"data-active": isActive,
		"data-sidebar": "menu-sub-button",
		"data-size": size,
		"data-slot": "sidebar-menu-sub-button",
	}

	return useRender({
		defaultTagName: "a",
		props: mergeProps<"a">(defaultProps, props),
		render,
	})
}
