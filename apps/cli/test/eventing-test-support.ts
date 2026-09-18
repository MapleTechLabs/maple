import { Context, Effect, Exit, Metric, Scope } from "effect"
import type { ProjectorRegistry } from "@maple/eventing-core"
import {
	LocalEventingControlStore,
	openControlStore,
	type LocalEventingControlLimits,
	type LocalEventingControlStoreApi,
} from "../src/server/eventing/control-store"
import {
	LocalEventingProjectors,
	LocalEventingRuntime,
	type LocalEventingRuntimeApi,
} from "../src/server/eventing/runtime"

/** Runs a synchronous store or runtime step, throwing its typed failure like the old API did. */
export const run = <A, E>(effect: Effect.Effect<A, E>): A => Effect.runSync(effect)

export const runAsync = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

export interface OpenedStore extends LocalEventingControlStoreApi {
	/** Closes the store's scope: the WAL checkpoint and database close. */
	readonly close: () => Promise<void>
}

export const openStore = async (
	dataDir: string,
	limits?: LocalEventingControlLimits,
): Promise<OpenedStore> => {
	const scope = Effect.runSync(Scope.make())
	const store = await Effect.runPromise(
		openControlStore(dataDir, limits).pipe(
			Scope.provide(scope),
			Effect.onError(() => Scope.close(scope, Exit.void)),
		),
	)
	return { ...store, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) }
}

export const makeRuntime = (
	store: LocalEventingControlStoreApi,
	projectors?: ProjectorRegistry,
): LocalEventingRuntimeApi => {
	const make = LocalEventingRuntime.make.pipe(Effect.provideService(LocalEventingControlStore, store))
	return Effect.runSync(
		projectors === undefined
			? make
			: make.pipe(Effect.provideService(LocalEventingProjectors, projectors)),
	)
}

/** An isolated metric registry; `observe` runs an effect against it. */
export const metricRecorder = () => {
	const registry = new Map<string, Metric.Metric.Metadata<unknown, unknown>>()
	const context = Context.make(Metric.MetricRegistry, registry)
	return {
		observe: <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
			Effect.provideService(effect, Metric.MetricRegistry, registry),
		/** `operation:outcome` pairs of every eventing counter with a non-zero count. */
		operationOutcomes: (): string[] =>
			Metric.snapshotUnsafe(context).flatMap((snapshot) =>
				snapshot.id === "maple.eventing.operations_total" &&
				snapshot.type === "Counter" &&
				Number(snapshot.state.count) > 0
					? [`${snapshot.attributes?.operation}:${snapshot.attributes?.outcome}`]
					: [],
			),
		attributes: (): string =>
			JSON.stringify(Metric.snapshotUnsafe(context).map(({ attributes }) => attributes)),
	}
}

/** Runs a serve.ts request effect against a runtime (real or a partial stub). */
export const serveWith = <A>(
	eventing: LocalEventingRuntimeApi,
	effect: Effect.Effect<A, never, LocalEventingRuntime>,
): Promise<A> => Effect.runPromise(Effect.provideService(effect, LocalEventingRuntime, eventing))

/** Runs the checkpoint backup handler against a control store (real or a stub). */
export const serveCheckpointWith = <A>(
	store: LocalEventingControlStoreApi,
	effect: Effect.Effect<A, never, LocalEventingControlStore>,
): Promise<A> => Effect.runPromise(Effect.provideService(effect, LocalEventingControlStore, store))
