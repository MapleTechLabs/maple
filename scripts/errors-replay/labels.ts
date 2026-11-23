/**
 * Ground truth for `errors:replay`: pairs of sampled variants labelled "same bug" or not.
 *
 * Issue count alone cannot say whether a grouping change is better, since fewer issues
 * may be false merges. Labelled pairs can: a grouping puts each pair together or apart,
 * and scoring that against the labels gives pairwise precision (grouped pairs that are
 * one bug) and recall (one-bug pairs that are grouped).
 *
 * Pairs are drawn where grouping decisions are made: variants one issue already holds
 * (does it hold one bug?) and variants of one service and type in different issues (should
 * they be one?). `--changed` draws the pairs a proposal decides differently, so a
 * proposal's new merges and splits are labelled before it is scored.
 */
import { createHash } from "node:crypto"
import { Array as Arr, Order, Schema, String as Str } from "effect"

import type { ReplayEvent } from "./candidate"

export const variantId = (event: ReplayEvent): string =>
	createHash("sha1")
		.update(
			[
				event.orgId ?? "",
				event.serviceName,
				event.exceptionType,
				event.statusMessage,
				event.exceptionStacktrace,
				// Only when present, so ids of samples without them stay what labels recorded.
				...(event.customFingerprint === undefined ? [] : [`fp:${event.customFingerprint}`]),
				...(event.span === undefined ? [] : [`span:${event.span.kind} ${event.span.name}`]),
			].join("\u0000"),
		)
		.digest("hex")
		.slice(0, 16)

export const Label = Schema.Struct({ a: Schema.String, b: Schema.String, same: Schema.Boolean })
export type Label = Schema.Schema.Type<typeof Label>

export interface Pair {
	readonly a: ReplayEvent
	readonly b: ReplayEvent
	readonly why: string
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

/** Deterministic shuffle, so a re-run draws the same pairs. */
const seeded = <A>(items: ReadonlyArray<A>, id: (a: A) => string, seed: string): Array<A> =>
	Arr.sort(
		items,
		Order.mapInput(Order.String, (item: A) =>
			createHash("sha1")
				.update(`${seed}${id(item)}`)
				.digest("hex"),
		),
	)

const tokens = (text: string) =>
	new Set(Arr.filter(Str.split(/[^A-Za-z]+/)(Str.toLowerCase(text)), (t) => t.length > 2))
const jaccard = (a: Set<string>, b: Set<string>) => {
	const inter = Arr.filter([...a], (t) => b.has(t)).length
	const union = a.size + b.size - inter
	return union === 0 ? 1 : inter / union
}

/**
 * Pairs for the baseline: `within` pairs from issues holding more than one variant,
 * `across` pairs from one org, service and type split over issues (half of them the
 * most similar messages, where a split is most likely wrong).
 */
export const drawPairs = (
	events: ReadonlyArray<ReplayEvent>,
	key: (event: ReplayEvent) => string,
	{ within, across }: { readonly within: number; readonly across: number },
): Array<Pair> => {
	const byKey = Arr.groupBy(events, key)
	const withinPairs = Arr.flatMap(Object.values(byKey), (group) =>
		group.length > 1 ? [{ a: group[0], b: group[group.length - 1], why: "within" }] : [],
	)
	const byType = Arr.groupBy(
		events,
		(e) => `${e.orgId ?? ""}\u0000${e.serviceName}\u0000${e.exceptionType}`,
	)
	const acrossPairs = Arr.flatMap(Object.values(byType), (group) => {
		const heads = Arr.map(Object.values(Arr.groupBy(group, key)), (g) => g[0])
		if (heads.length < 2) return []
		const scored = Arr.flatMap(heads, (a, i) =>
			Arr.map(heads.slice(i + 1, i + 6), (b) => ({
				a,
				b,
				sim: jaccard(tokens(a.statusMessage), tokens(b.statusMessage)),
			})),
		)
		const best = Arr.sort(
			scored,
			Order.mapInput(Order.flip(Order.Number), (p: { sim: number }) => p.sim),
		)
		return Arr.map(best.slice(0, 2), ({ a, b, sim }) => ({
			a,
			b,
			why: sim >= 0.5 ? "across-similar" : "across",
		}))
	})
	const pick = (pairs: ReadonlyArray<Pair>, n: number, seed: string) =>
		seeded(pairs, (p) => pairKey(variantId(p.a), variantId(p.b)), seed).slice(0, n)
	const similar = Arr.filter(acrossPairs, (p) => p.why === "across-similar")
	const rest = Arr.filter(acrossPairs, (p) => p.why === "across")
	return [
		...pick(withinPairs, within, "within"),
		...pick(similar, Math.ceil(across / 2), "similar"),
		...pick(rest, Math.floor(across / 2), "across"),
	]
}

/** Pairs a proposal decides differently from today, drawn evenly from its merges and splits. */
export const drawChangedPairs = (
	events: ReadonlyArray<ReplayEvent>,
	current: (event: ReplayEvent) => string,
	candidate: (event: ReplayEvent) => string,
	limit: number,
): Array<Pair> => {
	const pairsOf = (outer: (e: ReplayEvent) => string, inner: (e: ReplayEvent) => string, why: string) =>
		Arr.flatMap(Object.values(Arr.groupBy(events, outer)), (group) => {
			const heads = Arr.map(Object.values(Arr.groupBy(group, inner)), (g) => g[0])
			return Arr.map(heads.slice(1, 4), (b) => ({ a: heads[0], b, why }))
		})
	const merges = pairsOf(candidate, current, "merge")
	const splits = pairsOf(current, candidate, "split")
	const half = Math.ceil(limit / 2)
	const seed = (p: Pair) => pairKey(variantId(p.a), variantId(p.b))
	return [
		...seeded(merges, seed, "merge").slice(0, half),
		...seeded(splits, seed, "split").slice(0, limit - half),
	]
}

export interface Score {
	readonly labelled: number
	readonly precision: number
	readonly recall: number
	readonly f1: number
	readonly falseMerges: number
	readonly falseSplits: number
}

/** Pairwise precision and recall of a grouping over the labelled pairs it can see. */
export const score = (
	labels: ReadonlyArray<Label>,
	byId: ReadonlyMap<string, ReplayEvent>,
	key: (event: ReplayEvent) => string,
): Score => {
	const seen = Arr.flatMap(labels, (label) => {
		const a = byId.get(label.a)
		const b = byId.get(label.b)
		return a === undefined || b === undefined ? [] : [{ same: label.same, grouped: key(a) === key(b) }]
	})
	const tp = Arr.filter(seen, (s) => s.same && s.grouped).length
	const fp = Arr.filter(seen, (s) => !s.same && s.grouped).length
	const fn = Arr.filter(seen, (s) => s.same && !s.grouped).length
	const precision = tp + fp === 0 ? 1 : tp / (tp + fp)
	const recall = tp + fn === 0 ? 1 : tp / (tp + fn)
	return {
		labelled: seen.length,
		precision,
		recall,
		f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
		falseMerges: fp,
		falseSplits: fn,
	}
}

/** What a rater reads: no hash, no issue, nothing that says how either grouping decided. */
export const renderPair = (pair: Pair) => {
	const side = (e: ReplayEvent) => ({
		service: e.serviceName,
		type: e.exceptionType,
		message: Str.slice(0, 400)(e.statusMessage),
		stack: Arr.join(Str.split("\n")(e.exceptionStacktrace).slice(0, 10), "\n"),
	})
	return { a: variantId(pair.a), b: variantId(pair.b), A: side(pair.a), B: side(pair.b) }
}
