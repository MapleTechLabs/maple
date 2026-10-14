import { memo } from "react"
import { Link } from "@tanstack/react-router"
import { SkeletonList } from "@maple/ui/components/ui/skeleton"
import { shortId } from "@maple/ui/lib/ids"
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
	TruncatedCell,
} from "@maple/ui/components/ui/table"
import { cn } from "@maple/ui/lib/utils"
import { WidgetEmptyState, WidgetFrame } from "@/components/dashboard-builder/widgets/widget-shell"
import { columnVisibilityClass, formatCellValue } from "@/components/dashboard-builder/widgets/table-widget"
import { resolveFieldPath } from "@/lib/resolve-field-path"
import type { WidgetDataState, WidgetDisplayConfig, WidgetMode } from "@/components/dashboard-builder/types"

interface ListWidgetProps {
	dataState: WidgetDataState
	display: WidgetDisplayConfig
	mode: WidgetMode
}

type ColumnDef = {
	field: string
	header: string
	unit?: string
	width?: number
	align?: "left" | "center" | "right"
	hidden?: boolean
}

export const ListWidget = memo(function ListWidget({ dataState, display, mode }: ListWidgetProps) {
	const title = display.title || "Untitled"
	const rows =
		dataState.status === "ready" && Array.isArray(dataState.data)
			? (dataState.data as Record<string, unknown>[])
			: []
	const columns = display.columns ?? []

	const baseColumns: ColumnDef[] =
		columns.length > 0
			? columns
			: rows.length > 0
				? Object.keys(rows[0])
						.filter((key) => {
							const val = rows[0][key]
							return val == null || typeof val !== "object" || Array.isArray(val)
						})
						.map((key) => ({ field: key, header: key }))
				: []
	const effectiveColumns = baseColumns.filter((col) => !col.hidden)

	return (
		<WidgetFrame
			title={title}
			dataState={dataState}
			mode={mode}
			contentClassName="flex-1 min-h-0 overflow-auto p-0"
			loadingSkeleton={<SkeletonList rows={5} rowClassName="h-6" gap="2" className="p-3" />}
		>
			{rows.length === 0 ? (
				<WidgetEmptyState />
			) : (
				<Table>
					<TableHeader>
						<TableRow>
							{effectiveColumns.map((col, colIndex) => (
								<TableHead
									key={col.field}
									className={cn("text-xs", columnVisibilityClass(colIndex))}
									style={{
										textAlign: col.align ?? "left",
										width: col.width ? `${col.width}px` : undefined,
									}}
								>
									{col.header}
								</TableHead>
							))}
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map((row, i) => (
							<TableRow key={i}>
								{effectiveColumns.map((col, colIndex) => {
									const value = resolveFieldPath(row, col.field)
									const displayValue = Array.isArray(value)
										? value.join(", ")
										: formatCellValue(value, col.unit)

									let content: React.ReactNode = displayValue
									if (col.field === "traceId" && typeof value === "string" && value) {
										const truncated = shortId(value, "trace")
										const tsRaw = row.timestamp ?? row.startTime
										const t = typeof tsRaw === "string" ? tsRaw : undefined
										content = (
											<Link
												to="/traces/$traceId"
												params={{ traceId: value }}
												search={t ? { t } : undefined}
												target="_blank"
												className="font-mono text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary"
											>
												{truncated}
											</Link>
										)
									} else if (
										col.field === "spanName" &&
										typeof value === "string" &&
										value
									) {
										content = (
											<Link
												to="/traces"
												search={{ spanNames: [value] }}
												target="_blank"
												className="hover:underline underline-offset-2"
											>
												{displayValue}
											</Link>
										)
									}

									// A log body is unbounded: let it take the spare width and truncate.
									if (col.field === "body" && typeof displayValue === "string") {
										return (
											<TruncatedCell
												key={col.field}
												className={cn("text-xs", columnVisibilityClass(colIndex))}
												style={{ textAlign: col.align ?? "left" }}
											>
												<span className="block truncate" title={displayValue}>
													{displayValue}
												</span>
											</TruncatedCell>
										)
									}

									return (
										<TableCell
											key={col.field}
											className={cn("text-xs", columnVisibilityClass(colIndex))}
											style={{ textAlign: col.align ?? "left" }}
										>
											{content}
										</TableCell>
									)
								})}
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
		</WidgetFrame>
	)
})
