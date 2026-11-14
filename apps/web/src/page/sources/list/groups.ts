import type { V2Source } from "@maple/domain/http/v2"
import type { SourceId } from "@maple/primitives"
import { Array as Arr, Order, String as Str } from "effect"
import { platformMeta } from "../kit/platforms"
import { needsAttention, statusRank } from "../kit/status"
import type { VolumeTotals } from "../kit/volume"

// The list's three groups: what to fix, what is sending, and what is not.

type SourceGroups = Readonly<{
	/** Disconnected, failing or stale, worst first. */
	attention: ReadonlyArray<V2Source>
	/** Sending data, the most stored first once the volumes are in. */
	receiving: ReadonlyArray<V2Source>
	/** Paused or still waiting for its first data: on purpose or new. */
	idle: ReadonlyArray<V2Source>
}>

type SourceGroup = keyof SourceGroups

/** An idle Default source is no fault: the org's keys are simply unused. */
const groupOf = (source: V2Source): SourceGroup =>
	source.health.status === "healthy"
		? "receiving"
		: !source.is_default && needsAttention(source)
			? "attention"
			: "idle"

/** The line under a source's name: its platform, or what it collects when the name already says the platform. */
export const sourceKindLine = (source: V2Source): string => {
	if (source.is_default) return "Everything sent with an org ingest key"
	const meta = platformMeta(source.platform)
	return Str.toLowerCase(source.name) === Str.toLowerCase(meta.label) ? meta.description : meta.label
}

/** A source matches a search on its name or its platform. */
export const matchesSearch = (source: V2Source, search: string): boolean => {
	const query = Str.toLowerCase(Str.trim(search))
	return (
		query === "" ||
		Str.includes(query)(Str.toLowerCase(source.name)) ||
		Str.includes(query)(Str.toLowerCase(platformMeta(source.platform).label))
	)
}

const byWorstStatus = Order.mapInput(Order.Number, statusRank)

/** `usage` is `null` until the volumes load: the receiving group keeps the API's order (newest first). */
export const groupSources = (
	sources: ReadonlyArray<V2Source>,
	usage: ReadonlyMap<SourceId, VolumeTotals> | null,
): SourceGroups => {
	const of = (group: SourceGroup) => Arr.filter(sources, (source) => groupOf(source) === group)
	const byStored = Order.flip(
		Order.mapInput(Order.Number, (source: V2Source) => usage?.get(source.id)?.bytes ?? 0),
	)
	return {
		attention: Arr.sort(of("attention"), byWorstStatus),
		receiving: usage === null ? of("receiving") : Arr.sort(of("receiving"), byStored),
		idle: Arr.sort(of("idle"), byWorstStatus),
	}
}
