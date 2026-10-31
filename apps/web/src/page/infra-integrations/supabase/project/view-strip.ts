import { EMPTY_VALUE, formatBytes, formatPercent } from "@maple/ui/lib/format"
import { formatClockInTimezone } from "@maple/web-data/lib/timezone-format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { VALUE_TONE } from "../../../../components/infra/severity-tokens"
import { cn } from "@maple/ui/lib/utils"
import { type SparkPoint, type SparkWindow, windowSparkline } from "../../kit/window-sparkline"
import { SUPABASE_ACCENT } from "../connect"
import { SATURATION } from "../health"
import type { HealthStrip } from "./derive"
import type { Message } from "./message"

// The health strip: six tiles, each value over a line spark of the window and a caption.

type H = HtmlBuilder<Message>

const ofTotal = (fraction: number, total: number): string | undefined =>
	total > 0 ? `${formatBytes(fraction * total)} of ${formatBytes(total)}` : undefined

const signedBytes = (bytes: number): string =>
	bytes >= 0 ? `+${formatBytes(bytes)}` : `-${formatBytes(Math.abs(bytes))}`

type TileOptions = Readonly<{
	label: string
	value: string
	isWarn?: boolean
	spark: ReadonlyArray<SparkPoint>
	caption: string | undefined
}>

const tile = (h: H, window: SparkWindow, options: TileOptions): Html =>
	h.div(
		[h.Class("flex min-w-0 flex-col gap-2 rounded-md border bg-card p-4")],
		[
			h.span([h.Class("truncate text-2xs font-medium text-muted-foreground")], [options.label]),
			h.span(
				[
					h.Class(
						cn(
							"font-mono text-xl font-semibold tabular-nums",
							VALUE_TONE[options.isWarn === true ? "warn" : "neutral"],
						),
					),
				],
				[options.value],
			),
			windowSparkline(h, { points: options.spark, window, color: SUPABASE_ACCENT }),
			h.span([h.Class("truncate font-mono text-2xs text-muted-foreground")], [options.caption ?? ""]),
		],
	)

export const HEALTH_STRIP_GRID = "grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6"

export const healthStripView = (h: H, strip: HealthStrip, window: SparkWindow, timeZone: string): Html => {
	const { cpu, memory, disk, connections, cacheHit, dbSize } = strip
	const limit = connections.limit
	return h.div(
		[h.Class(HEALTH_STRIP_GRID)],
		[
			tile(h, window, {
				label: "CPU",
				value: cpu.avg === null ? EMPTY_VALUE : formatPercent(cpu.avg),
				spark: cpu.spark,
				caption:
					cpu.peak === null
						? ""
						: `peak ${formatPercent(cpu.peak.cpu)} at ${formatClockInTimezone(cpu.peak.bucket, { timeZone }).slice(0, 5)}`,
			}),
			tile(h, window, {
				label: "Memory",
				value: memory.total > 0 ? formatPercent(memory.used) : EMPTY_VALUE,
				spark: memory.spark,
				caption: ofTotal(memory.used, memory.total),
			}),
			tile(h, window, {
				label: "Disk",
				value: disk.size > 0 ? formatPercent(disk.used) : EMPTY_VALUE,
				spark: disk.spark,
				caption: ofTotal(disk.used, disk.size),
			}),
			tile(h, window, {
				label: "Connections",
				value: `${Math.round(connections.current)}${limit === null ? "" : ` / ${limit}`}`,
				isWarn: limit !== null && connections.peak >= limit * SATURATION,
				spark: connections.spark,
				caption: `peak ${Math.round(connections.peak)} · pooler ${Math.round(connections.pooler)} clients`,
			}),
			tile(h, window, {
				label: "Cache hit",
				value: cacheHit.ratio === null ? EMPTY_VALUE : formatPercent(cacheHit.ratio),
				spark: cacheHit.spark,
				caption: "buffer cache",
			}),
			tile(h, window, {
				label: "Database size",
				value: dbSize.bytes === null ? EMPTY_VALUE : formatBytes(dbSize.bytes),
				spark: dbSize.spark,
				caption: dbSize.growth === null ? undefined : `${signedBytes(dbSize.growth)} in this range`,
			}),
		],
	)
}
