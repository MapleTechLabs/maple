import { cn } from "@maple/ui/lib/utils"
import {
	tableSkeletonBarStyles,
	tableSkeletonDefaultBarStyles,
	tableSkeletonStyles,
} from "@maple/ui/styles/ui/table-skeleton"
import type { Html, HtmlBuilder } from "foldkit/html"
import { skeleton } from "./skeleton"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "./table"

// Port of packages/ui/src/components/ui/table-skeleton.tsx: the loading placeholder for row tables.

export interface TableSkeletonColumn {
	readonly header?: Html | string
	readonly headClassName?: string
	readonly cellClassName?: string
	/** Bar classes (`h-4` unless overridden); `null` leaves the cell empty. */
	readonly skeleton?: string | null
	readonly width?: string | number
}

export interface TableSkeletonOptions {
	readonly columns: number | ReadonlyArray<TableSkeletonColumn>
	readonly rows?: number
	readonly showHeader?: boolean
	readonly tableClassName?: string
	readonly className?: string
	readonly rowClassName?: string
}

export const tableSkeleton = <M>(h: HtmlBuilder<M>, options: TableSkeletonOptions): Html => {
	const columns: ReadonlyArray<TableSkeletonColumn> =
		typeof options.columns === "number"
			? Array.from({ length: options.columns }, () => ({}))
			: options.columns
	const header = tableHeader(h, [
		tableRow(
			h,
			columns.map((column) =>
				tableHead(
					h,
					column.header === undefined ? [] : [column.header],
					column.headClassName,
					column.width === undefined
						? []
						: [
								h.Style({
									width:
										typeof column.width === "number" ? `${column.width}px` : column.width,
								}),
							],
				),
			),
		),
	])
	const rows = Array.from({ length: options.rows ?? 8 }, () =>
		tableRow(
			h,
			columns.map((column) =>
				tableCell(
					h,
					column.skeleton === null
						? []
						: [
								skeleton(
									h,
									cn(
										tableSkeletonBarStyles,
										column.skeleton ?? tableSkeletonDefaultBarStyles,
									),
								),
							],
					column.cellClassName,
				),
			),
			options.rowClassName,
		),
	)
	return h.div(
		[h.Class(cn(tableSkeletonStyles, options.className))],
		[
			table(h, { className: options.tableClassName }, [
				...((options.showHeader ?? true) ? [header] : []),
				tableBody(h, rows),
			]),
		],
	)
}
