/** `--page-gutter` is the one page edge: the top bar, header, filter rail and body all sit on it. */
export const pageLayoutStyles = "flex min-h-0 flex-1 flex-col [--page-gutter:--spacing(4)] lg:[--page-gutter:--spacing(6)]"

export const pageTitleStyles = "font-display text-2xl font-semibold tracking-tight truncate leading-6.5"

/** A title that is a sentence: it wraps instead of truncating, on a line height made for two lines. */
export const pageTitleWrapStyles = "font-display text-2xl font-semibold tracking-tight text-balance leading-8"

export const pageDescriptionStyles = "font-prose text-muted-foreground"

export const pageHeaderStyles =
	"flex flex-col gap-2 @2xl/page:flex-row @2xl/page:items-start @2xl/page:justify-between @2xl/page:gap-4"

export const pageHeaderTextStyles = "min-w-0 flex-1"

export const pageHeaderActionsStyles = "min-w-0 @2xl/page:shrink-0"

export const pageStickyAreaStyles =
	"shrink-0 space-y-4 border-b border-transparent px-(--page-gutter) pt-(--page-gutter) pb-4"

export const pageStickyAreaScrolledStyles = "border-border-subtle"

export const pageBodyStyles = "flex min-h-0 flex-1 overflow-hidden"

export const pageFilterSidebarWidthStyles = "w-64"

export const pageFilterSheetStyles = "w-72 overflow-y-auto p-4 pt-12"

export const pageFilterSheetHeaderStyles = "sr-only"

export const pageFilterSidebarStyles =
	"sticky top-0 h-full shrink-0 overflow-y-auto border-r px-4 pt-(--page-gutter) pb-4"

export const pageContentStyles = "@container/page flex min-h-0 min-w-0 flex-1 flex-col"

export const pageScrollAreaStyles =
	"flex min-h-0 flex-1 flex-col overflow-auto px-(--page-gutter) pt-4 pb-(--page-gutter)"

export const pageFillStyles = "flex min-h-0 min-w-0 flex-1 flex-col"

export const pageRightSidebarWidthStyles = "w-72"

export const pageRightSheetStyles = "w-80 overflow-y-auto pt-10"

export const pageRightSheetHeaderStyles = "sr-only"

export const pageRightSidebarStyles = "hidden shrink-0 overflow-y-auto border-l lg:block"
