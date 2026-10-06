import type * as React from "react"
import type { Virtualizer } from "@tanstack/react-virtual"
import { LoadingMoreRow } from "@maple/ui/components/ui/list-footer"
import { TableBody } from "@maple/ui/components/ui/table"

/**
 * A virtualized `<tbody>`: spacer rows above and below the rendered window keep
 * the table its full height, and a loading row trails it while the next page
 * loads. `renderRow` puts `measureRef` and `data-index={index}` on its row.
 */
export function VirtualTableBody<R, S extends Element>({
	virtualizer,
	rows,
	renderRow,
	colSpan,
	loadingMore = false,
	loadingLabel,
	ref,
}: {
	virtualizer: Virtualizer<S, Element>
	rows: ReadonlyArray<R>
	renderRow: (row: R, index: number, measureRef: (node: Element | null) => void) => React.ReactNode
	/** Column count, for the loading row. */
	colSpan: number
	loadingMore?: boolean
	loadingLabel?: string
	/** For `usePageScrollMargin`, when the rows ride the page's scroller. */
	ref?: React.Ref<HTMLTableSectionElement>
}) {
	const items = virtualizer.getVirtualItems()
	const first = items[0]
	const last = items[items.length - 1]
	const margin = virtualizer.options.scrollMargin
	return (
		<TableBody ref={ref}>
			{first ? (
				<tr aria-hidden style={{ height: first.start - margin }}>
					<td />
				</tr>
			) : null}
			{items.map((item) => {
				const row = rows[item.index]
				return row === undefined ? null : renderRow(row, item.index, virtualizer.measureElement)
			})}
			{last ? (
				<tr aria-hidden style={{ height: virtualizer.getTotalSize() - (last.end - margin) }}>
					<td />
				</tr>
			) : null}
			{loadingMore ? (
				<tr>
					<td colSpan={colSpan} className="p-2">
						<LoadingMoreRow label={loadingLabel} />
					</td>
				</tr>
			) : null}
		</TableBody>
	)
}
