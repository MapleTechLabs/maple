// Ranked fuzzy search over a list: weighted keys, a typo budget, stable order. Exact matches rank
// by where they land (whole field, prefix, word start, mid-word); typos fall back to edit distance.
import { Array as Arr, Option, Order, String as Str } from "effect"

export interface FuzzyKey<A> {
	/** The text this key matches against; several values match as the best of them. */
	readonly get: (item: A) => string | ReadonlyArray<string>
	/** Relative importance; a match in a lighter key ranks below the same match in a heavier one. */
	readonly weight: number
}

export interface FuzzyOptions<A> {
	readonly keys: ReadonlyArray<FuzzyKey<A>>
	/** Typo budget as a share of the query's length: 0.3 lets a 10-character query carry 3 edits. */
	readonly threshold: number
	/** Queries shorter than this match nothing. Defaults to 1. */
	readonly minQueryLength?: number
}

export interface FuzzyMatch<A> {
	readonly item: A
	/** 0 is an exact field; lower is better. */
	readonly score: number
	readonly refIndex: number
}

/** Scores per match kind; each kind ranks above the next, typos last. */
const EXACT = 0
const PREFIX = 0.1
const WORD_START = 0.2
const ALL_WORDS = 0.3
const SUBSTRING = 0.4
const TYPO = 0.5
/** How far a weightless key would sink: a lighter key adds its share of this. */
const KEY_SPREAD = 0.3

const normalize = (text: string): string => Str.trim(Str.toLowerCase(text))
const charsOf = (text: string): ReadonlyArray<string> => Arr.fromIterable(text)
const isWordChar = (char: string | undefined): boolean => char !== undefined && /[\p{L}\p{N}]/u.test(char)
const isWordStart = (chars: ReadonlyArray<string>, index: number): boolean =>
	index === 0 || !isWordChar(chars[index - 1])

interface Field {
	readonly text: string
	readonly chars: ReadonlyArray<string>
	readonly wordCount: number
}

const fieldOf = (text: string): Field => {
	const normalized = normalize(text)
	const chars = charsOf(normalized)
	const wordCount = Arr.filter(
		Arr.range(0, chars.length - 1),
		(index) => isWordChar(chars[index]) && isWordStart(chars, index),
	).length
	return { text: normalized, chars, wordCount }
}

const cell = (row: ReadonlyArray<number>, index: number): number => row[index] ?? Number.POSITIVE_INFINITY

interface Typo {
	readonly errors: number
	readonly atWordStart: boolean
}

/**
 * Fewest edits (insert, delete, substitute, swap two neighbours) that turn `query` into some
 * substring of `field`, when within `maxErrors`, and whether such a substring starts a word.
 */
const typoMatch = (
	query: ReadonlyArray<string>,
	field: ReadonlyArray<string>,
	maxErrors: number,
): Option.Option<Typo> => {
	// Each field letter covers at most one query letter; the rest are edits whatever the alignment.
	if (query.length - field.length > maxErrors) return Option.none()
	// Row i holds, per field position j, the cheapest alignment of query[0, i) ending at j, and
	// where in the field that alignment starts. Row 0 is free anywhere: the match may start there.
	let before: Array<number> = []
	let beforeStart: Array<number> = []
	let previous: Array<number> = Arr.makeBy(field.length + 1, () => 0)
	let previousStart: Array<number> = Arr.makeBy(field.length + 1, (j) => j)
	for (let i = 1; i <= query.length; i++) {
		const cost = [i]
		const start = [0]
		const q = query[i - 1]
		for (let j = 1; j <= field.length; j++) {
			const f = field[j - 1]
			let best = cell(previous, j - 1) + (q === f ? 0 : 1)
			let from = cell(previousStart, j - 1)
			// An equally cheap alignment that starts a word wins, so "onde" keeps the swap to "node".
			const consider = (candidate: number, candidateStart: number) => {
				const isBetter =
					candidate < best ||
					(candidate === best && isWordStart(field, candidateStart) && !isWordStart(field, from))
				if (!isBetter) return
				best = candidate
				from = candidateStart
			}
			consider(cell(previous, j) + 1, cell(previousStart, j))
			consider(cell(cost, j - 1) + 1, cell(start, j - 1))
			if (i > 1 && j > 1 && q === field[j - 2] && query[i - 2] === f)
				consider(cell(before, j - 2) + 1, cell(beforeStart, j - 2))
			cost.push(best)
			start.push(from)
		}
		before = previous
		beforeStart = previousStart
		previous = cost
		previousStart = start
	}
	const errors = Math.min(...previous)
	if (errors > maxErrors) return Option.none()
	const atWordStart = Arr.some(
		Arr.range(0, field.length),
		(j) => cell(previous, j) === errors && isWordStart(field, cell(previousStart, j)),
	)
	return Option.some({ errors, atWordStart })
}

/** Whether `needle` occurs in `text` at the start of a word. */
const occursAtWordStart = (text: string, needle: string): boolean =>
	Arr.some(
		Arr.range(0, text.length - 1),
		(index) => !isWordChar(text[index - 1]) && Str.startsWith(needle, index)(text),
	)

