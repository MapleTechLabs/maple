import { GCP_INFRA_SERVICES, type GcpInfraServiceId } from "@maple/domain/gcp-infra"
import type { GcpResourcesResponse } from "@maple/domain/http"
import { countLabel, formatNumber } from "@maple/ui/lib/format"
import { type GcpFleetService, gcpFleet } from "../../components/infra/gcp/tabs"
import { gcpWorkloadCounts } from "../../components/integrations/gcp-usage"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { Keyed } from "../../data/keyed"
import type { LoadFailure } from "../../data/load-failure"
import { statRailItem, statRailItemSkeleton } from "../kit/stat-rail"
import { GCP_ACCENT } from "./catalog"
import type { LogVolume } from "./gcp-schema"
import { Message } from "./message"
import type { Model } from "./model"

// `GcpUsageBand`, its tiles, `Workloads` and `Resources`.

type H = HtmlBuilder<Message>

/** A tile's read: null while it loads, "failed" when it failed. */
type Loaded<A> = A | null | "failed"

const loaded = <A, B>(slot: Keyed<A, LoadFailure>, read: (value: A) => B): Loaded<B> =>
	AsyncData.isSuccess(slot.data) || AsyncData.isRefreshing(slot.data)
		? read(slot.data.data)
		: AsyncData.isFailure(slot.data) || AsyncData.isStale(slot.data)
			? "failed"
			: null

export const fleetOf = (model: Model): Loaded<ReadonlyArray<GcpFleetService>> =>
	loaded(model.gcpCard.fleet, (services) => gcpFleet(services))

interface Inventory {
	readonly total: number
	readonly types: GcpResourcesResponse["types"]
	readonly projects: number
}

export const inventoryOf = (model: Model): Loaded<Inventory> =>
	loaded(model.gcpCard.inventory, (response) => ({
		total: response.types.reduce((sum, { count }) => sum + count, 0),
		types: response.types,
		projects: response.projects.length,
	}))

const volumeOf = (model: Model): Loaded<LogVolume> => loaded(model.gcpCard.logVolume, (volume) => volume)

/** `Tile`: a number and a line, or what stands in while its read is out or failed. */
const tile = <A>(
	h: H,
	options: Readonly<{
		eyebrow: string
		read: Loaded<A>
		value: (read: A) => number | null
		caption: (read: A) => string
		spark?: (read: A) => ReadonlyArray<number>
		className?: string
	}>,
): Html => {
	if (options.read === null) return statRailItemSkeleton(h, options.className)
	const read = options.read
	const failed = read === "failed"
	const count = failed ? null : options.value(read)
	return statRailItem(h, {
		compact: options.spark === undefined,
		className: options.className,
		eyebrow: options.eyebrow,
		value: count === null ? "–" : formatNumber(count),
		spark: failed || options.spark === undefined ? undefined : options.spark(read),
		sparkColor: GCP_ACCENT,
		subline: h.span(
			[h.Class("block whitespace-normal")],
			[failed ? "Not available right now" : options.caption(read)],
		),
	})
}

const ROW_END = "border-r-0 @2xl/page:border-r"
const LAST_ROW = "border-b-0"
const FIRST_OF_THREE = "col-span-2 border-r-0 @md/page:col-span-1 @md/page:border-r"

export const gcpTitles = (services: ReadonlyArray<{ readonly service: GcpInfraServiceId }>) =>
	services.map(({ service }) => GCP_INFRA_SERVICES[service].title).join(", ")

export const logTiles = (h: H, model: Model, alone: boolean): ReadonlyArray<Html> => {
	const volume = volumeOf(model)
	return [
		tile(h, {
			eyebrow: "Log entries · 24h",
			read: volume,
			className: alone ? FIRST_OF_THREE : undefined,
			value: ({ total }) => total,
			spark: ({ hourly }) => hourly,
			caption: ({ total, hourly }) =>
				`About ${formatNumber(Math.round(total / hourly.length))} an hour`,
		}),
		tile(h, {
			eyebrow: "Errors · 24h",
			read: volume,
			className: alone ? LAST_ROW : ROW_END,
			value: ({ errors }) => errors,
			caption: () => "Severity error and above",
		}),
		...(alone
			? [
					tile(h, {
						eyebrow: "Warnings · 24h",
						read: volume,
						value: ({ warnings }) => warnings,
						caption: () => "Severity warning",
					}),
				]
			: []),
	]
}

export const metricsTiles = (h: H, model: Model, alone: boolean): ReadonlyArray<Html> => {
	const fleet = fleetOf(model)
	const inventory = inventoryOf(model)
	return [
		tile(h, {
			eyebrow: "Workloads · 24h",
			read: fleet,
			className: alone ? FIRST_OF_THREE : LAST_ROW,
			value: (services) =>
				services.length > 0 && services.every(({ failed }) => failed)
					? null
					: services.reduce((sum, { workloads }) => sum + workloads.length, 0),
			caption: (services) => {
				const unread = services.filter(({ failed }) => failed)
				if (unread.length > 0) return `${gcpTitles(unread)} could not be read`
				const reporting = gcpWorkloadCounts(services).length
				return reporting === 0
					? "No metrics in 24 hours"
					: `In ${countLabel(reporting, "Google Cloud service")}`
			},
		}),
		tile(h, {
			eyebrow: "Resources",
			read: inventory,
			className: alone ? LAST_ROW : undefined,
			value: ({ total }) => (total === 0 ? null : total),
			caption: ({ total, projects, types }) =>
				total === 0
					? "Listed within an hour of setup"
					: alone
						? `Of ${countLabel(types.length, "type")}`
						: `In ${countLabel(projects, "project")}`,
		}),
		...(alone
			? [
					tile(h, {
						eyebrow: "Projects",
						read: inventory,
						value: ({ total, projects }) => (total === 0 ? null : projects),
						caption: ({ total }) =>
							total === 0 ? "Listed within an hour of setup" : "With a listed resource",
					}),
				]
			: []),
	]
}
