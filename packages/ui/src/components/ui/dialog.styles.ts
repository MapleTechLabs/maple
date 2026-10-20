export const dialogBackdropStyles =
	"fixed inset-0 z-50 bg-black/32 backdrop-blur-sm transition-all duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0"

export const dialogViewportStyles =
	"fixed inset-0 z-50 grid grid-rows-[1fr_auto_3fr] justify-items-center p-4"

export const dialogViewportBottomStickStyles = "max-sm:grid-rows-[1fr_auto] max-sm:p-0 max-sm:pt-12"

export const dialogPopupStyles =
	"relative row-start-2 flex max-h-full min-h-0 w-full min-w-0 max-w-lg origin-center flex-col rounded-2xl border bg-popover not-dark:bg-clip-padding text-popover-foreground opacity-[calc(1-var(--nested-dialogs))] shadow-lg/5 outline-none transition-[scale,opacity,translate] duration-200 ease-in-out will-change-transform before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] data-ending-style:opacity-0 data-starting-style:opacity-0 sm:scale-[calc(1-0.1*var(--nested-dialogs))] sm:data-ending-style:scale-98 sm:data-starting-style:scale-98 dark:before:shadow-[0_-1px_--theme(--color-white/6%)]"

export const dialogPopupBottomStickStyles =
	"max-sm:max-w-none max-sm:origin-bottom max-sm:rounded-none max-sm:border-x-0 max-sm:border-t max-sm:border-b-0 max-sm:data-ending-style:translate-y-4 max-sm:data-starting-style:translate-y-4 max-sm:before:hidden max-sm:before:rounded-none"

export const dialogCloseStyles = "absolute end-2 top-2"

export const dialogHeaderStyles =
	"flex flex-col gap-2 p-6 in-[[data-slot=dialog-popup]:has([data-slot=dialog-panel])]:pb-3 max-sm:pb-4"

export const dialogFooterStyles =
	"flex flex-col-reverse gap-2 px-6 sm:flex-row sm:justify-end sm:rounded-b-[calc(var(--radius-2xl)-1px)]"

export const dialogFooterDefaultStyles = "border-t bg-muted/72 py-4"

export const dialogFooterBareStyles =
	"in-[[data-slot=dialog-popup]:has([data-slot=dialog-panel])]:pt-3 pt-4 pb-6"

export const dialogTitleStyles = "font-heading font-semibold text-xl leading-none"

export const dialogDescriptionStyles = "text-muted-foreground text-sm"

export const dialogPanelStyles =
	"p-6 in-[[data-slot=dialog-popup]:has([data-slot=dialog-header])]:pt-1 in-[[data-slot=dialog-popup]:has([data-slot=dialog-footer]:not(.border-t))]:pb-1"
