import { Effect, Option, Schema } from "effect"
import { StatusCode } from "@maple/domain/http"
import { formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"
import type { ExecutionTenant } from "@maple/query-engine/execution"
import type { QueryDefinition } from "@maple/query-engine/registry"
import { runQueryDefinition, runQueryDefinitionFirst } from "@maple/query-engine/runtime"
import type { EndpointHandler } from "../../fixtures/dataset.ts"
import { parityOrgId, type FixtureWarehouse } from "../warehouse.ts"

/**
 * What a dedicated warehouse handler in `apps/api/src/routes/internal/query-engine.http.ts` reads:
 * the tenant, `runQuery`/`runQueryFirst` from `makeQueryRunners` (minus its cache), and the clock,
 * here the dataset's frozen `now`.
 */
export interface WarehouseContext {
	readonly tenant: ExecutionTenant
	readonly nowMs: number
	readonly warehouse: FixtureWarehouse
	// The warehouse error union stays a runtime value: the endpoint's declared errors encode it.
	readonly runQuery: <P, R>(
		def: QueryDefinition<P, R>,
		payload: P,
	) => Effect.Effect<ReadonlyArray<R>, unknown>
	readonly runQueryFirst: <P, R>(def: QueryDefinition<P, R>, payload: P) => Effect.Effect<R | null, unknown>
}

export class ParityEndpointPayloadError extends Schema.TaggedError<ParityEndpointPayloadError>()(
	"@maple/ui-parity/ParityEndpointPayloadError",
	{ message: Schema.String },
) {}

/**
 * One endpoint answered by `answer`, the handler body mirrored from the API. The response class is
 * encoded back to wire form because the fixture server decodes every answer with the success schema.
 */
export const warehouseEndpoint =
	<P, A, I>(
		warehouse: FixtureWarehouse,
		request: Schema.Codec<P, unknown>,
		response: Schema.Codec<A, I>,
		answer: (payload: P, context: WarehouseContext) => Effect.Effect<A, unknown>,
	): EndpointHandler =>
	({ dataset, payload }) =>
		Effect.gen(function* () {
			if (!Schema.is(request)(payload))
				return yield* new ParityEndpointPayloadError({
					message: "payload does not match the request schema",
				})
			const tenant = warehouse.tenantOf(parityOrgId(dataset.identity?.orgId ?? "org_parity_signed_out"))
			const executor = warehouse.executor
			const context: WarehouseContext = {
				tenant,
				nowMs: parseWarehouseDateTime(dataset.now),
				warehouse,
				runQuery: (def, input) => runQueryDefinition(executor, def, tenant, input),
				runQueryFirst: (def, input) =>
					runQueryDefinitionFirst(executor, def, tenant, input).pipe(Effect.map(Option.getOrNull)),
			}
			return yield* Schema.encodeUnknownEffect(response)(yield* answer(payload, context))
		})

/** `coerceStatusCode` in the API handler: unexpected values read as `Unset`. */
const decodeStatusCode = Schema.decodeUnknownOption(StatusCode)
export const coerceStatusCode = (value: string): StatusCode =>
	Option.getOrElse(decodeStatusCode(value), () => "Unset" as const)

/** `partitionWindowAround` from `@maple/backend/queries/query-helpers`: one hour either side. */
export const partitionWindowAround = (timestamp: string) => {
	const ms = parseWarehouseDateTime(timestamp)
	return {
		startTime: formatWarehouseDateTime(ms - 3_600_000),
		endTime: formatWarehouseDateTime(ms + 3_600_000),
	}
}
