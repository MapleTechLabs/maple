import { Effect, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import { WarehouseExecutor, type SqlQueryOptions } from "@maple/query-engine/observability"
import { WarehouseConfigError } from "@maple/domain/http/warehouse-errors"
import type { WarehouseQueryName } from "@maple/domain/warehouse-queries"
import { Mode, ModeError } from "./mode"
import { LOCAL_ORG_ID, makeLocalWarehouseExecutorApi } from "./executor"

/**
 * Provides `WarehouseExecutor` whose concrete backend (local chDB vs remote
 * warehouse) is resolved lazily, on first query, NOT at layer-build time.
 *
 * This matters because `Command.run`'s requirement union includes
 * WarehouseExecutor even for commands that never query (login/logout/whoami).
 * Resolving the mode eagerly at build time would make those commands fail when
 * no backend is configured. Deferring resolution into the methods keeps the
 * layer always-constructible, while `Effect.cached` resolves the mode at most
 * once per process.
 *
 * `orgId` is the local tenant: remote mode never reaches this executor, and
 * query-engine helpers that compile their own queries (the trace-time probe in
 * `inspectTrace`) scope them by `executor.orgId`.
 */
export const WarehouseExecutorFromMode = Layer.effect(
	WarehouseExecutor,
	Effect.gen(function* () {
		const mode = yield* Mode
		// Captured at layer build so the executor's methods stay requirement-free:
		// the local driver runs on the CLI's one HttpClient.
		const http = yield* HttpClient.HttpClient
		const getExecutor = yield* Effect.cached(
			mode.resolve.pipe(
				Effect.flatMap((m) =>
					m._tag === "local"
						? makeLocalWarehouseExecutorApi(m.baseUrl).pipe(
								Effect.provideService(HttpClient.HttpClient, http),
							)
						: // Remote mode never reaches the executor: `operations.ts`
							// dispatches to the v2 client before asking for one. Anything
							// that lands here is an operation that forgot to branch, so
							// fail loudly rather than silently querying the local store.
							Effect.fail(
								new ModeError({
									message:
										"Remote mode does not use the warehouse executor; this operation is missing its v2 dispatch.",
								}),
							),
				),
				// `WarehouseExecutor`'s error channel is the domain warehouse union, so
				// a mode failure has to travel as one. It rides in `cause` rather than
				// being flattened into the message: `lib/failure.ts` finds the
				// `ModeError` in the cause chain and reports it with its hint.
				Effect.mapError(
					(cause) => new WarehouseConfigError({ message: cause.message, pipeName: "mode", cause }),
				),
			),
		)
		return WarehouseExecutor.of({
			orgId: LOCAL_ORG_ID,
			query: <T>(pipe: string, params: Record<string, unknown>, options?: SqlQueryOptions) =>
				getExecutor.pipe(
					Effect.flatMap((executor) =>
						executor.query<T>(pipe as WarehouseQueryName, params, options),
					),
				),
			compiledQuery: (compiled, options?: SqlQueryOptions) =>
				getExecutor.pipe(Effect.flatMap((executor) => executor.compiledQuery(compiled, options))),
			compiledQueryFirst: (compiled, options?: SqlQueryOptions) =>
				getExecutor.pipe(
					Effect.flatMap((executor) => executor.compiledQueryFirst(compiled, options)),
				),
		})
	}),
)
