export const tableContainerStyles = "relative w-full"

export const tableContainerScrollStyles = "overflow-x-auto"

export const tableStyles =
	"w-full caption-bottom in-data-[variant=card]:border-separate in-data-[variant=card]:border-spacing-0 text-sm"

// Header rows never take the body's hover tint (descendant selector out-specifies it).
export const tableHeaderStyles =
	"[&_tr]:border-b [&_tr]:hover:bg-transparent [&_tr]:active:bg-transparent in-data-[variant=bare]:[&_tr]:border-0"

// A collapsed table's row border scrolls away under a sticky header, so the rule is an inset shadow.
export const tableHeaderStickyStyles =
	"sticky top-0 z-10 bg-background [&_tr]:border-0 [&_th]:shadow-rule-bottom"

export const tableBodyStyles =
	"relative in-data-[variant=card]:rounded-xl in-data-[variant=card]:shadow-raised before:pointer-events-none before:absolute before:inset-px not-in-data-[variant=card]:before:hidden before:rounded-xl-inset before:shadow-control [&_tr:last-child]:border-0 in-data-[variant=card]:*:[tr]:border-0 in-data-[variant=card]:*:[tr]:*:[td]:border-b in-data-[variant=card]:*:[tr]:*:[td]:bg-card in-data-[variant=card]:*:[tr]:first:*:[td]:first:rounded-ss-xl in-data-[variant=card]:*:[tr]:*:[td]:first:border-s in-data-[variant=card]:*:[tr]:first:*:[td]:border-t in-data-[variant=card]:*:[tr]:last:*:[td]:last:rounded-ee-xl in-data-[variant=card]:*:[tr]:*:[td]:last:border-e in-data-[variant=card]:*:[tr]:first:*:[td]:last:rounded-se-xl in-data-[variant=card]:*:[tr]:last:*:[td]:first:rounded-es-xl in-data-[variant=card]:*:[tr]:hover:*:[td]:bg-[color-mix(in_srgb,var(--card),var(--color-black)_2%)] in-data-[variant=card]:*:[tr]:active:*:[td]:bg-[color-mix(in_srgb,var(--card),var(--color-black)_2%)] in-data-[variant=card]:*:[tr]:data-[state=selected]:*:[td]:bg-[color-mix(in_srgb,var(--card),var(--color-black)_4%)] dark:in-data-[variant=card]:*:[tr]:data-[state=selected]:*:[td]:bg-[color-mix(in_srgb,var(--card),var(--color-white)_4%)] dark:in-data-[variant=card]:*:[tr]:hover:*:[td]:bg-[color-mix(in_srgb,var(--card),var(--color-white)_2%)] dark:in-data-[variant=card]:*:[tr]:active:*:[td]:bg-[color-mix(in_srgb,var(--card),var(--color-white)_2%)]"

export const tableFooterStyles =
	"border-t in-data-[variant=card]:border-none bg-transparent not-in-data-[variant=card]:bg-[color-mix(in_srgb,var(--card),var(--color-black)_2%)] font-medium dark:not-in-data-[variant=card]:bg-[color-mix(in_srgb,var(--card),var(--color-white)_2%)] [&>tr]:last:border-b-0"

// Body rows divide on the subtle hairline so the header rule reads as the stronger line. The hover is
// unprefixed so a row's own `hover:bg-*` merges over it (card rows paint their cells instead).
export const tableRowStyles =
	"relative border-b border-border-subtle in-data-[slot=table-header]:border-border in-data-[variant=bare]:border-0 in-data-[variant=bare]:hover:bg-transparent in-data-[variant=bare]:active:bg-transparent hover:bg-surface-sunken active:bg-surface-sunken data-[state=selected]:bg-surface-strong in-data-[variant=card]:hover:bg-transparent in-data-[variant=card]:active:bg-transparent in-data-[variant=card]:data-[state=selected]:bg-transparent"

// Column labels share the eyebrow overline token (size, case, tracking, colour) with list headers.
// Div-based tables (infra) use the label type alone.
export const tableHeadLabelStyles =
	"font-medium text-3xs uppercase tracking-[0.12em] text-muted-foreground leading-none"

export const tableHeadStyles = `h-10 whitespace-nowrap px-2.5 text-left align-middle ${tableHeadLabelStyles} in-data-[size=sm]:h-8 in-data-[size=sm]:px-2 in-data-[size=xs]:h-auto in-data-[size=xs]:px-0 in-data-[size=xs]:pr-2 in-data-[size=xs]:pb-1 has-[[role=checkbox]]:w-px last:has-[[role=checkbox]]:ps-0 first:has-[[role=checkbox]]:pe-0`

export const tableCellStyles =
	"whitespace-nowrap bg-clip-padding p-2.5 in-data-[slot=table-footer]:py-3.5 align-middle leading-none in-data-[size=sm]:px-2 in-data-[size=sm]:py-1.5 in-data-[size=sm]:text-xs in-data-[size=xs]:px-0 in-data-[size=xs]:py-0.5 in-data-[size=xs]:pr-2 in-data-[size=xs]:text-2xs in-data-[variant=card]:first:ps-[calc(--spacing(2.5)-1px)] in-data-[variant=card]:last:pe-[calc(--spacing(2.5)-1px)] has-[[role=checkbox]]:w-px last:has-[[role=checkbox]]:ps-0 first:has-[[role=checkbox]]:pe-0"

export const truncatedCellStyles = "w-full max-w-0"

export const tableCaptionStyles = "in-data-[variant=card]:my-4 mt-4 text-muted-foreground text-sm"

// A row's link stretched over the nearest positioned ancestor (the row); the ring shows on keyboard focus.
export const tableRowLinkStyles =
	"after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:ring-1 focus-visible:after:ring-ring focus-visible:after:ring-inset"

// Lifts a control inside a linked row above the overlay so it keeps its own clicks.
export const tableRowLinkLiftStyles = "relative z-10"

// Sortable column label: keeps the head's case and tracking (buttons reset both). The arrow slot is
// always reserved so activating a column never shifts its label; right-aligned heads put the arrow
// first so the label's edge lines up with the numbers under it. The idle arrow is a reveal in a
// quieter ink, never a dimmed icon.
export const tableSortButtonStyles =
	"group/sort inline-flex max-w-full items-center gap-1 rounded-xs [letter-spacing:inherit] [text-transform:inherit] text-muted-foreground hover:text-foreground active:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[active]:text-foreground data-[align=right]:flex-row-reverse"

export const tableSortIconStyles =
	"size-2.5 shrink-0 transition-[opacity,rotate] duration-150 ease-out"

export const tableSortIdleIconStyles =
	"text-foreground-subtle opacity-0 group-hover/sort:opacity-100 group-active/sort:opacity-100 group-focus-visible/sort:opacity-100"
