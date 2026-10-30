import { cva } from "class-variance-authority"

export const navigationMenuTriggerStyle = cva(
	"bg-background hover:bg-muted focus:bg-muted data-open:hover:bg-muted data-open:focus:bg-muted data-open:bg-surface-sunken focus-visible:ring-ring/50 data-popup-open:bg-surface-sunken data-popup-open:hover:bg-muted rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all focus-visible:ring-1 focus-visible:outline-1 disabled:opacity-50 group/navigation-menu-trigger inline-flex h-9 w-max items-center justify-center disabled:pointer-events-none outline-none",
)

export const navigationMenuStyles =
	"max-w-max group/navigation-menu relative flex max-w-max flex-1 items-center justify-center"

export const navigationMenuListStyles = "gap-0 group flex flex-1 list-none items-center justify-center"

export const navigationMenuItemStyles = "relative"

export const navigationMenuTriggerGroupStyles = "group"

export const navigationMenuTriggerIconStyles =
	"relative top-[1px] ml-1 size-3 transition duration-300 group-data-open/navigation-menu-trigger:rotate-180 group-data-popup-open/navigation-menu-trigger:rotate-180"

export const navigationMenuContentStyles =
	"data-[motion^=from-]:animate-in data-[motion^=to-]:animate-out data-[motion^=from-]:fade-in data-[motion^=to-]:fade-out data-[motion=from-end]:slide-in-from-right-52 data-[motion=from-start]:slide-in-from-left-52 data-[motion=to-end]:slide-out-to-right-52 data-[motion=to-start]:slide-out-to-left-52 group-data-[viewport=false]/navigation-menu:bg-popover group-data-[viewport=false]/navigation-menu:text-popover-foreground group-data-[viewport=false]/navigation-menu:data-open:animate-in group-data-[viewport=false]/navigation-menu:data-closed:animate-out group-data-[viewport=false]/navigation-menu:data-closed:zoom-out-95 group-data-[viewport=false]/navigation-menu:data-open:zoom-in-95 group-data-[viewport=false]/navigation-menu:data-open:fade-in-0 group-data-[viewport=false]/navigation-menu:data-closed:fade-out-0 group-data-[viewport=false]/navigation-menu:ring-foreground/10 p-1 ease-[cubic-bezier(0.22,1,0.36,1)] group-data-[viewport=false]/navigation-menu:rounded-xl group-data-[viewport=false]/navigation-menu:shadow group-data-[viewport=false]/navigation-menu:ring-1 group-data-[viewport=false]/navigation-menu:duration-300 h-full w-auto transition-[opacity,transform,translate] duration-[0.35s] data-[ending-style]:opacity-0 data-[ending-style]:data-[activation-direction=left]:translate-x-[50%] data-[ending-style]:data-[activation-direction=right]:translate-x-[-50%] **:data-[slot=navigation-menu-link]:focus:ring-0 **:data-[slot=navigation-menu-link]:focus:outline-none data-[starting-style]:opacity-0 data-[starting-style]:data-[activation-direction=left]:translate-x-[-50%] data-[starting-style]:data-[activation-direction=right]:translate-x-[50%]"

export const navigationMenuPositionerStyles =
	"transition-[top,left,right,bottom] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] data-[side=bottom]:before:top-[-10px] data-[side=bottom]:before:right-0 data-[side=bottom]:before:left-0 isolate z-50 h-[var(--positioner-height)] w-[var(--positioner-width)] max-w-[var(--available-width)] transition-[top,left,right,bottom] duration-[0.35s] data-[instant]:transition-none"

export const navigationMenuPopupStyles =
	"bg-popover text-popover-foreground ring-foreground/10 rounded-xl shadow ring-1 transition-all ease-[cubic-bezier(0.22,1,0.36,1)] outline-none data-[ending-style]:scale-90 data-[ending-style]:opacity-0 data-[ending-style]:duration-150 data-[starting-style]:scale-90 data-[starting-style]:opacity-0 data-[ending-style]:easing-[ease] xs:w-(--popup-width) relative h-(--popup-height) w-(--popup-width) origin-(--transform-origin) transition-[opacity,transform,width,height,scale,translate] duration-[0.35s] ease-[cubic-bezier(0.22,1,0.36,1)]"

export const navigationMenuViewportStyles = "relative size-full overflow-hidden"

export const navigationMenuLinkStyles =
	"data-active:focus:bg-muted data-active:hover:bg-muted data-active:bg-surface-sunken focus-visible:ring-ring/50 hover:bg-muted focus:bg-muted flex items-center gap-2 rounded-lg p-2 text-xs transition-all outline-none focus-visible:ring-1 focus-visible:outline-1 [&_svg:not([class*='size-'])]:size-4 [[data-slot=navigation-menu-content]_&]:rounded-lg"

export const navigationMenuIndicatorStyles =
	"data-[state=visible]:animate-in data-[state=hidden]:animate-out data-[state=hidden]:fade-out data-[state=visible]:fade-in top-full z-[1] flex h-1.5 items-end justify-center overflow-hidden"

export const navigationMenuIndicatorArrowStyles =
	"bg-border rounded-sm shadow-md relative top-[60%] h-2 w-2 rotate-45"
