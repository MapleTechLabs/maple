export const comboboxChipsInputStyles =
	"min-w-12 flex-1 text-base outline-none sm:text-sm [[data-slot=combobox-chip]+&]:ps-0.5"

export const comboboxChipsInputSmStyles = "ps-1.5"

export const comboboxChipsInputDefaultStyles = "ps-2"

export const comboboxInputGroupStyles =
	"relative not-has-[>*.w-full]:w-fit w-full text-foreground has-disabled:opacity-64"

export const comboboxStartAddonStyles =
	"pointer-events-none absolute inset-y-0 start-px z-10 flex items-center ps-[calc(--spacing(3)-1px)] opacity-80 has-[+[data-size=sm]]:ps-[calc(--spacing(2.5)-1px)] [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:-mx-0.5"

export const comboboxInputStartAddonStyles =
	"data-[size=sm]:*:data-[slot=combobox-input]:ps-[calc(--spacing(7.5)-1px)] *:data-[slot=combobox-input]:ps-[calc(--spacing(8.5)-1px)] sm:data-[size=sm]:*:data-[slot=combobox-input]:ps-[calc(--spacing(7)-1px)] sm:*:data-[slot=combobox-input]:ps-[calc(--spacing(8)-1px)]"

export const comboboxInputSmStyles =
	"has-[+[data-slot=combobox-trigger],+[data-slot=combobox-clear]]:*:data-[slot=combobox-input]:pe-6.5"

export const comboboxInputDefaultStyles =
	"has-[+[data-slot=combobox-trigger],+[data-slot=combobox-clear]]:*:data-[slot=combobox-input]:pe-7"

export const comboboxInputControlStyles = "has-disabled:opacity-100"

export const comboboxTriggerStyles =
	"absolute top-1/2 inline-flex size-8 shrink-0 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md border border-transparent opacity-80 outline-none transition-opacity pointer-coarse:after:absolute pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:opacity-100 has-[+[data-slot=combobox-clear]]:hidden sm:size-7 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0"

export const comboboxClearStyles =
	"absolute top-1/2 inline-flex size-8 shrink-0 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md border border-transparent opacity-80 outline-none transition-opacity pointer-coarse:after:absolute pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:opacity-100 has-[+[data-slot=combobox-clear]]:hidden sm:size-7 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0"

export const comboboxTriggerSmStyles = "end-0"

export const comboboxClearSmStyles = "end-0"

export const comboboxTriggerDefaultStyles = "end-0.5"

export const comboboxClearDefaultStyles = "end-0.5"

export const comboboxPositionerStyles = "z-50 select-none"

export const comboboxPopupFrameStyles =
	"relative flex max-h-full min-w-(--anchor-width) max-w-(--available-width) origin-(--transform-origin) rounded-lg border bg-popover not-dark:bg-clip-padding shadow-lg/5 transition-[scale,opacity] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]"

export const comboboxPopupStyles =
	"flex max-h-[min(var(--available-height),23rem)] flex-1 flex-col text-foreground"

export const comboboxItemStyles =
	"grid min-h-8 in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] cursor-default grid-cols-[1rem_1fr] items-center gap-2 rounded-sm py-1 ps-2 pe-4 text-base outline-none data-disabled:pointer-events-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0"

export const comboboxItemIndicatorStyles = "col-start-1"

export const comboboxItemTextStyles = "col-start-2"

export const comboboxSeparatorStyles = "mx-2 my-1 h-px bg-border last:hidden"

export const comboboxGroupStyles = "[[role=group]+&]:mt-1.5"

export const comboboxGroupLabelStyles = "px-2 py-1.5 font-medium text-muted-foreground text-xs"

export const comboboxEmptyStyles = "not-empty:p-2 text-center text-base text-muted-foreground sm:text-sm"

export const comboboxListStyles =
	"not-empty:scroll-py-1 not-empty:px-1 not-empty:py-1 in-data-has-overflow-y:pe-3"

export const comboboxStatusStyles = "px-3 py-2 font-medium text-muted-foreground text-xs empty:m-0 empty:p-0"

export const comboboxChipsStyles =
	"relative inline-flex min-h-9 w-full flex-wrap gap-1 rounded-lg border border-input bg-background not-dark:bg-clip-padding p-[calc(--spacing(1)-1px)] text-base shadow-xs/5 outline-none ring-ring/24 transition-shadow *:min-h-7 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-has-disabled:not-focus-within:not-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] focus-within:border-ring focus-within:ring-[3px] has-disabled:pointer-events-none has-data-[size=lg]:min-h-10 has-data-[size=sm]:min-h-8 has-aria-invalid:border-destructive/36 has-autofill:bg-foreground/4 has-disabled:opacity-64 has-[:disabled,:focus-within,[aria-invalid]]:shadow-none focus-within:has-aria-invalid:border-destructive/64 focus-within:has-aria-invalid:ring-destructive/16 has-data-[size=lg]:*:min-h-8 has-data-[size=sm]:*:min-h-6 sm:min-h-8 sm:text-sm sm:has-data-[size=lg]:min-h-9 sm:has-data-[size=sm]:min-h-7 sm:*:min-h-6 sm:has-data-[size=lg]:*:min-h-7 sm:has-data-[size=sm]:*:min-h-5 dark:not-has-disabled:bg-input/32 dark:has-autofill:bg-foreground/8 dark:has-aria-invalid:ring-destructive/24 dark:not-has-disabled:not-focus-within:not-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)]"

export const comboboxChipsStartAddonStyles =
	"flex shrink-0 items-center ps-2 opacity-80 has-[~[data-size=sm]]:has-[+[data-slot=combobox-chip]]:pe-1.5 has-[~[data-size=sm]]:ps-1.5 has-[+[data-slot=combobox-chip]]:pe-2 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:-ms-0.5 [&_svg]:-me-1.5"

// A translucent foreground tint rather than `bg-accent`: in this theme
// --accent, --muted and --secondary are all the same value as the
// chips field's own surface, so a solid token renders the chip
// invisible. Tinting toward the foreground lifts it in dark mode and
// darkens it in light, so the chip reads as a tag in both.
export const comboboxChipStyles =
	"flex min-w-0 max-w-full items-center gap-1 rounded-[calc(var(--radius-md)-1px)] border border-border/80 bg-foreground/8 ps-2 font-medium text-foreground text-sm outline-none dark:bg-foreground/12 sm:text-xs/(--text-xs--line-height) [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5"

export const comboboxChipTextStyles = "min-w-0 truncate"

export const comboboxChipRemoveStyles =
	"h-full shrink-0 cursor-pointer px-1.5 opacity-80 hover:opacity-100 [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5"
