export const tableContainerStyles = "relative w-full"

export const tableContainerScrollStyles = "overflow-x-auto"

export const tableStyles =
	"w-full caption-bottom in-data-[variant=card]:border-separate in-data-[variant=card]:border-spacing-0 text-sm"

// Header rows never take the body's hover tint (descendant selector out-specifies it).
export const tableHeaderStyles =
	"[&_tr]:border-b [&_tr]:hover:bg-transparent in-data-[variant=bare]:[&_tr]:border-0"

export const tableHeaderStickyStyles = "sticky top-0 z-10 bg-background"

export const tableBodyStyles =
	"relative in-data-[variant=card]:rounded-xl in-data-[variant=card]:shadow-xs/5 before:pointer-events-none before:absolute before:inset-px not-in-data-[variant=card]:before:hidden before:rounded-[calc(var(--radius-xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/8%)] [&_tr:last-child]:border-0 in-data-[variant=card]:*:[tr]:border-0 in-data-[variant=card]:*:[tr]:*:[td]:border-b in-data-[variant=card]:*:[tr]:*:[td]:bg-card in-data-[variant=card]:*:[tr]:first:*:[td]:first:rounded-ss-xl in-data-[variant=card]:*:[tr]:*:[td]:first:border-s in-data-[variant=card]:*:[tr]:first:*:[td]:border-t in-data-[variant=card]:*:[tr]:last:*:[td]:last:rounded-ee-xl in-data-[variant=card]:*:[tr]:*:[td]:last:border-e in-data-[variant=card]:*:[tr]:first:*:[td]:last:rounded-se-xl in-data-[variant=card]:*:[tr]:last:*:[td]:first:rounded-es-xl in-data-[variant=card]:*:[tr]:hover:*:[td]:bg-[color-mix(in_srgb,var(--card),var(--color-black)_2%)] in-data-[variant=card]:*:[tr]:data-[state=selected]:*:[td]:bg-[color-mix(in_srgb,var(--card),var(--color-black)_4%)] dark:in-data-[variant=card]:*:[tr]:data-[state=selected]:*:[td]:bg-[color-mix(in_srgb,var(--card),var(--color-white)_4%)] dark:in-data-[variant=card]:*:[tr]:hover:*:[td]:bg-[color-mix(in_srgb,var(--card),var(--color-white)_2%)]"

export const tableFooterStyles =
	"border-t in-data-[variant=card]:border-none bg-transparent not-in-data-[variant=card]:bg-[color-mix(in_srgb,var(--card),var(--color-black)_2%)] font-medium dark:not-in-data-[variant=card]:bg-[color-mix(in_srgb,var(--card),var(--color-white)_2%)] [&>tr]:last:border-b-0"

export const tableRowStyles =
	"relative border-b in-data-[variant=bare]:border-0 in-data-[variant=bare]:hover:bg-transparent not-in-data-[variant=card]:hover:bg-[color-mix(in_srgb,var(--background),var(--color-black)_2%)] not-in-data-[variant=card]:data-[state=selected]:bg-[color-mix(in_srgb,var(--background),var(--color-black)_4%)] dark:not-in-data-[variant=card]:data-[state=selected]:bg-[color-mix(in_srgb,var(--background),var(--color-white)_4%)] dark:not-in-data-[variant=card]:hover:bg-[color-mix(in_srgb,var(--background),var(--color-white)_2%)]"

// Column labels share the eyebrow overline token (size, case, tracking, colour) with list headers.
export const tableHeadStyles =
	"h-10 whitespace-nowrap px-2.5 text-left align-middle font-medium text-3xs uppercase tracking-[0.12em] text-muted-foreground leading-none in-data-[size=sm]:h-8 in-data-[size=sm]:px-2 in-data-[size=xs]:h-auto in-data-[size=xs]:px-0 in-data-[size=xs]:pr-2 in-data-[size=xs]:pb-1 has-[[role=checkbox]]:w-px last:has-[[role=checkbox]]:ps-0 first:has-[[role=checkbox]]:pe-0"

export const tableCellStyles =
	"whitespace-nowrap bg-clip-padding p-2.5 in-data-[slot=table-footer]:py-3.5 align-middle leading-none in-data-[size=sm]:px-2 in-data-[size=sm]:py-1.5 in-data-[size=sm]:text-xs in-data-[size=xs]:px-0 in-data-[size=xs]:py-0.5 in-data-[size=xs]:pr-2 in-data-[size=xs]:text-2xs in-data-[variant=card]:first:ps-[calc(--spacing(2.5)-1px)] in-data-[variant=card]:last:pe-[calc(--spacing(2.5)-1px)] has-[[role=checkbox]]:w-px last:has-[[role=checkbox]]:ps-0 first:has-[[role=checkbox]]:pe-0"

export const truncatedCellStyles = "w-full max-w-0"

export const tableCaptionStyles = "in-data-[variant=card]:my-4 mt-4 text-muted-foreground text-sm"
