import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import type { RendererComponentProps } from "./types"

interface DataTableProps {
	headers: string[]
	rows: string[][]
	title?: string
}

function maybeFormatNumber(value: string): string {
	const num = Number(value)
	if (value.trim() !== "" && !Number.isNaN(num) && Number.isFinite(num)) {
		if (Number.isInteger(num)) return num.toLocaleString()
		return num.toLocaleString(undefined, { maximumFractionDigits: 4 })
	}
	return value
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
									<TableCell key={j} className="max-w-[200px] truncate py-1">
										{maybeFormatNumber(cell)}
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
