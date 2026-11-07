import type { RailwayEnvironmentStatus } from "@maple/domain/http"
import { formatBytes, pluralize } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { segmentedBar } from "@maple/views/ui/meter"
import { skeleton, skeletonMeter } from "@maple/views/ui/skeleton"
import { relativeTime } from "../../../kit/relative-time"
import { statRailItem } from "../../../kit/stat-rail"
import type { RailwayServiceRow } from "../model"
import { fleetSync } from "./derive"
import { typography } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"
import { borderedBoxClass } from "@maple/views/ui/bordered-box"
import { Array as Arr } from "effect"

// `RailwayFleetBand` and `RailwayFleetBandLoading`.

/** `FLEET_BAND_BOXED`: a band standing alone on a page body. */
export const FLEET_BAND_BOXED = borderedBoxClass({ overflow: "hidden" })

const STRIP_SLICES = 6
const STRIP_FILLS = [
	"bg-foreground/45",
	"bg-foreground/36",
	"bg-foreground/29",
	"bg-foreground/23",
	"bg-foreground/18",
	"bg-foreground/14",
]
const LEGEND_NAMES = 3

const BAND = "flex flex-col border-b bg-background md:flex-row md:items-stretch"

export type FleetBandInputs = Readonly<{
	services: ReadonlyArray<RailwayServiceRow>
	environments: ReadonlyArray<RailwayEnvironmentStatus>
	authFailed: boolean
	nowMs: number
	timeZone: string
}>

const nameOf = (row: RailwayServiceRow) => row.serviceName || row.serviceId

const pollingValue = (inputs: FleetBandInputs, failing: number): string => {
	const count = inputs.environments.length
	if (inputs.authFailed) return "Paused"
	if (failing > 0) return `${failing} of ${count} failing`
	return `${count} ${pluralize(count, "environment")}`
}

export const railwayFleetBand = <M>(h: HtmlBuilder<M>, inputs: FleetBandInputs): Html => {
	const ranked = [...inputs.services].sort((a, b) => b.memoryAvg - a.memoryAvg)
	const total = Arr.reduce(ranked, 0, (sum, row) => sum + row.memoryAvg)
	const rest = Arr.reduce(ranked.slice(STRIP_SLICES), 0, (sum, row) => sum + row.memoryAvg)
	const segments = [
		...Arr.map(ranked.slice(0, STRIP_SLICES), (row, index) => ({
			key: `${row.environmentId}:${row.serviceId}`,
			value: row.memoryAvg,
			className: STRIP_FILLS[index],
			title: `${nameOf(row)} ${formatBytes(row.memoryAvg)}`,
		})),
		{ key: "rest", value: rest, className: "bg-foreground/10", title: "the rest" },
	]
	const sync = fleetSync(inputs.environments, inputs.authFailed)
	const count = inputs.services.length
	const subline = inputs.authFailed
		? "Railway rejected the token"
		: sync.lastSyncedAt !== null
			? relativeTime(h, {
					value: sync.lastSyncedAt,
					nowMs: inputs.nowMs,
					timeZone: inputs.timeZone,
					prefix: "synced",
				})
			: sync.pending > 0
				? "waiting on the first sync"
				: undefined
	return h.div(
		[h.Class(cn(BAND, FLEET_BAND_BOXED))],
		[
			vstack(
				h,
				{ gap: "2", justify: "center", className: "w-full px-4 py-3 md:w-[26rem] md:shrink-0" },
				[
					hstack(h, { gap: "1.5", align: "baseline", as: "span" }, [
						typography(h, { size: "base", weight: "semibold", mono: true, numeric: true }, [
							formatBytes(total),
						]),
						typography(h, { size: "2xs", tone: "muted" }, [
							"summed average memory across ",
							String(count),
							" ",
							pluralize(count, "service"),
						]),
					]),
					segmentedBar(h, {
						className: "w-full gap-px bg-transparent",
						minVisible: 1,
						label: Arr.join(
							Arr.map(ranked, (row) => `${row.serviceName} ${formatBytes(row.memoryAvg)}`),
							", ",
						),
						segments,
					}),
					hstack(
						h,
						{
							gap: "3",
							align: "stretch",
							as: "span",
							className: "text-3xs text-muted-foreground",
						},
						[
							...Arr.map(ranked.slice(0, LEGEND_NAMES), (row) =>
								typography(h, { mono: true, truncate: true }, [
									nameOf(row),
									" ",
									formatBytes(row.memoryAvg),
								]),
							),
							...(ranked.length > LEGEND_NAMES
								? [
										typography(h, { mono: true }, [
											"+",
											String(ranked.length - LEGEND_NAMES),
											" more",
										]),
									]
								: []),
						],
					),
				],
			),
			statRailItem(h, {
				size: "sm",
				eyebrow: "Polling",
				value: pollingValue(inputs, sync.failing),
				tone: inputs.authFailed || sync.failing > 0 ? "crit" : "neutral",
				subline,
				className: "flex flex-1 flex-col justify-center border-l",
			}),
		],
	)
}

export const railwayFleetBandLoading = <M>(h: HtmlBuilder<M>): Html =>
	h.div(
		[h.Class(cn(BAND, FLEET_BAND_BOXED))],
		[
			vstack(
				h,
				{ gap: "2", justify: "center", className: "w-full px-4 py-3 md:w-[26rem] md:shrink-0" },
				[skeleton(h, "h-4 w-48"), skeletonMeter(h), skeleton(h, "h-2.5 w-56")],
			),
			vstack(h, { gap: "1.5", justify: "center", grow: true, className: "border-l px-4 py-3" }, [
				skeleton(h, "h-3 w-16"),
				skeleton(h, "h-5 w-28"),
			]),
		],
	)
