export const dropdownMenuPositionerStyles = "isolate z-50 outline-none"

export const dropdownMenuContentStyles =
	"data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 ring-foreground/10 bg-popover text-popover-foreground min-w-32 rounded-xl shadow-md ring-1 duration-100 transition-none data-[side=inline-start]:slide-in-from-right-2 data-[side=inline-end]:slide-in-from-left-2 z-50 max-h-(--available-height) w-(--anchor-width) origin-(--transform-origin) overflow-x-hidden overflow-y-auto outline-none data-closed:overflow-hidden"

export const dropdownMenuLabelStyles = "text-muted-foreground px-2 py-2 text-xs data-[inset]:pl-8"

export const dropdownMenuItemStyles =
	"focus:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:*:[svg]:text-destructive not-data-[variant=destructive]:focus:**:text-accent-foreground gap-2 rounded-md px-2 py-2 text-xs [&_svg:not([class*='size-'])]:size-3.5 group/dropdown-menu-item relative flex cursor-default items-center outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0"

export const dropdownMenuSubTriggerStyles =
	"focus:bg-accent focus:text-accent-foreground data-open:bg-accent data-open:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground gap-2 rounded-md px-2 py-2 text-xs [&_svg:not([class*='size-'])]:size-3.5 data-popup-open:bg-accent data-popup-open:text-accent-foreground flex cursor-default items-center outline-hidden select-none data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0"

export const dropdownMenuSubTriggerIconStyles = "ml-auto"

export const dropdownMenuSubContentStyles =
	"data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 ring-foreground/10 bg-popover text-popover-foreground min-w-[96px] rounded-xl shadow-lg ring-1 duration-100 w-auto"

export const dropdownMenuCheckboxItemStyles =
	"focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground gap-2 rounded-md py-2 pr-8 pl-2 text-xs [&_svg:not([class*='size-'])]:size-3.5 relative flex cursor-default items-center outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0"

export const dropdownMenuRadioItemStyles =
	"focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground gap-2 rounded-md py-2 pr-8 pl-2 text-xs [&_svg:not([class*='size-'])]:size-3.5 relative flex cursor-default items-center outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0"

export const dropdownMenuCheckboxItemIndicatorStyles =
	"pointer-events-none absolute right-2 flex items-center justify-center pointer-events-none"

export const dropdownMenuRadioItemIndicatorStyles =
	"pointer-events-none absolute right-2 flex items-center justify-center pointer-events-none"

export const dropdownMenuSeparatorStyles = "bg-border -mx-1 h-px"

export const dropdownMenuShortcutStyles =
	"text-muted-foreground group-focus/dropdown-menu-item:text-accent-foreground ml-auto text-xs tracking-widest"
