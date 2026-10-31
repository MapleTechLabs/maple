export const dropdownMenuPositionerStyles = "isolate z-50 outline-none"

export const dropdownMenuContentStyles =
	"transition-[opacity,scale] duration-150 ease-out starting:scale-95 starting:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 data-ending-style:duration-100 ring-foreground/10 bg-popover text-popover-foreground min-w-32 rounded-xl shadow-popup ring-1 z-50 max-h-(--available-height) w-(--anchor-width) origin-(--transform-origin) overflow-x-hidden overflow-y-auto outline-none data-closed:overflow-hidden"

export const dropdownMenuLabelStyles = "text-muted-foreground px-2 py-2 text-xs data-[inset]:pl-8"

export const dropdownMenuItemStyles =
	"focus:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive-a2 dark:data-[variant=destructive]:focus:bg-destructive-a3 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:*:[svg]:text-destructive not-data-[variant=destructive]:focus:**:text-accent-foreground gap-2 rounded-md px-2 py-2 text-xs [&_svg:not([class*='size-'])]:size-3.5 group/dropdown-menu-item relative flex cursor-default items-center outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0"

export const dropdownMenuSubTriggerStyles =
	"focus:bg-accent focus:text-accent-foreground data-open:bg-accent data-open:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground gap-2 rounded-md px-2 py-2 text-xs [&_svg:not([class*='size-'])]:size-3.5 data-popup-open:bg-accent data-popup-open:text-accent-foreground flex cursor-default items-center outline-hidden select-none data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0"

export const dropdownMenuSubTriggerIconStyles = "ml-auto"

export const dropdownMenuSubContentStyles =
	"transition-[opacity,scale] duration-150 ease-out starting:scale-95 starting:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 data-ending-style:duration-100 ring-foreground/10 bg-popover text-popover-foreground min-w-[96px] rounded-xl shadow-popup ring-1 w-auto"

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
