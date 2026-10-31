export const contextMenuTriggerStyles = "select-none"

export const contextMenuPositionerStyles = "isolate z-50 outline-none"

export const contextMenuContentStyles =
	"data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 ring-foreground/10 bg-popover text-popover-foreground min-w-36 rounded-xl shadow-popup ring-1 duration-100 transition-none data-[side=inline-start]:slide-in-from-right-2 data-[side=inline-end]:slide-in-from-left-2 z-50 max-h-(--available-height) origin-(--transform-origin) overflow-x-hidden overflow-y-auto outline-none"

export const contextMenuLabelStyles = "text-muted-foreground px-2 py-2 text-xs data-[inset]:pl-8"

export const contextMenuItemStyles =
	"focus:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive-a2 dark:data-[variant=destructive]:focus:bg-destructive-a3 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:*:[svg]:text-destructive focus:*:[svg]:text-accent-foreground gap-2 rounded-md px-2 py-2 text-xs [&_svg:not([class*='size-'])]:size-3.5 group/context-menu-item relative flex cursor-default items-center outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0"

export const contextMenuSubTriggerStyles =
	"focus:bg-accent focus:text-accent-foreground data-open:bg-accent data-open:text-accent-foreground gap-2 rounded-md px-2 py-2 text-xs [&_svg:not([class*='size-'])]:size-3.5 flex cursor-default items-center outline-hidden select-none data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0"

export const contextMenuSubTriggerIconStyles = "ml-auto"

export const contextMenuSubContentStyles = "shadow-popup"

export const contextMenuCheckboxItemStyles =
	"focus:bg-accent focus:text-accent-foreground gap-2 rounded-md py-2 pr-8 pl-2 text-xs [&_svg:not([class*='size-'])]:size-3.5 relative flex cursor-default items-center outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0"

export const contextMenuRadioItemStyles =
	"focus:bg-accent focus:text-accent-foreground gap-2 rounded-md py-2 pr-8 pl-2 text-xs [&_svg:not([class*='size-'])]:size-3.5 relative flex cursor-default items-center outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0"

export const contextMenuCheckboxItemIndicatorStyles = "absolute right-2 pointer-events-none"

export const contextMenuRadioItemIndicatorStyles = "absolute right-2 pointer-events-none"

export const contextMenuSeparatorStyles = "bg-border -mx-1 h-px"

export const contextMenuShortcutStyles =
	"text-muted-foreground group-focus/context-menu-item:text-accent-foreground ml-auto text-xs tracking-widest"
