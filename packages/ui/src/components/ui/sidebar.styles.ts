import { cva } from "class-variance-authority"

export const sidebarMenuButtonVariants = cva(
	"peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-lg p-2 text-left text-xs outline-hidden ring-sidebar-ring transition-[width,height,padding] duration-200 ease-move group-data-instant:transition-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 group-has-data-[sidebar=menu-action]/menu-item:pe-8 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground data-[state=open]:hover:bg-sidebar-accent data-[state=open]:active:bg-sidebar-accent data-[state=open]:hover:text-sidebar-accent-foreground data-[state=open]:active:text-sidebar-accent-foreground group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! [&>span:last-child]:truncate [&>svg:not([class*='size-'])]:size-4 [&>svg]:shrink-0",
	{
		defaultVariants: {
			size: "default",
			variant: "default",
		},
		variants: {
			size: {
				default: "h-8 text-xs",
				lg: "h-12 text-xs group-data-[collapsible=icon]:p-0!",
				sm: "h-7 text-xs",
			},
			variant: {
				default:
					"hover:bg-sidebar-accent active:bg-sidebar-accent hover:text-sidebar-accent-foreground active:text-sidebar-accent-foreground",
				outline:
					"bg-background ring-1 ring-sidebar-border hover:bg-sidebar-accent active:bg-sidebar-accent hover:text-sidebar-accent-foreground active:text-sidebar-accent-foreground hover:ring-sidebar-accent active:ring-sidebar-accent",
			},
		},
	},
)

export const sidebarWrapperStyles =
	"group/sidebar-wrapper flex min-h-svh w-full has-data-[variant=inset]:bg-sidebar"

export const sidebarStaticStyles =
	"flex h-full w-(--sidebar-width) flex-col bg-sidebar text-sidebar-foreground"

export const sidebarMobileStyles =
	"w-(--sidebar-width) bg-sidebar p-0 text-sidebar-foreground [&>button]:hidden"

export const sidebarMobileHeaderStyles = "sr-only"

export const sidebarMobileInnerStyles = "flex h-full w-full flex-col"

export const sidebarDesktopStyles = "group peer hidden text-sidebar-foreground md:block"

export const sidebarGapStyles = [
	"relative w-(--sidebar-width) bg-transparent transition-[width] duration-200 ease-move group-data-instant:transition-none",
	"group-data-[collapsible=offcanvas]:w-0",
	"group-data-[side=right]:rotate-180",
] as const

export const sidebarGapInsetStyles =
	"group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]"

export const sidebarGapDefaultStyles = "group-data-[collapsible=icon]:w-(--sidebar-width-icon)"

export const sidebarContainerStyles =
	"fixed inset-y-0 z-10 hidden h-svh w-(--sidebar-width) transition-[left,right,width] duration-200 ease-move group-data-instant:transition-none md:flex"

export const sidebarContainerLeftStyles =
	"left-0 group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]"

export const sidebarContainerRightStyles =
	"right-0 group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)]"

export const sidebarContainerInsetStyles =
	"p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4))+2px)]"

export const sidebarContainerDefaultStyles =
	"group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=left]:border-r group-data-[side=right]:border-l"

export const sidebarInnerStyles =
	"flex h-full w-full flex-col bg-sidebar group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:border group-data-[variant=floating]:border-sidebar-border group-data-[variant=floating]:shadow-raised"

export const sidebarTriggerStyles = "size-7"

export const sidebarTriggerLabelStyles = "sr-only"

export const sidebarRailStyles = [
	"absolute inset-y-0 z-20 hidden w-4 -translate-x-1/2 after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] hover:after:bg-sidebar-border active:after:bg-sidebar-border group-data-[side=left]:-right-4 group-data-[side=right]:left-0 sm:flex",
	"in-data-[side=left]:cursor-w-resize in-data-[side=right]:cursor-e-resize",
	"[[data-side=left][data-state=collapsed]_&]:cursor-e-resize [[data-side=right][data-state=collapsed]_&]:cursor-w-resize",
	"group-data-[collapsible=offcanvas]:translate-x-0 hover:group-data-[collapsible=offcanvas]:bg-sidebar active:group-data-[collapsible=offcanvas]:bg-sidebar group-data-[collapsible=offcanvas]:after:left-full",
	"[[data-side=left][data-collapsible=offcanvas]_&]:-right-2",
	"[[data-side=right][data-collapsible=offcanvas]_&]:-left-2",
] as const

export const sidebarInsetStyles = [
	"relative flex h-svh w-full min-h-0 min-w-0 flex-1 flex-col bg-background",
	"md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ms-2 md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ms-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-raised",
] as const

export const sidebarInputStyles = "h-8 w-full bg-background shadow-none"

export const sidebarHeaderStyles = "flex flex-col gap-2 p-2"

