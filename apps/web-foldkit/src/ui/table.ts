import { cn } from "@maple/ui/lib/utils"
import {
	tableBodyStyles,
	tableCaptionStyles,
	tableCellStyles,
	tableContainerScrollStyles,
	tableContainerStyles,
	tableFooterStyles,
	tableHeadStyles,
	tableHeaderStickyStyles,
	tableHeaderStyles,
	tableRowStyles,
	tableStyles,
	truncatedCellStyles,
} from "@maple/ui/styles/ui/table"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"

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
		[h.table([h.Class(cn(tableStyles, options.className)), h.DataAttribute("slot", "table")], children)],
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

export const tableBody = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html>, className?: string): Html =>
	h.tbody([h.Class(cn(tableBodyStyles, className)), h.DataAttribute("slot", "table-body")], children)

export const tableFooter = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html>, className?: string): Html =>
	h.tfoot([h.Class(cn(tableFooterStyles, className)), h.DataAttribute("slot", "table-footer")], children)

export const tableRow = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html>, className?: string): Html =>
	h.tr(
		[h.Attribute("class", cn(tableRowStyles, className)), h.DataAttribute("slot", "table-row")],
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
		children,
	)

export const tableCell = <M>(h: HtmlBuilder<M>, children: Children, className?: string): Html =>
	h.td(
		[h.Attribute("class", cn(tableCellStyles, className)), h.DataAttribute("slot", "table-cell")],
		children,
	)

/** A cell whose text truncates instead of widening the table. */
export const truncatedCell = <M>(h: HtmlBuilder<M>, children: Children, className?: string): Html =>
	tableCell(h, children, cn(truncatedCellStyles, className))

export const tableCaption = <M>(h: HtmlBuilder<M>, children: Children, className?: string): Html =>
	h.caption(
		[h.Class(cn(tableCaptionStyles, className)), h.DataAttribute("slot", "table-caption")],
		children,
	)
