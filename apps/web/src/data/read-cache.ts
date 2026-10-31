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
 * The app's read cache (s6-data.md "Read cache"): reads shared across pages.
 * One entry per request key; in-flight reads are joined, a settled one is served until its idle TTL
 * runs out, counted from its last read or its holder's release (a page leaving, a preload's hold).
 */

/** `withRetention`'s bound: past it, idle-expired entries go first, then the least recently read. */
export const READ_CACHE_MAX_ENTRIES = 400

/** One read: its request key, its idle TTL, and the schema a cached value must pass. */
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
	isSettled: boolean
}>

/** Map order is recency: a touched entry is re-inserted at the end. */
type Entries = ReadonlyMap<RequestKey, Entry>

const touched = (entries: Map<RequestKey, Entry>, key: RequestKey, entry: Entry): void => {
	entries.delete(key)
	entries.set(key, entry)
}

/** A settled entry idle past its TTL; an in-flight one never is. */
const isExpired = (entry: Entry, nowMs: number) => entry.isSettled && nowMs - entry.touchedAtMs > entry.idleTtlMs

/**
 * Past the bound, only the excess goes: idle-expired entries first, then the least recently read,
 * in-flight reads last. Expired entries below the bound stay: a page still holding one revives it on release.
 */
const capped = (entries: Map<RequestKey, Entry>, nowMs: number): Map<RequestKey, Entry> => {
	const excess = entries.size - READ_CACHE_MAX_ENTRIES
	if (excess <= 0) return entries
	const rank = (entry: Entry) => (isExpired(entry, nowMs) ? 0 : entry.isSettled ? 1 : 2)
	// `sort` is stable, so within a rank the least recently read comes first.
	const evicted = new Set(
		[...entries]
			.sort(([, a], [, b]) => rank(a) - rank(b))
			.slice(0, excess)
			.map(([key]) => key),
	)
	return new Map([...entries].filter(([key]) => !evicted.has(key)))
}

/** Another org's entries are dropped on the first read for a new org (an org switch). */
const ofOrg = (entries: Entries, org: string): Map<RequestKey, Entry> =>
	new Map([...entries].filter(([key]) => orgOfKey(key) === org))

type EntriesRef = SynchronizedRef.SynchronizedRef<Entries>
type Answer = Deferred.Deferred<unknown, unknown>

/** A load finished: a success stays (its TTL counts from now), a failure is not kept. */
const settle = (entries: EntriesRef, key: RequestKey, result: Answer, exit: Exit.Exit<unknown, unknown>) =>
	Effect.flatMap(Clock.currentTimeMillis, (nowMs) =>
		SynchronizedRef.update(entries, (current) => {
			const entry = current.get(key)
			if (entry === undefined || entry.result !== result) return current
			const next = new Map(current)
			if (Exit.isSuccess(exit)) touched(next, key, { ...entry, touchedAtMs: nowMs, isSettled: true })
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
					if (existing !== undefined && spec.refresh !== true && !isExpired(existing, nowMs)) {
						touched(next, spec.key, { ...existing, touchedAtMs: nowMs })
						return step<S["Type"], E>({ _tag: "Joiner", result: existing.result }, next)
					}
					const result = yield* Deferred.make<unknown, unknown>()
					// Forked in the cache's scope, so the read outlives the reader that started it.
					const fiber = yield* Effect.forkIn(
						Effect.onExit(load, (exit) => settle(entries, spec.key, result, exit)),
						scope,
					)
					touched(next, spec.key, { result, idleTtlMs: spec.idleTtlMs, touchedAtMs: nowMs, isSettled: false })
					return step<S["Type"], E>({ _tag: "Owner", fiber }, capped(next, nowMs))
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
		SynchronizedRef.update(entries, (current) => {
			const next = new Map(current)
			keys.forEach((key) => {
				const entry = next.get(key)
				if (entry !== undefined) touched(next, key, { ...entry, touchedAtMs: nowMs })
			})
			return next
		}),
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
	/** The reader's own org, when it knows it: wins over the open org, which may not be set yet. */
	readonly orgId?: string
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
>()("@maple/web/ReadCache") {
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
						Option.match(spec.orgId === undefined ? orgId : Option.some(spec.orgId), {
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
