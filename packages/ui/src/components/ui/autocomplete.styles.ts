export const autocompleteInputGroupStyles =
	"relative not-has-[>*.w-full]:w-fit w-full text-foreground has-disabled:opacity-64"

export const autocompleteStartAddonStyles =
	"pointer-events-none absolute inset-y-0 start-px z-10 flex items-center ps-[calc(--spacing(3)-1px)] opacity-80 has-[+[data-size=sm]]:ps-[calc(--spacing(2.5)-1px)] [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:-mx-0.5"

export const autocompleteInputStartAddonStyles =
	"data-[size=sm]:*:data-[slot=autocomplete-input]:ps-[calc(--spacing(7.5)-1px)] *:data-[slot=autocomplete-input]:ps-[calc(--spacing(8.5)-1px)] sm:data-[size=sm]:*:data-[slot=autocomplete-input]:ps-[calc(--spacing(7)-1px)] sm:*:data-[slot=autocomplete-input]:ps-[calc(--spacing(8)-1px)]"

export const autocompleteInputSmStyles =
	"has-[+[data-slot=autocomplete-trigger],+[data-slot=autocomplete-clear]]:*:data-[slot=autocomplete-input]:pe-6.5"

export const autocompleteInputDefaultStyles =
	"has-[+[data-slot=autocomplete-trigger],+[data-slot=autocomplete-clear]]:*:data-[slot=autocomplete-input]:pe-7"

export const autocompleteInputTriggerStyles =
	"absolute top-1/2 inline-flex size-8 shrink-0 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md border border-transparent opacity-80 outline-none transition-colors pointer-coarse:after:absolute pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:opacity-100 has-[+[data-slot=autocomplete-clear]]:hidden sm:size-7 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0"

export const autocompleteInputClearStyles =
	"absolute top-1/2 inline-flex size-8 shrink-0 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md border border-transparent opacity-80 outline-none transition-colors pointer-coarse:after:absolute pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:opacity-100 has-[+[data-slot=autocomplete-clear]]:hidden sm:size-7 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0"

export const autocompleteInputTriggerSmStyles = "end-0"

export const autocompleteInputClearSmStyles = "end-0"

export const autocompleteInputTriggerDefaultStyles = "end-0.5"

export const autocompleteInputClearDefaultStyles = "end-0.5"

export const autocompletePositionerStyles = "z-50 select-none"

export const autocompletePopupSurfaceStyles =
	"relative flex max-h-full min-w-(--anchor-width) max-w-(--available-width) origin-(--transform-origin) rounded-lg border bg-popover not-dark:bg-clip-padding shadow-lg/5 transition-[scale,opacity] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]"

export const autocompletePopupStyles =
	"flex max-h-[min(var(--available-height),23rem)] flex-1 flex-col text-foreground"

export const autocompleteItemStyles =
	"flex min-h-8 cursor-default select-none items-center rounded-sm px-2 py-1 text-base outline-none data-disabled:pointer-events-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-64 sm:min-h-7 sm:text-sm"

export const autocompleteSeparatorStyles = "mx-2 my-1 h-px bg-border last:hidden"

export const autocompleteGroupStyles = "[[role=group]+&]:mt-1.5"

export const autocompleteGroupLabelStyles = "px-2 py-1.5 font-medium text-muted-foreground text-xs"

export const autocompleteEmptyStyles = "not-empty:p-2 text-center text-base text-muted-foreground sm:text-sm"

export const autocompleteListStyles = "not-empty:scroll-py-1 not-empty:p-1 in-data-has-overflow-y:pe-3"

export const autocompleteClearStyles =
	"absolute end-0.5 top-1/2 inline-flex size-8 shrink-0 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md border border-transparent opacity-80 outline-none transition-[color,background-color,box-shadow,opacity] pointer-coarse:after:absolute pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:opacity-100 sm:size-7 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0"

export const autocompleteStatusStyles =
	"px-3 py-2 font-medium text-muted-foreground text-xs empty:m-0 empty:p-0"
