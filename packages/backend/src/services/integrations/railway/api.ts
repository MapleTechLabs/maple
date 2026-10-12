/**
 * Lazy facade over {@link Impl}, which owns the `@distilled.cloud/railway` GraphQL SDK. Only the
 * Railway connect and poll flows touch it, so it loads on first call instead of with every request
 * graph. Exports mirror the impl; the `typeof Impl.*` annotations make a drifted signature a type error.
 */
import { Effect } from "effect"
import type * as Impl from "./api-impl"

export { RailwayApiError } from "./errors"
export type {
	RailwayDiscoveredEnvironment,
	RailwayDiscovery,
	RailwayMeasurement,
	RailwayMetricsResult,
	RailwayMetricsWindow,
} from "./api-impl"

const impl = Effect.promise(() => import("./api-impl"))

export const discover: typeof Impl.discover = (...args) => Effect.flatMap(impl, (m) => m.discover(...args))

export const fetchEnvironmentMetrics: typeof Impl.fetchEnvironmentMetrics = (...args) =>
	Effect.flatMap(impl, (m) => m.fetchEnvironmentMetrics(...args))
