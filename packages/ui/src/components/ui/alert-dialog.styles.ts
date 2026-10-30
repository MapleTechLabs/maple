export const alertDialogBackdropStyles =
	"fixed inset-0 z-50 bg-black/32 backdrop-blur-sm transition-all duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0"

export const alertDialogViewportStyles =
	"fixed inset-0 z-50 grid grid-rows-[1fr_auto_3fr] justify-items-center p-4"

export const alertDialogViewportBottomStickStyles = "max-sm:grid-rows-[1fr_auto] max-sm:p-0 max-sm:pt-12"

export const alertDialogPopupStyles =
	"relative row-start-2 flex max-h-full min-h-0 w-full min-w-0 max-w-lg origin-center flex-col rounded-2xl border bg-popover not-dark:bg-clip-padding text-popover-foreground opacity-[calc(1-var(--nested-dialogs))] shadow-lg/5 transition-[scale,opacity,translate] duration-200 ease-in-out will-change-transform before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] data-ending-style:opacity-0 data-starting-style:opacity-0 sm:scale-[calc(1-0.1*var(--nested-dialogs))] sm:data-ending-style:scale-98 sm:data-starting-style:scale-98 dark:before:shadow-[0_-1px_--theme(--color-white/6%)]"

export const alertDialogPopupBottomStickStyles =
	"max-sm:max-w-none max-sm:origin-bottom max-sm:rounded-none max-sm:border-x-0 max-sm:border-t max-sm:border-b-0 max-sm:data-ending-style:translate-y-4 max-sm:data-starting-style:translate-y-4 max-sm:before:hidden max-sm:before:rounded-none"

export const alertDialogHeaderStyles = "flex flex-col gap-2 p-6 text-center max-sm:pb-4 sm:text-left"

export const alertDialogFooterStyles =
	"flex flex-col-reverse gap-2 px-6 sm:flex-row sm:justify-end sm:rounded-b-[calc(var(--radius-2xl)-1px)]"

export const alertDialogFooterDefaultStyles = "border-t bg-surface-strong py-4"

export const alertDialogFooterBareStyles = "pb-6"

export const alertDialogTitleStyles = "font-heading font-semibold text-xl leading-none"

export const alertDialogDescriptionStyles = "text-muted-foreground text-sm"

export const alertDialogMediaStyles =
	"mb-2 inline-flex size-10 items-center justify-center rounded-lg bg-muted *:[svg:not([class*='size-'])]:size-6"
