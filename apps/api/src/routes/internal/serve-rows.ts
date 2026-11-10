import { CurrentTenant, type TenantContext } from "@maple/domain/http"
import { WireValue } from "@maple/domain/wire"
import type { QueryDefinition } from "@maple/query-engine/registry"
import { type DateTime, Effect, Schema } from "effect"

/** A row as JSON carries it: every `DateTime` becomes its ISO-8601 string. */
export type WireOf<T> = T extends DateTime.DateTime
	? string
	: T extends ReadonlyArray<infer E>
		? ReadonlyArray<WireOf<E>>
		: T extends object
			? { readonly [K in keyof T]: WireOf<T[K]> }
			: T

type DataResponse = Schema.Top & { readonly DecodingServices: never }

/** Compiles only when the rows' wire form decodes as the response's `data`. */
type Fits<Data, S extends DataResponse> = S["Encoded"] extends { readonly data: infer Wire }
	? [Data] extends [Wire]
		? S
		: { readonly "rows do not fit the response's data": Data }
	: { readonly "response has no data field": S["Encoded"] }

type Runner<E> = <Payload, Row>(
	definition: QueryDefinition<Payload, Row>,
	tenant: TenantContext,
	payload: Payload,
) => Effect.Effect<ReadonlyArray<Row>, E>

type FirstRunner<E> = <Payload, Row>(
	definition: QueryDefinition<Payload, Row>,
	tenant: TenantContext,
	payload: Payload,
) => Effect.Effect<Row | null, E>

/** A rollup read that falls back to its raw twin, as `makeRollupFallback` builds. */
type Fallback<E> = <A, P>(
	rollup: (tenant: TenantContext, payload: P) => Effect.Effect<A, E>,
	raw: (tenant: TenantContext, payload: P) => Effect.Effect<A, E>,
	tenant: TenantContext,
	payload: P,
) => Effect.Effect<A, E>

const encodeWire = Schema.encodeSync(WireValue)

/**
 * A handler that answers with `read`'s result as the response's `data`: the response schema
 * decodes the result's wire form, so brands are checked and `DateTime`s written as ISO strings
 * with no per-endpoint mapping.
 */
export const serveData = <Payload, Data, S extends DataResponse, Err>(
	read: (tenant: TenantContext, payload: Payload) => Effect.Effect<Data, Err>,
	Response: NoInfer<Fits<WireOf<Data>, S>> & S,
) => {
	const decode = Schema.decodeUnknownEffect<S>(Response)
	return ({ payload }: { readonly payload: Payload }) =>
		Effect.gen(function* () {
			const tenant = yield* CurrentTenant.Context
			const data = yield* read(tenant, payload)
			return yield* Effect.orDie(decode({ data: encodeWire(data) }))
		})
}

/** Handlers for endpoints that are one registry query and nothing else. */
export const makeServeRows = <E, EF>(runQuery: Runner<E>, runQueryFirst: FirstRunner<EF>) => ({
	/** `data` is every row. */
	rows: <Payload, Row, S extends DataResponse>(
		definition: QueryDefinition<Payload, Row>,
		Response: Fits<ReadonlyArray<WireOf<Row>>, S> & S,
	) =>
		serveData<Payload, ReadonlyArray<Row>, S, E>(
			(tenant, payload) => runQuery(definition, tenant, payload),
			Response,
		),
	/** `data` is the first row, or `null` when there is none. */
	first: <Payload, Row, S extends DataResponse>(
		definition: QueryDefinition<Payload, Row>,
		Response: Fits<WireOf<Row> | null, S> & S,
	) =>
		serveData<Payload, Row | null, S, EF>(
			(tenant, payload) => runQueryFirst(definition, tenant, payload),
			Response,
		),
	/** `rows` from a rollup definition, or from `raw` where `fallback` finds the rollup missing. */
	fallbackRows: <Payload, Row, S extends DataResponse>(
		fallback: Fallback<E>,
		definition: QueryDefinition<Payload, Row>,
		raw: QueryDefinition<Payload, Row>,
		Response: Fits<ReadonlyArray<WireOf<Row>>, S> & S,
	) =>
		serveData<Payload, ReadonlyArray<Row>, S, E>(
			(tenant, payload) =>
				fallback(
					(t, p: Payload) => runQuery(definition, t, p),
					(t, p: Payload) => runQuery(raw, t, p),
					tenant,
					payload,
				),
			Response,
		),
	/** `rows`, after `check` accepts the payload; its failure is the response. */
	checkedRows: <Payload, Row, S extends DataResponse, CE>(
		check: (payload: Payload) => Effect.Effect<unknown, CE>,
		definition: QueryDefinition<Payload, Row>,
		Response: Fits<ReadonlyArray<WireOf<Row>>, S> & S,
	) =>
		serveData<Payload, ReadonlyArray<Row>, S, E | CE>(
			(tenant, payload) => Effect.andThen(check(payload), runQuery(definition, tenant, payload)),
			Response,
		),
})
