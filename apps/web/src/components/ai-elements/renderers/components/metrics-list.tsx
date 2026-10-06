import type { RendererComponentProps } from "./types"
import { Badge } from "@maple/ui/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { formatNumber } from "@maple/ui/lib/format"

interface MetricsListProps {
	summary: ReadonlyArray<{
		metricType: string
		metricCount: number
		dataPointCount: number
	}>
	metrics: ReadonlyArray<{
		metricName: string
		metricType: string
		serviceName: string
		metricUnit: string
		dataPointCount: number
	}>
}

export function MetricsList({ props }: RendererComponentProps<MetricsListProps>) {
	const { summary, metrics } = props

	return (
		<div className="space-y-2">
			{summary.length > 0 && (
				<div className="flex flex-wrap gap-2">
					{summary.map((s) => (
						<div key={s.metricType} className="flex items-center gap-1 text-2xs">
							<Badge variant="secondary" size="xs">
								{s.metricType}
							</Badge>
							<span className="text-muted-foreground">
								{s.metricCount} metrics, {formatNumber(s.dataPointCount)} points
							</span>
						</div>
					))}
				</div>
			)}
			<div className="max-h-[300px] overflow-y-auto">
				<Table size="xs" scroll={false}>
					<TableHeader>
						<TableRow>
							<TableHead>Name</TableHead>
							<TableHead>Type</TableHead>
							<TableHead>Service</TableHead>
							<TableHead>Unit</TableHead>
							<TableHead className="pr-0 text-right">Data Points</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{metrics.map((m) => (
							<TableRow key={`${m.metricName}-${m.metricType}`}>
								<TableCell className="max-w-[180px] truncate py-1 font-mono">{m.metricName}</TableCell>
								<TableCell className="py-1">
									<Badge variant="secondary" size="xs">
										{m.metricType}
									</Badge>
								</TableCell>
								<TableCell className="py-1 text-muted-foreground">{m.serviceName}</TableCell>
								<TableCell className="py-1 text-muted-foreground">{m.metricUnit || "-"}</TableCell>
								<TableCell className="py-1 pr-0 text-right font-mono text-muted-foreground">
									{formatNumber(m.dataPointCount)}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
		</div>
	)
}
