import { EMPTY_VALUE, formatBytes, formatPercent } from "@maple/ui/lib/format"
import { formatClockInTimezone } from "@maple/web-data/lib/timezone-format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { statRail, statRailItem } from "../../../kit/stat-rail"
import { SATURATION } from "../health"
import type { HealthStrip } from "./derive"
import type { Message } from "./message"

// The health strip: six tiles, each with its spark over the window.

type H = HtmlBuilder<Message>

const ofTotal = (fraction: number, total: number): string | undefined =>
	total > 0 ? `${formatBytes(fraction * total)} of ${formatBytes(total)}` : undefined

const signedBytes = (bytes: number): string =>
	bytes >= 0 ? `+${formatBytes(bytes)}` : `-${formatBytes(Math.abs(bytes))}`

export const healthStripView = (h: H, strip: HealthStrip, timeZone: string): Html => {
	const { cpu, memory, disk, connections, cacheHit, dbSize } = strip
	const limit = connections.limit
	const isSaturated = limit !== null && connections.peak >= limit * SATURATION
	return statRail(h, { columns: 6 }, [
		statRailItem(h, {
			size: "sm",
			eyebrow: "CPU",
			value: formatPercent(cpu.avg),
			spark: cpu.spark,
			subline: `peak ${formatPercent(cpu.peak)} at ${formatClockInTimezone(cpu.peakAt, { timeZone }).slice(0, 5)}`,
		}),
		statRailItem(h, {
			size: "sm",
			eyebrow: "Memory",
			value: memory.total > 0 ? formatPercent(memory.used) : EMPTY_VALUE,
			spark: memory.spark,
			subline: ofTotal(memory.used, memory.total),
		}),
		statRailItem(h, {
			size: "sm",
			eyebrow: "Disk",
			value: disk.size > 0 ? formatPercent(disk.used) : EMPTY_VALUE,
			spark: disk.spark,
			subline: ofTotal(disk.used, disk.size),
		}),
		statRailItem(h, {
			size: "sm",
			eyebrow: "Connections",
			value: `${Math.round(connections.current)}${limit === null ? "" : ` / ${limit}`}`,
			tone: isSaturated ? "warn" : undefined,
			spark: connections.spark,
			subline: `peak ${Math.round(connections.peak)} · pooler ${Math.round(connections.pooler)} clients`,
		}),
		statRailItem(h, {
			size: "sm",
			eyebrow: "Cache hit",
			value: cacheHit.ratio === null ? EMPTY_VALUE : formatPercent(cacheHit.ratio),
			spark: cacheHit.spark,
			subline: "buffer cache",
		}),
		statRailItem(h, {
			size: "sm",
			eyebrow: "Database size",
			value: dbSize.bytes === null ? EMPTY_VALUE : formatBytes(dbSize.bytes),
			spark: dbSize.spark,
			subline: dbSize.growth === null ? undefined : `${signedBytes(dbSize.growth)} in this range`,
		}),
	])
}
