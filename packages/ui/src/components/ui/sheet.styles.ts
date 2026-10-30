export const sheetBackdropStyles =
	"fixed inset-0 z-50 bg-black/32 backdrop-blur-sm transition-all duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0"

export const sheetViewportStyles = "fixed inset-0 z-50 grid"

export const sheetViewportBottomStyles = "grid grid-rows-[1fr_auto] pt-12"

export const sheetViewportTopStyles = "grid grid-rows-[auto_1fr] pb-12"

export const sheetViewportLeftStyles = "flex justify-start"

export const sheetViewportRightStyles = "flex justify-end"

export const sheetViewportInsetStyles = "sm:p-4"

export const sheetPopupStyles =
	"relative flex max-h-full min-h-0 w-full min-w-0 flex-col bg-popover not-dark:bg-clip-padding text-popover-foreground shadow-lg/5 transition-[opacity,translate] duration-200 ease-in-out will-change-transform before:pointer-events-none before:absolute before:inset-0 before:shadow-[0_1px_--theme(--color-black/4%)] data-ending-style:opacity-0 data-starting-style:opacity-0 max-sm:before:hidden dark:before:shadow-[0_-1px_--theme(--color-white/6%)]"

export const sheetPopupBottomStyles =
	"row-start-2 border-t data-ending-style:translate-y-8 data-starting-style:translate-y-8"

export const sheetPopupTopStyles =
	"border-b data-ending-style:-translate-y-8 data-starting-style:-translate-y-8"

export const sheetPopupLeftStyles =
	"w-[calc(100%-(--spacing(12)))] max-w-md border-e data-ending-style:-translate-x-8 data-starting-style:-translate-x-8"

export const sheetPopupRightStyles =
	"col-start-2 w-[calc(100%-(--spacing(12)))] max-w-md border-s data-ending-style:translate-x-8 data-starting-style:translate-x-8"

export const sheetPopupInsetStyles =
	"before:hidden sm:rounded-2xl sm:border sm:before:rounded-[calc(var(--radius-2xl)-1px)] sm:**:data-[slot=sheet-footer]:rounded-b-[calc(var(--radius-2xl)-1px)]"

export const sheetCloseStyles = "absolute end-2 top-2"

export const sheetHeaderStyles =
	"flex flex-col gap-2 p-6 in-[[data-slot=sheet-popup]:has([data-slot=sheet-panel])]:pb-3 max-sm:pb-4"

export const sheetFooterStyles = "flex flex-col-reverse gap-2 px-6 sm:flex-row sm:justify-end"

export const sheetFooterDefaultStyles = "border-t bg-surface-strong py-4"

export const sheetFooterBareStyles =
	"in-[[data-slot=sheet-popup]:has([data-slot=sheet-panel])]:pt-3 pt-4 pb-6"

export const sheetTitleStyles = "font-heading font-semibold text-xl leading-none"

export const sheetDescriptionStyles = "text-muted-foreground text-sm"

export const sheetPanelStyles =
	"p-6 in-[[data-slot=sheet-popup]:has([data-slot=sheet-header])]:pt-1 in-[[data-slot=sheet-popup]:has([data-slot=sheet-footer]:not(.border-t))]:pb-1"
