import {
	Clock,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Option,
	Ref,
	Schema,
	type Scope,
	SynchronizedRef,
} from "effect"
import { orgOfKey, type RequestKey, requestKey } from "./request-key"

/**
 * The app's read cache (s6-data.md "Read cache"): what apps/web's query atoms share across pages.
 * One entry per request key; in-flight reads are joined, a settled one is served until its idle TTL
 * runs out, counted from its last read or its holder's release (a page leaving, a preload's hold).
 */

/** `withRetention`'s LRU bound: the oldest entries go first past it. */
export const READ_CACHE_MAX_ENTRIES = 400

/** One read: its request key, the legacy family's idle TTL, and the schema a cached value must pass. */
export interface ReadSpec<S extends Schema.Top> {
	readonly key: RequestKey
	readonly idleTtlMs: number
	readonly schema: S
	/** `useAtomRefresh`: read again even when a live entry exists. */
	readonly refresh?: boolean
}

type Entry = Readonly<{
	result: Deferred.Deferred<unknown, unknown>
	idleTtlMs: number
	touchedAtMs: number
}>

type Entries = ReadonlyMap<RequestKey, Entry>

const capped = (entries: Map<RequestKey, Entry>): Map<RequestKey, Entry> =>
	entries.size <= READ_CACHE_MAX_ENTRIES
		? entries
		: new Map([...entries].slice(entries.size - READ_CACHE_MAX_ENTRIES))

/** Another org's entries are dropped on the first read for a new org (an org switch). */
const ofOrg = (entries: Entries, org: string): Map<RequestKey, Entry> =>
	new Map([...entries].filter(([key]) => orgOfKey(key) === org))

const isLive = (entry: Entry, nowMs: number) =>
	Effect.map(
		Deferred.isDone(entry.result),
		(isDone) => !isDone || nowMs - entry.touchedAtMs <= entry.idleTtlMs,
	)

type EntriesRef = SynchronizedRef.SynchronizedRef<Entries>
type Answer = Deferred.Deferred<unknown, unknown>

/** A load finished: a success stays (its TTL counts from now), a failure is not kept. */
const settle = (entries: EntriesRef, key: RequestKey, result: Answer, exit: Exit.Exit<unknown, unknown>) =>
	Effect.flatMap(Clock.currentTimeMillis, (nowMs) =>
		SynchronizedRef.update(entries, (current) => {
			const entry = current.get(key)
			if (entry === undefined || entry.result !== result) return current
			const next = new Map(current)
			if (Exit.isSuccess(exit)) next.set(key, { ...entry, touchedAtMs: nowMs })
			else next.delete(key)
			return next
		}),
	).pipe(Effect.andThen(Deferred.done(result, exit)))

type Outcome<A, E> =
	| { readonly _tag: "Owner"; readonly fiber: Fiber.Fiber<A, E> }
	| { readonly _tag: "Joiner"; readonly result: Answer }

const step = <A, E>(outcome: Outcome<A, E>, next: Entries): readonly [Outcome<A, E>, Entries] => [
	outcome,
	next,
]

const makeRead =
	(entries: EntriesRef, scope: Scope.Scope) =>
	<S extends Schema.Top, E, R>(spec: ReadSpec<S>, load: Effect.Effect<S["Type"], E, R>) =>
		Effect.flatMap(Clock.currentTimeMillis, (nowMs) =>
			SynchronizedRef.modifyEffect(entries, (current) =>
				Effect.gen(function* () {
					const next = ofOrg(current, orgOfKey(spec.key))
					const existing = next.get(spec.key)
					if (existing !== undefined && spec.refresh !== true && (yield* isLive(existing, nowMs))) {
						next.set(spec.key, { ...existing, touchedAtMs: nowMs })
						return step<S["Type"], E>({ _tag: "Joiner", result: existing.result }, next)
					}
					const result = yield* Deferred.make<unknown, unknown>()
					// Forked in the cache's scope, so the read outlives the reader that started it.
					const fiber = yield* Effect.forkIn(
						Effect.onExit(load, (exit) => settle(entries, spec.key, result, exit)),
						scope,
					)
					next.set(spec.key, { result, idleTtlMs: spec.idleTtlMs, touchedAtMs: nowMs })
					return step<S["Type"], E>({ _tag: "Owner", fiber }, capped(next))
				}),
			),
		).pipe(
			Effect.flatMap((outcome): Effect.Effect<S["Type"], unknown, R> =>
				outcome._tag === "Owner"
					? Fiber.join(outcome.fiber)
					: Effect.flatMap(Deferred.await(outcome.result), (value) =>
							Schema.is(spec.schema)(value) ? Effect.succeed(value) : load,
						),
			),
		)

const makeRelease = (entries: EntriesRef) => (keys: ReadonlyArray<RequestKey>) =>
	Effect.flatMap(Clock.currentTimeMillis, (nowMs) =>
		SynchronizedRef.update(
			entries,
			(current) =>
				new Map(
					[...current].map(([key, entry]) => [
						key,
						keys.includes(key) ? { ...entry, touchedAtMs: nowMs } : entry,
					]),
				),
		),
	)

/** `ReadCache.read` from a Command: `load` runs only when no live entry answers `spec.key`. */
export const readThrough = <S extends Schema.Top, E, R>(
	spec: ReadSpec<S>,
	load: Effect.Effect<S["Type"], E, R>,
) => Effect.flatMap(Effect.service(ReadCache), (cache) => cache.read(spec, load))

/** A read whose key is built under the open org (`scopeTo`), for readers that do not carry it. */
export interface OrgReadSpec<S extends Schema.Top> extends Omit<ReadSpec<S>, "key"> {
	readonly operation: string
	readonly input: unknown
}

export class ReadCache extends Context.Service<
	ReadCache,
	{
		readonly read: <S extends Schema.Top, E, R>(
			spec: ReadSpec<S>,
			load: Effect.Effect<S["Type"], E, R>,
		) => Effect.Effect<S["Type"], unknown, R>
		/** `read` under the open org's `requestKey`; before any org is open it only loads. */
		readonly readInOrg: <S extends Schema.Top, E, R>(
			spec: OrgReadSpec<S>,
			load: Effect.Effect<S["Type"], E, R>,
		) => Effect.Effect<S["Type"], unknown, R>
		/** The holder of these keys let go of them: their idle TTL starts now. */
		readonly release: (keys: ReadonlyArray<RequestKey>) => Effect.Effect<void>
		/** The open org: other orgs' entries are dropped (an org switch). */
		readonly scopeTo: (orgId: string) => Effect.Effect<void>
	}
>()("@maple/web-foldkit/ReadCache") {
	static readonly layer = Layer.effect(
		this,
		Effect.gen(function* () {
			const scope = yield* Effect.scope
			const entries = yield* SynchronizedRef.make<Entries>(new Map())
			const openOrg = yield* Ref.make(Option.none<string>())
			const read = makeRead(entries, scope)
			return {
				read,
				readInOrg: <S extends Schema.Top, E, R>(
					spec: OrgReadSpec<S>,
					load: Effect.Effect<S["Type"], E, R>,
				) =>
					Effect.flatMap(Ref.get(openOrg), (orgId) =>
						Option.match(orgId, {
							onNone: () => load,
							onSome: (org) =>
								read({ ...spec, key: requestKey(org, spec.operation, spec.input) }, load),
						}),
					),
				release: makeRelease(entries),
				scopeTo: (orgId: string) =>
					Effect.andThen(
						Ref.set(openOrg, Option.some(orgId)),
						SynchronizedRef.update(entries, (current) => ofOrg(current, orgId)),
					),
			}
		}),
	)
}
