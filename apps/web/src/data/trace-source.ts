import { organizationFeatureFlagsFrom } from "@maple/domain/organization-feature-flags"
import { formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { type SpanProfile, type SpanProfileRequest, TraceSource } from "@maple/views/traces/trace-source"
import { listLogs } from "@maple/web-data/warehouse/logs"
import { getProfile } from "@maple/web-data/warehouse/profiles"
import { getSpanDetail } from "@maple/web-data/warehouse/traces"
import {
	MapleApiV2Http,
	MapleInternalHttp,
	WarehouseExecutor,
} from "@maple/web-data/warehouse/warehouse-services"
import { Context, Effect, Layer, Option, Array as Arr } from "effect"
import { isClerkAuthEnabled } from "../platform/auth-mode"

// The trace views' reads over the API: `getSpanDetail`, `listLogs` and the span's profile, on the
// warehouse services.

/** The profile's rows carry a slice's first sample time; a slow export can stamp it a little off. */
const PROFILE_PAD_MS = 60_000

/** Whether an org has the `profiling` rollout: self-hosted has every rollout, hosted reads Clerk. */
export const hasProfilingRollout = (isClerkAuth: boolean, publicMetadata: unknown): boolean =>
	!isClerkAuth || organizationFeatureFlagsFrom(publicMetadata).profiling

/** The org's `profiling` rollout flag, read on every call: this layer outlives an org switch. */
const readProfilingFlag: Effect.Effect<boolean> = Effect.sync(() =>
	hasProfilingRollout(isClerkAuthEnabled, window.Clerk?.organization?.publicMetadata),
)

/**
 * The stacks sampled while a span and its descendants ran: the sample types linked to them, then
 * the stacks of one. None when nothing is linked, and for an org outside the `profiling` rollout,
 * which sends no request.
 */
export const fetchSpanProfile = (
	request: SpanProfileRequest,
	isProfilingEnabled: Effect.Effect<boolean> = readProfilingFlag,
) =>
	Effect.gen(function* () {
		const startMs = parseWarehouseDateTime(request.startTime)
		if (!Number.isFinite(startMs) || request.spanIds.length === 0) return Option.none<SpanProfile>()
		if (!(yield* isProfilingEnabled)) return Option.none<SpanProfile>()
		const profile = yield* getProfile({
			data: {
				traceId: request.traceId,
				spanIds: request.spanIds,
				startTime: formatWarehouseDateTime(startMs - PROFILE_PAD_MS),
				endTime: formatWarehouseDateTime(startMs + Math.max(0, request.durationMs) + PROFILE_PAD_MS),
			},
		})
		return Option.map(profile, ({ sampleType, sampleUnit, totalValue, stacks }): SpanProfile => ({
			sampleType,
			sampleUnit,
			totalValue,
			stacks,
		}))
	})

export const TraceSourceLive = Layer.effect(
	TraceSource,
	Effect.gen(function* () {
		const executor = yield* WarehouseExecutor
		const internalHttp = yield* MapleInternalHttp
		const apiV2Http = yield* MapleApiV2Http
		const services = Context.make(WarehouseExecutor, executor).pipe(
			Context.add(MapleInternalHttp, internalHttp),
			Context.add(MapleApiV2Http, apiV2Http),
		)
		return TraceSource.of({
			spanDetail: ({ traceId, spanId, timestamp }) =>
				getSpanDetail({ data: { traceId, spanId, timestamp } }).pipe(
					// An unknown span reads as empty maps, as the panel always showed it.
					Effect.mapBoth({
						onSuccess: (detail) =>
							Option.some({
								spanAttributes: detail.spanAttributes,
								resourceAttributes: detail.resourceAttributes,
								events: detail.events,
							}),
						onFailure: toLoadFailure,
					}),
					Effect.provideContext(services),
				),
			spanLogs: ({ traceId, spanId, limit }) =>
				listLogs({ data: { traceId, spanId, limit } }).pipe(
					Effect.mapBoth({
						onSuccess: (response) =>
							Arr.map(response.data, (log, index) => ({
								key: `${index}:${log.timestamp}`,
								timestamp: log.timestamp,
								severityText: log.severityText,
								body: log.body,
							})),
						onFailure: toLoadFailure,
					}),
					Effect.provideContext(services),
				),
			spanProfile: (request) =>
				fetchSpanProfile(request).pipe(
					Effect.mapError(toLoadFailure),
					Effect.provideContext(services),
				),
		})
	}),
)
