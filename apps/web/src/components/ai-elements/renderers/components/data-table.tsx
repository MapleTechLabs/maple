import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import type { RendererComponentProps } from "./types"
import { formatCell } from "./data-table-format"

interface DataTableProps {
	headers: string[]
	rows: string[][]
	title?: string
}

export function DataTable({ props }: RendererComponentProps<DataTableProps>) {
	const { headers, rows, title } = props

	return (
		<div className="space-y-1">
			{title && <p className="text-2xs font-medium text-muted-foreground">{title}</p>}
			<div className="max-h-[300px] overflow-auto">
				<Table size="xs" scroll={false}>
					<TableHeader>
						<TableRow>
							{headers.map((h) => (
								<TableHead key={h}>{h}</TableHead>
							))}
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map((row, i) => (
							<TableRow key={i}>
								{row.map((cell, j) => (
									<TableCell key={j} className="py-1">
										<span className="block max-w-[200px] truncate" title={cell}>
											{formatCell(cell, headers[j])}
										</span>
									</TableCell>
								))}
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
		</div>
	)
}
