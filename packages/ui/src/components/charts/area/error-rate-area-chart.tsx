import { useId, useMemo } from "react"
import { Area, AreaChart, CartesianGrid, ReferenceArea, XAxis, YAxis } from "recharts"

import { cn } from "../../../lib/utils"
import type { BaseChartProps } from "../_shared/chart-types"
import { useChartDragZoom } from "../_shared/use-drag-zoom"
import { renderReferenceLines } from "../_shared/reference-markers"
import { errorRateTimeSeriesData } from "../_shared/sample-data"
import { VerticalGradient } from "../_shared/svg-patterns"
import { useIncompleteSegments, extendConfigWithIncomplete } from "../_shared/use-incomplete-segments"
import {
	type ChartConfig,
	ChartContainer,
	ChartLegend,
	ChartLegendContent,
	ChartTooltip,
	ChartTooltipContent,
} from "../../ui/chart"
import { formatErrorRate, inferBucketSeconds, inferRangeMs, formatBucketLabel } from "../../../lib/format"

const VALUE_KEYS = ["errorRate"]

const baseChartConfig = {
	errorRate: { label: "Error Rate", color: "var(--chart-error)" },
} satisfies ChartConfig

export function ErrorRateAreaChart({
	data,
	className,
	legend,
	tooltip,
	referenceLines,
	renderReferenceMarker,
	syncId,
	onZoomSelect,
	timeZone,
}: BaseChartProps) {
	const dragZoom = useChartDragZoom(onZoomSelect)
	const id = useId()
	const gradientId = `errorRateGradient-${id.replace(/:/g, "")}`
	const fadedGradientId = `errorRateGradientFaded-${id.replace(/:/g, "")}`
	const chartData = data ?? errorRateTimeSeriesData

	const {
		data: processedData,
		hasIncomplete,
		incompleteKeys,
	} = useIncompleteSegments(chartData, VALUE_KEYS)

	const chartConfig = useMemo(
		() => extendConfigWithIncomplete(baseChartConfig, incompleteKeys),
		[incompleteKeys],
	)

	const axisContext = useMemo(
		() => ({
			rangeMs: inferRangeMs(chartData as Array<Record<string, unknown>>),
			bucketSeconds: inferBucketSeconds(chartData as Array<{ bucket: string }>),
		}),
		[chartData],
	)

	return (
		<ChartContainer config={chartConfig} className={cn(className, dragZoom.containerClassName)}>
			<AreaChart
				data={processedData}
				accessibilityLayer
				syncId={syncId}
				syncMethod="value"
				{...dragZoom.chartHandlers}
			>
				<defs>
					<VerticalGradient id={gradientId} color="var(--color-errorRate)" />
					{hasIncomplete && (
						<VerticalGradient
							id={fadedGradientId}
							color="var(--color-errorRate)"
							startOpacity={0.15}
							endOpacity={0}
						/>
					)}
				</defs>
				<CartesianGrid vertical={false} />
				{renderReferenceLines(referenceLines, renderReferenceMarker)}
				<XAxis
					dataKey="bucket"
					tickLine={false}
					axisLine={false}
					tickMargin={8}
					tickFormatter={(v) => formatBucketLabel(v, axisContext, "tick", timeZone)}
				/>
				<YAxis
					tickLine={false}
					axisLine={false}
					tickMargin={8}
					width={60}
					domain={[0, (dataMax: number) => Math.min(1, Math.max(dataMax * 1.2, 0.01))]}
					tickFormatter={(v) => formatErrorRate(v)}
				/>
				{tooltip !== "hidden" && (
					<ChartTooltip
						content={
							<ChartTooltipContent
								labelFormatter={(_, payload) => {
									if (!payload?.[0]?.payload?.bucket) return ""
									const bucket = payload[0].payload.bucket as string
									const release = referenceLines?.find((rl) => rl.x === bucket)
									return (
										<span>
											{formatBucketLabel(bucket, axisContext, "tooltip", timeZone)}
											{release?.label && (
												<span className="ml-2 text-muted-foreground">
													Deploy: {release.label}
												</span>
											)}
										</span>
									)
								}}
								formatter={(value, name, item) => {
									const nameStr = String(name)
									const isIncomplete = nameStr.endsWith("_incomplete")
									const baseKey = isIncomplete
										? nameStr.replace(/_incomplete$/, "")
										: nameStr
									if (isIncomplete && item.payload?.[baseKey] != null) return null
									if (!isIncomplete && value == null) return null
									return (
										<span className="flex items-center gap-2">
											<span
												className="shrink-0 size-2.5 rounded-[2px]"
												style={{ backgroundColor: item.color }}
											/>
											<span className="text-muted-foreground">Error Rate</span>
											<span className="font-mono font-medium">
												{formatErrorRate(value as number)}
											</span>
										</span>
									)
								}}
							/>
						}
					/>
				)}
				{legend === "visible" && <ChartLegend content={<ChartLegendContent />} />}
				<Area
					type="linear"
					dataKey="errorRate"
					stroke="var(--color-errorRate)"
					fill={`url(#${gradientId})`}
					isAnimationActive={false}
				/>
				{hasIncomplete && (
					<Area
						type="linear"
						dataKey="errorRate_incomplete"
						stroke="var(--color-errorRate)"
						fill={`url(#${fadedGradientId})`}
						strokeWidth={2}
						strokeDasharray="4 4"
						dot={false}
						connectNulls
						legendType="none"
						isAnimationActive={false}
					/>
				)}
				{dragZoom.overlayProps && <ReferenceArea {...dragZoom.overlayProps} />}
			</AreaChart>
		</ChartContainer>
	)
}