export const sidebarFooterStyles = "flex flex-col gap-2 p-2"

export const sidebarSeparatorStyles = "mx-2 w-auto bg-sidebar-border"

export const sidebarContentScrollAreaStyles = "**:data-[slot=scroll-area-scrollbar]:hidden"

export const sidebarContentStyles =
	"flex min-h-0 flex-1 flex-col gap-2 overflow-auto group-data-[collapsible=icon]:overflow-hidden"

export const sidebarGroupStyles = "relative flex w-full min-w-0 flex-col p-2"

export const sidebarGroupLabelStyles = [
	"flex h-8 shrink-0 items-center rounded-lg px-2 font-semibold text-2xs text-sidebar-foreground uppercase tracking-widest outline-hidden ring-sidebar-ring transition-[margin,opacity] duration-200 ease-move group-data-instant:transition-none focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0",
	"group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:pointer-events-none group-data-[collapsible=icon]:opacity-0",
] as const

export const sidebarGroupActionStyles = [
	"absolute top-3.5 right-3 flex aspect-square w-5 items-center justify-center rounded-lg p-0 text-sidebar-foreground outline-hidden ring-sidebar-ring transition-transform hover:bg-sidebar-accent active:bg-sidebar-accent hover:text-sidebar-accent-foreground active:text-sidebar-accent-foreground focus-visible:ring-2 [&>svg:not([class*='size-'])]:size-4 [&>svg]:shrink-0",
	// Increases the hit area of the button on mobile.
	"after:absolute after:-inset-2 md:after:hidden",
	"group-data-[collapsible=icon]:hidden",
] as const

export const sidebarGroupContentStyles = "w-full text-xs"

export const sidebarMenuStyles = "flex w-full min-w-0 flex-col gap-1"

export const sidebarMenuItemStyles = "group/menu-item relative"

export const sidebarMenuActionStyles = [
	"absolute top-1.5 right-1 flex aspect-square w-5 items-center justify-center rounded-lg p-0 text-sidebar-foreground outline-hidden ring-sidebar-ring transition-transform hover:bg-sidebar-accent active:bg-sidebar-accent hover:text-sidebar-accent-foreground active:text-sidebar-accent-foreground focus-visible:ring-2 peer-hover/menu-button:text-sidebar-accent-foreground [&>svg:not([class*='size-'])]:size-4 [&>svg]:shrink-0",
	// Increases the hit area of the button on mobile.
	"after:absolute after:-inset-2 md:after:hidden",
	"peer-data-[size=sm]/menu-button:top-1",
	"peer-data-[size=default]/menu-button:top-1.5",
	"peer-data-[size=lg]/menu-button:top-2.5",
	"group-data-[collapsible=icon]:hidden",
] as const

export const sidebarMenuActionShowOnHoverStyles =
	"group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 data-[state=open]:opacity-100 peer-data-[active=true]/menu-button:text-sidebar-accent-foreground md:opacity-0"

export const sidebarMenuBadgeStyles = [
	"pointer-events-none absolute right-1 flex h-5 min-w-5 select-none items-center justify-center rounded-lg px-1 font-medium text-sidebar-foreground text-xs tabular-nums",
	"peer-hover/menu-button:text-sidebar-accent-foreground peer-data-[active=true]/menu-button:text-sidebar-accent-foreground",
	"peer-data-[size=sm]/menu-button:top-1",
	"peer-data-[size=default]/menu-button:top-1.5",
	"peer-data-[size=lg]/menu-button:top-2.5",
	"group-data-[collapsible=icon]:hidden",
] as const

export const sidebarMenuSkeletonStyles = "flex h-8 items-center gap-2 rounded-lg px-2"

export const sidebarMenuSkeletonIconStyles = "size-4 rounded-lg"

export const sidebarMenuSkeletonTextStyles = "h-4 max-w-(--skeleton-width) flex-1"

export const sidebarMenuSubStyles = [
	"mx-3.5 flex min-w-0 translate-x-px flex-col gap-1 border-sidebar-border border-l px-2.5 py-0.5",
	"group-data-[collapsible=icon]:hidden",
] as const

export const sidebarMenuSubItemStyles = "group/menu-sub-item relative"

export const sidebarMenuSubButtonStyles = [
	"flex h-8 min-w-0 -translate-x-px items-center gap-2 overflow-hidden rounded-lg px-2 text-sidebar-foreground outline-hidden ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 sm:h-7 [&>span:last-child]:truncate [&>svg:not([class*='size-'])]:size-4 [&>svg]:shrink-0 [&>svg]:text-sidebar-accent-foreground",
	"data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground",
] as const

export const sidebarMenuSubButtonSmStyles = "text-xs"

export const sidebarMenuSubButtonMdStyles = "text-xs"

export const sidebarMenuSubButtonIconCollapsibleStyles = "group-data-[collapsible=icon]:hidden"
