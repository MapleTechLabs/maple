import { Clock, Effect, Schema, Array as Arr } from "effect"
import { formatWarehouseDateTime } from "@maple/query-engine"
import {
	DeploymentEnvironment,
	ReleasesListRequest,
	ServiceName,
	ServiceNamespace,
	type ReleaseRow,
} from "@maple/domain/http"
import { MapleInternalHttp } from "./warehouse-services"
import { toEnvFilter } from "./custom-charts"
import { toIsoBucket } from "./timeseries-utils"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "./effect-utils"

const dateTimeString = WarehouseDateTimeString

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

const defaultWindow = (nowMs: number) => ({
	startTime: formatWarehouseDateTime(nowMs - DEFAULT_WINDOW_MS),
	endTime: formatWarehouseDateTime(nowMs),
})

/** A release row with its warehouse datetime normalised to ISO. */
export interface Release extends Omit<ReleaseRow, "firstSeen"> {
	firstSeen: string
}

const toRelease = (row: ReleaseRow): Release => ({
	...row,
	firstSeen: toIsoBucket(row.firstSeen),
})

const GetReleasesInput = Schema.Struct({
	startTime: Schema.optional(dateTimeString),
	endTime: Schema.optional(dateTimeString),
	environments: Schema.optional(Schema.Array(DeploymentEnvironment)),
	namespaces: Schema.optional(Schema.Array(ServiceNamespace)),
	services: Schema.optional(Schema.Array(ServiceName)),
	excludedEnvironments: Schema.optional(Schema.Array(DeploymentEnvironment)),
})

export type GetReleasesInput = (typeof GetReleasesInput)["Encoded"]

export interface ReleasesResult {
	releases: Release[]
	truncated: boolean
	/** The window the rows describe, ISO. */
	startTime: string
	endTime: string
}

export function getReleases({ data }: { data: GetReleasesInput }) {
	return getReleasesEffect({ data })
}

const getReleasesEffect = Effect.fn("QueryEngine.getReleases")(function* ({
	data,
}: {
	data: GetReleasesInput
}) {
	const input = yield* decodeInput(GetReleasesInput, data ?? {}, "getReleases")
	const now = yield* Clock.currentTimeMillis
	const fallback = defaultWindow(now)
	const startTime = input.startTime ?? fallback.startTime
	const endTime = input.endTime ?? fallback.endTime

	const result = yield* runWarehouseQuery("releasesList", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.releasesList({
				payload: new ReleasesListRequest({
					startTime,
					endTime,
					environments: toEnvFilter(input.environments),
					namespaces: input.namespaces,
					services: input.services,
					excludedEnvironments: toEnvFilter(input.excludedEnvironments),
				}),
			})
		}),
	)

	return {
		releases: Arr.map(result.releases, toRelease),
		truncated: result.truncated,
		startTime: toIsoBucket(startTime),
		endTime: toIsoBucket(endTime),
	} satisfies ReleasesResult
})