interface Query {
	readonly field: Field
	readonly words: ReadonlyArray<string>
	readonly maxErrors: number
}

/** The best score `query` reaches in `field`, if it matches at all. */
const scoreField = (query: Query, field: Field): Option.Option<number> => {
	const { text } = query.field
	if (field.text === text) return Option.some(EXACT)
	if (Str.startsWith(text)(field.text)) return Option.some(PREFIX)
	if (occursAtWordStart(field.text, text)) return Option.some(WORD_START)
	if (query.words.length > 1 && Arr.every(query.words, (word) => occursAtWordStart(field.text, word)))
		return Option.some(ALL_WORDS)
	if (Str.includes(text)(field.text)) return Option.some(SUBSTRING)
	return Option.map(
		typoMatch(query.field.chars, field.chars, query.maxErrors),
		({ errors, atWordStart }) =>
			TYPO + (0.4 * errors) / query.field.chars.length + (atWordStart ? 0 : 0.05),
	)
}

// Nudges within a kind: a field of fewer words wins (a title beats a sentence that contains it),
// and so does an item that also matches on its other keys. Their caps sum below the 0.1 between kinds.
const WORD_NUDGE = 0.004
const MAX_WORD_NUDGE = 0.045
const OTHER_KEY_NUDGE = 0.05
const MAX_OTHER_KEY_NUDGE = 0.045

const byScore = Order.combineAll<{ readonly score: number; readonly refIndex: number }>([
	Order.mapInput(Order.Number, (match) => match.score),
	Order.mapInput(Order.Number, (match) => match.refIndex),
])

const valuesOf = (value: string | ReadonlyArray<string>): ReadonlyArray<string> =>
	typeof value === "string" ? [value] : value

/** The item's score: its best field across every key, nudged up by how well its other keys match. */
const scoreItem = (
	query: Query,
	keys: ReadonlyArray<{ readonly penalty: number; readonly fields: ReadonlyArray<Field> }>,
): Option.Option<number> => {
	const perKey = Arr.getSomes(
		Arr.map(keys, ({ penalty, fields }) =>
			Arr.head(
				Arr.sort(
					Arr.getSomes(
						Arr.map(fields, (field) =>
							Option.map(
								scoreField(query, field),
								(score) =>
									score + penalty + Math.min(MAX_WORD_NUDGE, field.wordCount * WORD_NUDGE),
							),
						),
					),
					Order.Number,
				),
			),
		),
	)
	const [best, ...others] = Arr.sort(perKey, Order.Number)
	if (best === undefined) return Option.none()
	return Option.some(
		best -
			Math.min(
				MAX_OTHER_KEY_NUDGE,
				OTHER_KEY_NUDGE * Arr.reduce(others, 0, (sum, other) => sum + Math.max(0, 1 - other)),
			),
	)
}

/**
 * Prepares `items` once (normalized key text) and returns a search over them: best match first,
 * ties in input order. `limit` caps the results.
 *
 * @example
 * const search = makeFuzzySearch(pages, { keys: [{ get: (p) => p.title, weight: 1 }], threshold: 0.3 })
 * search("srevices") // [{ item: { title: "Services" }, score: 0.6, refIndex: 0 }]
 */
export const makeFuzzySearch = <A>(
	items: ReadonlyArray<A>,
	options: FuzzyOptions<A>,
): ((query: string, limit?: number) => Array<FuzzyMatch<A>>) => {
	const heaviest = Math.max(...Arr.map(options.keys, (key) => key.weight))
	const prepared = Arr.map(items, (item, refIndex) => ({
		item,
		refIndex,
		keys: Arr.map(options.keys, (key) => ({
			penalty: (1 - key.weight / heaviest) * KEY_SPREAD,
			fields: Arr.map(valuesOf(key.get(item)), fieldOf),
		})),
	}))
	const minQueryLength = Math.max(1, options.minQueryLength ?? 1)
	return (rawQuery, limit = Number.POSITIVE_INFINITY) => {
		const field = fieldOf(Str.replace(/\s+/g, " ")(rawQuery))
		if (field.chars.length < minQueryLength) return []
		const query: Query = {
			field,
			words: Str.split(" ")(field.text),
			maxErrors: Math.floor(options.threshold * field.chars.length),
		}
		const matches = Arr.getSomes(
			Arr.map(prepared, ({ item, refIndex, keys }) =>
				Option.map(scoreItem(query, keys), (score) => ({ score, refIndex, item })),
			),
		)
		return Arr.map(Arr.sort(matches, byScore).slice(0, limit), ({ item, score, refIndex }) => ({
			item,
			score,
			refIndex,
		}))
	}
}

/** One-off `makeFuzzySearch(items, options)(query)`. */
export const fuzzySearch = <A>(
	items: ReadonlyArray<A>,
	query: string,
	options: FuzzyOptions<A>,
): Array<FuzzyMatch<A>> => makeFuzzySearch(items, options)(query)
