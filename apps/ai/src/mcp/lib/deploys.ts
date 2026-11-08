import { Array as Arr, Clock, DateTime, Effect, Option, Order, String as Str } from "effect"
import { CH } from "@maple/query-engine"
import { WarehouseExecutor } from "@maple/query-engine/observability"
import { parseWarehouseDateTime, warehouseDateTime, type WarehouseDateTime } from "@maple/query-engine"
import { McpInvalidInputError, McpNotReadyError } from "../tools/types"
import { warehouseToMcpHandlers } from "./map-warehouse-error"
import { withTenantExecutor } from "./query-warehouse"

const HOUR_MS = 3_600_000
const DEPLOY_LOOKBACK_MS = 14 * 24 * HOUR_MS
/** A version first seen this close to the lookback start was already running before it. */
const LOOKBACK_EDGE_MS = HOUR_MS
/** How long after a deploy before its after window holds enough to compare. */
const MIN_AFTER_MS = 60_000

const newestFirst = Order.flip(
	Order.mapInput(DateTime.Order, (row: { readonly firstSeen: DateTime.Utc }) => row.firstSeen),
)

/**
 * A service's deployed versions (distinct commit SHAs per environment), newest first by the
 * time each version's first span arrived. The source for every "since the deploy" tool.
 */
export const serviceDeploysNewestFirst = (
	tool: string,
	context: string,
	service: string,
	environment: string | undefined,
	startTime: string,
	endTime: string,
) =>
	withTenantExecutor(
		Effect.gen(function* () {
			const executor = yield* WarehouseExecutor
			const rows = yield* executor.compiledQuery(
				CH.compile(
					CH.serviceDeploymentsQuery({
						serviceName: service,
						environments: environment === undefined ? undefined : [environment],
						minutePrecision: false,
						limit: 100,
					}),
					{ orgId: executor.orgId, startTime, endTime },
					{ rowSchema: CH.serviceDeploymentsRowSchema },
				),
				{ profile: "aggregation", context },
			)
			return Arr.sort(rows, newestFirst)
		}),
	).pipe(Effect.catchTags(warehouseToMcpHandlers(tool)))

export interface Period {
	readonly st: WarehouseDateTime
	readonly et: WarehouseDateTime
}

export interface DeployWindows {
	readonly previous: Period
	readonly current: Period
	readonly deploy: {
		readonly service: string
		readonly environment: string
		readonly commitSha: string
		readonly firstSeen: WarehouseDateTime
	}
}

/**
 * The hour after `service`'s newest deploy (up to now) and the same length before it. The
 * deploy is the newest version's first span in the environment, given or the newest deploy's;
 * it needs a previous version there, or it is only the oldest version still running.
 */
export const deployWindows = Effect.fn("McpTool.deployWindows")(function* (
	tool: string,
	service: string,
	environment: string | undefined,
) {
	const now = yield* Clock.currentTimeMillis
	const lookbackStart = now - DEPLOY_LOOKBACK_MS
	const deploys = yield* serviceDeploysNewestFirst(
		tool,
		`${tool}.deploys`,
		service,
		environment,
		warehouseDateTime(lookbackStart),
		warehouseDateTime(now),
	)
	// Without an environment, the newest one that has a previous version to compare against.
	const hasPrevious = (env: string) => Arr.filter(deploys, (row) => row.environment === env).length >= 2
	const env =
		environment ??
		Arr.findFirst(deploys, (row) => hasPrevious(row.environment)).pipe(
			Option.map((row) => row.environment),
			Option.getOrUndefined,
		)
	const [newest, previous] = Arr.filter(deploys, (row) => row.environment === env)
	const boundaryMs = newest === undefined ? 0 : DateTime.toEpochMillis(newest.firstSeen)
	if (newest === undefined || previous === undefined || boundaryMs - lookbackStart < LOOKBACK_EDGE_MS) {
		return yield* new McpInvalidInputError({
			message: `${service} shows no deploy in the last 14 days${env === undefined ? "" : ` in ${env}`}: it needs two versions (vcs.ref.head.revision) with the newer one first seen inside that window. service_deployments lists the versions it reports; otherwise pass around_time with the deploy time.`,
			parameter: "service",
		})
	}
	if (now - boundaryMs < MIN_AFTER_MS) {
		return yield* new McpNotReadyError({
			message: `${service}'s newest deploy (${Str.slice(0, 7)(newest.commitSha)}) is under a minute old; its after window has nothing to compare yet.`,
			retryAfterSeconds: Math.ceil((MIN_AFTER_MS - (now - boundaryMs)) / 1000),
		})
	}
	const boundary = warehouseDateTime(boundaryMs)
	const currentEndMs = Math.min(now, boundaryMs + HOUR_MS)
	return {
		previous: { st: warehouseDateTime(2 * boundaryMs - currentEndMs), et: boundary },
		current: { st: boundary, et: warehouseDateTime(currentEndMs) },
		deploy: {
			service: newest.serviceName,
			environment: newest.environment,
			commitSha: newest.commitSha,
			firstSeen: boundary,
		},
	} satisfies DeployWindows
})

const HALF_WINDOW_MS = 30 * 60 * 1000

/**
 * Two periods to compare: the half hours either side of `around_time`, or the current period
 * (default the last hour) and the previous one (default the same length just before it).
 */
export const resolveComparisonWindows = (params: {
	readonly around_time?: WarehouseDateTime | undefined
	readonly current_start?: WarehouseDateTime | undefined
	readonly current_end?: WarehouseDateTime | undefined
	readonly previous_start?: WarehouseDateTime | undefined
	readonly previous_end?: WarehouseDateTime | undefined
}): Effect.Effect<{ readonly previous: Period; readonly current: Period }, McpInvalidInputError> =>
	Effect.gen(function* () {
		if (params.around_time !== undefined) {
			const center = parseWarehouseDateTime(params.around_time)
			return {
				previous: { st: warehouseDateTime(center - HALF_WINDOW_MS), et: params.around_time },
				current: { st: params.around_time, et: warehouseDateTime(center + HALF_WINDOW_MS) },
			}
		}
		const now = yield* Clock.currentTimeMillis
		const ce = params.current_end ?? warehouseDateTime(now)
		const cs = params.current_start ?? warehouseDateTime(parseWarehouseDateTime(ce) - HOUR_MS)
		if (parseWarehouseDateTime(cs) > parseWarehouseDateTime(ce)) {
			return yield* new McpInvalidInputError({
				message: `current_start (${cs}) is after current_end (${ce}).`,
				parameter: "current_start",
			})
		}
		const pe = params.previous_end ?? cs
		const ps =
			params.previous_start ??
			warehouseDateTime(
				parseWarehouseDateTime(pe) - (parseWarehouseDateTime(ce) - parseWarehouseDateTime(cs)),
			)
		if (parseWarehouseDateTime(ps) > parseWarehouseDateTime(pe)) {
			return yield* new McpInvalidInputError({
				message: `previous_start (${ps}) is after previous_end (${pe}).`,
				parameter: "previous_start",
			})
		}
		return { previous: { st: ps, et: pe }, current: { st: cs, et: ce } }
	})
