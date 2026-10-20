import { Option, Result, Schema } from "effect"
import { AsyncData, type Command } from "foldkit"
import * as Keyed from "../../../data/keyed"
import type { Resources } from "../../../platform/resources"

// `Keyed.request` steps shared by the Code Review pages (S6): two slots that may read the same
// request (the page's own and the filters' list) send it once, and its answer fills both.

export type Step<Patch, M> = Readonly<{
	patch: Partial<Patch>
	commands: ReadonlyArray<Command.Command<M, never, Resources>>
	keys: ReadonlyArray<string>
}>

export const keyedStep = <Patch, M, A, E>(
	slot: Keyed.Keyed<A, E>,
	key: string,
	mode: Keyed.RequestMode,
	write: (next: Keyed.Keyed<A, E>) => Partial<Patch>,
	fetch: (key: string) => Command.Command<M, never, Resources>,
): Step<Patch, M> =>
	Option.match(Keyed.request(slot, key, mode), {
		onNone: () => ({ patch: {}, commands: [], keys: [] }),
		onSome: (next) => ({ patch: write(next), commands: [fetch(key)], keys: [key] }),
	})

/** `DEFAULT_QUERY_TTL`: a retained answer serves a revisit of its key for a minute. */
export const CACHE_TTL_MS = 60_000

/** Answers by request key and when they were last used, kept across tabs. */
export const ResponseCache = <S extends Schema.Top>(value: S) =>
	Schema.Record(Schema.String, Schema.Struct({ value, usedAtMs: Schema.Number }))
export type ResponseCache<A> = Readonly<Record<string, Readonly<{ value: A; usedAtMs: number }>>>

/** A fresh cached answer fills the slot without a request; otherwise `keyedStep`. */
export const cachedStep = <Patch, M, A, E>(
	cache: ResponseCache<A>,
	nowMs: number,
	slot: Keyed.Keyed<A, E>,
	key: string,
	mode: Keyed.RequestMode,
	write: (next: Keyed.Keyed<A, E>) => Partial<Patch>,
	fetch: (key: string) => Command.Command<M, never, Resources>,
): Step<Patch, M> => {
	const hit = cache[key]
	return mode === "Load" && slot.key !== key && hit !== undefined && nowMs - hit.usedAtMs <= CACHE_TTL_MS
		? { patch: write({ key, data: AsyncData.Success({ data: hit.value }) }), commands: [], keys: [key] }
		: keyedStep(slot, key, mode, write, fetch)
}

/** Records an answer (and refreshes the use time of the keys on screen). */
export const remember = <A>(
	cache: ResponseCache<A>,
	nowMs: number,
	key: string,
	result: Result.Result<A, unknown>,
): ResponseCache<A> =>
	Result.isSuccess(result) ? { ...cache, [key]: { value: result.success, usedAtMs: nowMs } } : cache

/** Merges steps; a key already being fetched by an earlier step is not sent again. */
export const mergeSteps = <Patch, M>(steps: ReadonlyArray<Step<Patch, M>>): Step<Patch, M> =>
	steps.reduce<Step<Patch, M>>(
		(acc, step) => {
			const isDuplicate = step.keys.length > 0 && step.keys.every((key) => acc.keys.includes(key))
			return {
				patch: { ...acc.patch, ...step.patch },
				commands: isDuplicate ? acc.commands : [...acc.commands, ...step.commands],
				keys: [...acc.keys, ...step.keys],
			}
		},
		{ patch: {}, commands: [], keys: [] },
	)
