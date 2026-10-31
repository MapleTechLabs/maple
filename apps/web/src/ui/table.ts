import { cn } from "@maple/ui/lib/utils"
import {
	tableBodyStyles,
	tableCellStyles,
	tableContainerScrollStyles,
	tableContainerStyles,
	tableHeadStyles,
	tableHeaderStickyStyles,
	tableHeaderStyles,
	tableRowLinkLiftStyles,
	tableRowLinkStyles,
	tableRowStyles,
	tableSortButtonStyles,
	tableSortIconStyles,
	tableSortIdleIconStyles,
	tableStyles,
} from "@maple/ui/styles/ui/table"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { withHint } from "./eyebrow"
import { icon } from "./icon"

// Port of packages/ui/src/components/ui/table.tsx. Rows and cells repeat, so they set one class
// attribute (S4) instead of `h.Class`.

type Children = ReadonlyArray<Html | string>
export type TableVariant = "default" | "card" | "bare"
export type TableSize = "default" | "sm" | "xs"

export const table = <M>(
	h: HtmlBuilder<M>,
	options: {
		readonly variant?: TableVariant
		readonly size?: TableSize
		readonly scroll?: boolean
		readonly className?: string
		readonly ariaLabel?: string
	},
	children: ReadonlyArray<Html>,
): Html =>
	h.div(
		[
			h.Class(cn(tableContainerStyles, (options.scroll ?? true) && tableContainerScrollStyles)),
			h.DataAttribute("slot", "table-container"),
			h.DataAttribute("variant", options.variant ?? "default"),
			h.DataAttribute("size", options.size ?? "default"),
		],
		[
			h.table(
				[
					...(options.ariaLabel === undefined ? [] : [h.AriaLabel(options.ariaLabel)]),
					h.Class(cn(tableStyles, options.className)),
					h.DataAttribute("slot", "table"),
				],
				children,
			),
		],
	)

export const tableHeader = <M>(
	h: HtmlBuilder<M>,
	children: ReadonlyArray<Html>,
	options: { readonly sticky?: boolean; readonly className?: string } = {},
): Html =>
	h.thead(
		[
			h.Class(
				cn(tableHeaderStyles, options.sticky === true && tableHeaderStickyStyles, options.className),
			),
			h.DataAttribute("slot", "table-header"),
		],
		children,
	)

export const tableBody = <M>(
	h: HtmlBuilder<M>,
	children: ReadonlyArray<Html>,
	className?: string,
	attributes: ReadonlyArray<Attribute<M>> = [],
): Html =>
	h.tbody(
		[h.Class(cn(tableBodyStyles, className)), h.DataAttribute("slot", "table-body"), ...attributes],
		children,
	)

export const tableRow = <M>(
	h: HtmlBuilder<M>,
	children: ReadonlyArray<Html>,
	className?: string,
	attributes: ReadonlyArray<Attribute<M>> = [],
): Html =>
	h.tr(
		[
			h.Attribute("class", cn(tableRowStyles, className)),
			h.DataAttribute("slot", "table-row"),
			...attributes,
		],
		children,
	)

export const tableHead = <M>(
	h: HtmlBuilder<M>,
	children: Children,
	className?: string,
	attributes: ReadonlyArray<Attribute<M>> = [],
): Html =>
	h.th(
		[
			h.Attribute("class", cn(tableHeadStyles, className)),
			h.DataAttribute("slot", "table-head"),
			...attributes,
		],
		children.flatMap((child) => withHint(h, child)),
	)

export const tableCell = <M>(
	h: HtmlBuilder<M>,
	children: Children,
	className?: string,
	attributes: ReadonlyArray<Attribute<M>> = [],
): Html =>
	h.td(
		[
			h.Attribute("class", cn(tableCellStyles, className)),
			h.DataAttribute("slot", "table-cell"),
			...attributes,
		],
		children,
	)

/** Lift for a control inside a `rowLink` row: it stays clickable above the overlay. */
export const ROW_LINK_LIFT = tableRowLinkLiftStyles

/** Row navigation: a real link stretched over its row (any positioned ancestor), never a row
 *  onClick. Without children it is an empty overlay and `label` is its accessible name. */
export const rowLink = <M>(
	h: HtmlBuilder<M>,
	options: {
		readonly href: string
		readonly label?: string
		readonly className?: string
		readonly attributes?: ReadonlyArray<Attribute<M>>
	},
	children: Children = [],
): Html =>
	h.a(
		[
			h.Href(options.href),
			h.Attribute("class", cn(tableRowLinkStyles, options.className)),
			...(options.label === undefined ? [] : [h.AriaLabel(options.label)]),
			...(options.attributes ?? []),
		],
		children,
	)

export type SortDirection = "asc" | "desc"

/** `aria-sort` for a sortable head; only the active column carries it. */
export const ariaSort = <M>(h: HtmlBuilder<M>, isActive: boolean, direction: SortDirection) =>
	isActive ? [h.AriaSort(direction === "asc" ? "ascending" : "descending")] : []

/** A sortable column label: the active column shows its direction, the others an arrow on hover. */
export const sortButton = <M>(
	h: HtmlBuilder<M>,
	options: {
		readonly isActive: boolean
		readonly direction: SortDirection
		readonly onClick: M
		readonly align?: "left" | "right"
		readonly className?: string
		readonly attributes?: ReadonlyArray<Attribute<M>>
	},
	children: Children,
): Html =>
	h.button(
		[
			h.Type("button"),
			h.Class(cn(tableSortButtonStyles, options.className)),
			h.DataAttribute("align", options.align ?? "left"),
			...(options.isActive ? [h.DataAttribute("active", "")] : []),
			h.OnClick(options.onClick),
			...(options.attributes ?? []),
		],
		[
			...children,
			options.isActive
				? icon(h, "ArrowUpIcon", {
						className: cn(tableSortIconStyles, options.direction === "desc" && "rotate-180"),
					})
				: icon(h, "ArrowUpDownIcon", { className: cn(tableSortIconStyles, tableSortIdleIconStyles) }),
		],
	)
