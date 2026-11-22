/** The palette opens and closes on a shortcut many times a day, so it appears and leaves at once;
 *  only a nested dialog's push-back animates. */
export const commandDialogBackdropStyles = "fixed inset-0 z-50 bg-scrim backdrop-blur-sm"

export const commandDialogViewportStyles =
	"fixed inset-0 z-50 flex flex-col items-center px-4 py-[max(--spacing(4),4vh)] sm:py-[10vh]"

export const commandDialogPopupStyles =
	"relative row-start-2 flex max-h-105 min-h-0 w-full min-w-0 max-w-xl -translate-y-[calc(1.25rem*var(--nested-dialogs))] scale-[calc(1-0.1*var(--nested-dialogs))] flex-col rounded-2xl border bg-popover not-dark:bg-clip-padding text-popover-foreground opacity-[calc(1-0.1*var(--nested-dialogs))] shadow-popup outline-none transition-[scale,opacity,translate] duration-200 ease-out will-change-transform before:pointer-events-none before:absolute before:inset-0 before:rounded-2xl-inset before:bg-surface-strong before:shadow-control data-nested:data-ending-style:translate-y-8 data-nested:data-starting-style:translate-y-8 data-nested-dialog-open:origin-top **:data-[slot=scroll-area-viewport]:data-has-overflow-y:pe-1"

/** The input, list and footer share one text edge: the search glyph, the row titles and the
 *  hints line up at 16px from the popup. */
export const commandInputWrapperStyles = "px-1.5 py-1.5"

export const commandInputStyles =
	"border-transparent! bg-transparent! shadow-none before:hidden has-focus-visible:ring-0"

export const commandListStyles = "not-empty:scroll-py-2 not-empty:p-2"

export const commandEmptyStyles = "not-empty:py-6"

/** Stronger than the autocomplete's `bg-accent`, which matches the popup's `surface-strong` tint. */
export const commandItemStyles =
	"rounded-lg py-1.5 data-highlighted:bg-surface-highlight data-highlighted:text-foreground"

export const commandShortcutStyles = "ms-auto"

export const commandHintStyles = "inline-flex items-center gap-1.5 text-muted-foreground"

export const commandHintGroupStyles = "inline-flex items-center gap-4"

export const commandFooterStyles =
	"flex items-center justify-between gap-2 rounded-b-2xl-inset border-t px-4 py-3 text-muted-foreground text-xs"
