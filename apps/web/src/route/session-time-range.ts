import { resolveRelativeRangeToWarehouse } from "@maple/query-engine"
import { normalizeTimestampInput } from "@maple/web-data/lib/timezone-format"
import { DateTime, Option, Predicate, Schema } from "effect"
import type { AppRoute, RouteTag } from "./app-route"

// The session time range middleware: a navigation that names no
// window gets the one last chosen in this tab, when it fits the page's ceiling.

/** `SessionTimeRangeSchema`: what the tab remembers, per org. */
export const SessionTimeRange = Schema.Struct({
	startTime: Schema.optionalKey(Schema.String),
	endTime: Schema.optionalKey(Schema.String),
	timePreset: Schema.optionalKey(Schema.String),
})
export type SessionTimeRange = typeof SessionTimeRange.Type

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60
/** `DEFAULT_MAX_RANGE_SECONDS`: the widest standard preset, a calendar month. */
const DEFAULT_MAX_RANGE_SECONDS = 32 * 24 * 60 * 60

/** The routes that carry the middleware, with the ceiling they pass it. */
const CEILINGS: ReadonlyMap<RouteTag, number> = new Map<RouteTag, number>([
	...(["Services", "Service", "ServiceMap", "Releases", "Release", "AlertRule"] as const).map(
		(tag) => [tag, ONE_YEAR_SECONDS] as const,
	),
	...(
		[
			"Home",
			"Metric",
			"Metrics",
			"Traces",
			"Logs",
			"Replays",
			"Analytics",
			"ErrorIssue",
			"AgentSessionTool",
			"AgentSessionTools",
			"Infra",
			"InfraCloudflare",
			"InfraCloudflareZone",
			"InfraCloudflareWorker",
			"InfraRailway",
			"InfraRailwayService",
			"InfraSupabase",
			"InfraSupabaseProject",
			"InfraGcp",
			"InfraGcpResource",
			"InfraPlanetscale",
			"InfraPlanetscaleDatabase",
			"InfraContainers",
			"InfraContainer",
			"InfraHosts",
			"InfraHost",
			"InfraKubernetes",
			"InfraKubernetesNodes",
			"InfraKubernetesNode",
			"InfraKubernetesWorkloads",
			"InfraKubernetesWorkload",
			"InfraKubernetesPods",
			"InfraKubernetesPod",
			"InfraKubernetesServices",
			"InfraKubernetesService",
		] as const
	).map((tag) => [tag, DEFAULT_MAX_RANGE_SECONDS] as const),
])

const searchOf = (route: AppRoute): Option.Option<Readonly<Record<string, unknown>>> =>
	Predicate.hasProperty(route, "search") && Predicate.isReadonlyObject(route.search)
		? Option.some(route.search)
		: Option.none()

const isSet = (value: unknown): value is string => typeof value === "string" && value !== ""

/** `namesTimeRange`: the search names a window, or part of one. */
const namesTimeRange = (search: Readonly<Record<string, unknown>>): boolean =>
	isSet(search["timePreset"]) || isSet(search["startTime"]) || isSet(search["endTime"])

/** `isCompleteTimeRange`: a preset, or both absolute bounds. Only these are remembered. */
export const completeRangeOf = (route: AppRoute): Option.Option<SessionTimeRange> =>
	Option.flatMap(searchOf(route), (search) => {
		const { timePreset, startTime, endTime } = search
		if (isSet(timePreset)) return Option.some({ timePreset })
		return isSet(startTime) && isSet(endTime) ? Option.some({ startTime, endTime }) : Option.none()
	})

const epochOf = (value: string): Option.Option<number> =>
	Option.map(DateTime.make(normalizeTimestampInput(value)), DateTime.toEpochMillis)

/** `isTimeRangeWithin`, a preset resolved against the clock first (`relativeToAbsolute`). */
export const isWithin = (
	stored: SessionTimeRange,
	maxSeconds: number,
	nowMs: number,
	timeZone: string,
): boolean => {
	const range =
		stored.timePreset !== undefined
			? Option.fromNullishOr(resolveRelativeRangeToWarehouse(stored.timePreset, nowMs, timeZone))
			: stored.startTime !== undefined && stored.endTime !== undefined
				? Option.some({ startTime: stored.startTime, endTime: stored.endTime })
				: Option.none()
	return Option.exists(range, ({ startTime, endTime }) =>
		Option.exists(Option.all([epochOf(startTime), epochOf(endTime)]), ([start, end]) => {
			const seconds = (end - start) / 1000
			return Number.isFinite(seconds) && seconds >= 0 && seconds <= maxSeconds
		}),
	)
}

/** A remembered value is complete: a preset, or both bounds. */
export const isComplete = (stored: SessionTimeRange): boolean =>
	isSet(stored.timePreset) || (isSet(stored.startTime) && isSet(stored.endTime))

/**
 * The middleware: the URL to land on instead of `url`, carrying the remembered window, when
 * the route names none and the window fits its ceiling. `{ ...result, ...stored }`: appended last.
 */
export const withSessionRange = (
	route: AppRoute,
	url: string,
	stored: SessionTimeRange,
	nowMs: number,
	timeZone: string,
): Option.Option<string> => {
	const ceiling = CEILINGS.get(route._tag)
	if (ceiling === undefined || !isComplete(stored)) return Option.none()
	return Option.flatMap(searchOf(route), (search) => {
		if (namesTimeRange(search) || !isWithin(stored, ceiling, nowMs, timeZone)) return Option.none()
		const [path = "", query = ""] = url.split("?")
		const params = new URLSearchParams(query)
		for (const key of ["startTime", "endTime", "timePreset"] as const) {
			const value = stored[key]
			if (value !== undefined) params.set(key, value)
		}
		return Option.some(`${path}?${params.toString()}`)
	})
}
