import type { RailwayEnvironmentStatus } from "@maple/domain/http"
import { formatBytes, pluralize } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { segmentedBar } from "../../../../ui/meter"
import { skeleton } from "../../../../ui/skeleton"
import { relativeTime } from "../../../kit/relative-time"
import { statRailItem } from "../../../kit/stat-rail"
import type { RailwayServiceRow } from "../model"
import { fleetSync } from "./derive"

// `RailwayFleetBand` and `RailwayFleetBandLoading`.

/** `FLEET_BAND_BOXED`: a band standing alone on a page body. */
export const FLEET_BAND_BOXED = "overflow-hidden rounded-md border"

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
	const total = ranked.reduce((sum, row) => sum + row.memoryAvg, 0)
	const rest = ranked.slice(STRIP_SLICES).reduce((sum, row) => sum + row.memoryAvg, 0)
	const segments = [
		...ranked.slice(0, STRIP_SLICES).map((row, index) => ({
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
			? relativeTime(h, { tooltip: "title",
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
			h.div(
				[h.Class("flex w-full flex-col justify-center gap-2 px-4 py-3 md:w-[26rem] md:shrink-0")],
				[
					h.span(
						[h.Class("flex items-baseline gap-1.5")],
						[
							h.span(
								[h.Class("font-mono text-base font-semibold tabular-nums")],
								[formatBytes(total)],
							),
							h.span(
								[h.Class("text-2xs text-muted-foreground")],
								[
									"summed average memory across ",
									String(count),
									" ",
									pluralize(count, "service"),
								],
							),
						],
					),
					segmentedBar(h, {
						className: "w-full gap-px bg-transparent",
						minVisible: 1,
						label: ranked
							.map((row) => `${row.serviceName} ${formatBytes(row.memoryAvg)}`)
							.join(", "),
						segments,
					}),
					h.span(
						[h.Class("flex gap-3 text-3xs text-muted-foreground")],
						[
							...ranked
								.slice(0, LEGEND_NAMES)
								.map((row) =>
									h.span(
										[h.Class("truncate font-mono")],
										[nameOf(row), " ", formatBytes(row.memoryAvg)],
									),
								),
							...(ranked.length > LEGEND_NAMES
								? [
										h.span(
											[h.Class("font-mono")],
											["+", String(ranked.length - LEGEND_NAMES), " more"],
										),
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
			h.div(
				[h.Class("flex w-full flex-col justify-center gap-2 px-4 py-3 md:w-[26rem] md:shrink-0")],
				[
					skeleton(h, "h-4 w-48"),
					skeleton(h, "h-1.5 w-full rounded-full"),
					skeleton(h, "h-2.5 w-56"),
				],
			),
			h.div(
				[h.Class("flex flex-1 flex-col justify-center gap-1.5 border-l px-4 py-3")],
				[skeleton(h, "h-3 w-16"), skeleton(h, "h-5 w-28")],
			),
		],
	)
