export const popoverPositionerStyles =
	"z-55 h-(--positioner-height) w-(--positioner-width) max-w-(--available-width) transition-[top,left,right,bottom,transform] data-instant:transition-none"

export const popoverPopupStyles =
	"relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) rounded-lg border bg-popover not-dark:bg-clip-padding text-popover-foreground shadow-popup outline-none transition-[width,height,scale,opacity] before:pointer-events-none before:absolute before:inset-0 before:rounded-lg-inset before:shadow-control has-data-[slot=calendar]:rounded-xl has-data-[slot=calendar]:before:rounded-xl-inset data-starting-style:scale-98 data-starting-style:opacity-0"

export const popoverPopupTooltipStyles =
	"w-fit text-balance rounded-md text-xs shadow-popup before:rounded-md-inset"

export const popoverViewportStyles =
	"relative size-full max-h-(--available-height) overflow-clip px-(--viewport-inline-padding) py-4 [--viewport-inline-padding:--spacing(4)] has-data-[slot=calendar]:p-2 data-instant:transition-none **:data-current:data-ending-style:opacity-0 **:data-current:data-starting-style:opacity-0 **:data-previous:data-ending-style:opacity-0 **:data-previous:data-starting-style:opacity-0 **:data-current:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-current:opacity-100 **:data-previous:opacity-100 **:data-current:transition-opacity **:data-previous:transition-opacity"

export const popoverViewportTooltipStyles = "py-1 [--viewport-inline-padding:--spacing(2)]"

export const popoverViewportScrollStyles = "not-data-transitioning:overflow-y-auto"

export const popoverTitleStyles = "font-semibold text-lg leading-none"

export const popoverDescriptionStyles = "text-muted-foreground text-sm"
