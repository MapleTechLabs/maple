import { getChartById } from "@maple/ui/components/charts/registry"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"

import { ChartPreview } from "@/components/dashboard-builder/widgets/chart-preview"
import { formatCellValue } from "@/components/dashboard-builder/widgets/table-widget"
import type { WidgetPresetDefinition } from "@/components/dashboard-builder/widgets/widget-definitions"
import type { WidgetDisplayConfig } from "@/components/dashboard-builder/types"

/** Frame shared by every picker thumbnail: the preset's title over its preview. */
export function PreviewFrame({
	title,
	className = "flex flex-col gap-1.5",
	children,
}: {
	title?: string
	className?: string
	children: React.ReactNode
}) {
	return (
		<div className={`aspect-[4/3] ${className}`}>
			<div className="text-3xs text-muted-foreground">{title}</div>
			{children}
		</div>
	)
}

/**
 * Thumbnail for any preset that mounts a `chartRegistry` component: render the
 * chart with the registry entry's own sample data. Pie, funnel, histogram and
 * heatmap previously had four byte-identical copies of this.
 */
export function chartPresetPreview(defaultChartId: string) {
	return function ChartPresetPreview({ preset }: { preset: WidgetPresetDefinition }) {
		const entry = getChartById(preset.display.chartId ?? defaultChartId)
		if (!entry) return <div className="aspect-[4/3]" />
		return (
			<PreviewFrame title={preset.display.title}>
				<ChartPreview component={entry.component} data={entry.sampleData} />
			</PreviewFrame>
		)
	}
}

/**
 * Thumbnail for the row-based types. Table and list draw the same miniature
 * grid; only their sample rows differ.
 */
export function rowsPresetPreview(sampleRows: Record<string, Record<string, unknown>[]>) {
	return function RowsPresetPreview({ preset }: { preset: WidgetPresetDefinition }) {
		const rows = sampleRows[preset.id] ?? []
		const columns: NonNullable<WidgetDisplayConfig["columns"]> = preset.display.columns ?? []

		return (
			<PreviewFrame title={preset.display.title} className="flex flex-col overflow-hidden">
				<Table size="xs" variant="bare" scroll={false}>
					<TableHeader>
						<TableRow className="border-b border-border">
							{columns.map((column) => (
								<TableHead
									key={column.field}
									className="px-1 py-0.5 text-4xs"
									style={{ textAlign: column.align ?? "left" }}
								>
									{column.header}
								</TableHead>
							))}
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map((row, index) => (
							// eslint-disable-next-line react/no-array-index-key -- fixed sample data
							<TableRow key={index}>
								{columns.map((column) => (
									<TableCell
										key={column.field}
										className="max-w-[80px] truncate px-1 py-0.5 text-4xs"
										style={{ textAlign: column.align ?? "left" }}
									>
										{formatCellValue(row[column.field], column.unit)}
									</TableCell>
								))}
							</TableRow>
						))}
					</TableBody>
				</Table>
			</PreviewFrame>
		)
	}
}
