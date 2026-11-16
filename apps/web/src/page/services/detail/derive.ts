import {
	alignServiceApiBucketSeconds,
	formatWarehouseDateTime,
	parseWarehouseDateTime,
} from "@maple/query-engine"
import { Option, Schema, Array as Arr } from "effect"
import type { TimeWindow } from "../../../data/time-range"
import type { PageContext } from "../../contract"
import type { ServiceSearch } from "../../../route/search"

// Pure halves of the route and the service panels: tab, environment scope, query inputs.

type Search = typeof ServiceSearch.Type

export const DEFAULT_PRESET = "12h"

/** The switcher's "no environment filter" option. */
export const ALL_ENVIRONMENTS = "all"

export const ServiceTab = Schema.Literals(["overview", "api", "operations", "dependencies", "profiles"])
export type ServiceTab = typeof ServiceTab.Type
const decodeTab = Schema.decodeUnknownOption(ServiceTab)

export const SERVICE_TABS: ReadonlyArray<{ readonly value: ServiceTab; readonly label: string }> = [
	{ value: "overview", label: "Overview" },
	{ value: "api", label: "API" },
	{ value: "operations", label: "Operations" },
	{ value: "dependencies", label: "Dependencies" },
	{ value: "profiles", label: "Profiles" },
]

type Rollouts = Pick<PageContext, "hasProfiling">

/** The tabs the org is shown: Profiles only inside the `profiling` rollout. */
export const serviceTabs = (context: Rollouts): ReadonlyArray<(typeof SERVICE_TABS)[number]> =>
	context.hasProfiling === true ? SERVICE_TABS : Arr.filter(SERVICE_TABS, (tab) => tab.value !== "profiles")

/**
 * An unknown `?tab=` (a stale link) falls back to Overview, and so does Profiles outside the
 * `profiling` rollout, which is also what a caller without the context reads.
 */
export const tabOf = (search: Search, context: Rollouts = {}): ServiceTab => {
	const tab = Option.getOrElse(decodeTab(search.tab), (): ServiceTab => "overview")
	return tab === "profiles" && context.hasProfiling !== true ? "overview" : tab
}

/** `environments=[""]` from old links reads as "all"; `undefined` is every environment. */
export const environmentsOf = (search: Search): ReadonlyArray<string> | undefined => {
	const selected =
		search.environments === undefined ? undefined : Arr.filter(search.environments, (env) => env !== "")
	return selected !== undefined && selected.length > 0 ? selected : undefined
}

/** One selected environment, `"unknown"` as the raw empty value. */
export const singleDeploymentEnv = (environments: ReadonlyArray<string> | undefined): string | undefined =>
	environments?.length === 1 ? (environments[0] === "unknown" ? "" : environments[0]) : undefined

/** `windowSeconds` (service-operations.ts). */
export const windowSeconds = (window: TimeWindow): number => {
	const start = parseWarehouseDateTime(window.startTime)
	const end = parseWarehouseDateTime(window.endTime)
	return !Number.isFinite(start) || !Number.isFinite(end) ? 0 : Math.max(0, (end - start) / 1000)
}

const OPERATIONS_SPARKLINE_BUCKETS = 50
export const OPERATIONS_LIMIT = 25

/** `operationsBucketSeconds`: about 50 whole-minute buckets, at least one minute. */
export const operationsBucketSeconds = (window: TimeWindow): number =>
	Math.max(1, Math.round(windowSeconds(window) / OPERATIONS_SPARKLINE_BUCKETS / 60)) * 60

/** The API tab's charts and sparklines: the operations bucket, aligned to what the rollups tile. */
export const apiBucketSeconds = (window: TimeWindow): number =>
	alignServiceApiBucketSeconds(operationsBucketSeconds(window))

export const callsPerSecond = (estimatedSpanCount: number, seconds: number): number =>
	seconds <= 0 ? 0 : estimatedSpanCount / seconds

/** The equally long window ending where this one starts. */
export const previousWindow = (
	window: TimeWindow,
): { previousStartTime: string; previousEndTime: string } | undefined => {
	const start = parseWarehouseDateTime(window.startTime)
	const end = parseWarehouseDateTime(window.endTime)
	if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return undefined
	return {
		previousStartTime: formatWarehouseDateTime(start - (end - start)),
		previousEndTime: formatWarehouseDateTime(start),
	}
}

/** The open-issues window is capped at 90 days. */
export const ISSUES_DETAIL_LIMIT_MS = 90 * 24 * 60 * 60 * 1000
