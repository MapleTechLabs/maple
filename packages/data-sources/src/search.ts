import { Array as Arr, Order, Record as Rec, String as Str } from "effect"
import type {
	CatalogEntryView,
	DataSourceEnvironment,
	DataSourceSearchHit,
	ExternalDataSourceId,
	QueryLanguage,
} from "@maple/domain/data-sources"
import { words } from "./suggest"

// Ranks catalog entries across every source for a few words ("failed payments", "signups").
// Runs in memory over the stored catalogs: an org's exposed entries are thousands at most, and
// this way search never touches a source or spends an API budget.

export interface SearchableSource {
	readonly id: ExternalDataSourceId
	readonly name: string
	readonly description: string
	readonly environment: DataSourceEnvironment
	readonly tags: ReadonlyArray<string>
	readonly queryLanguage: QueryLanguage
	readonly entries: ReadonlyArray<CatalogEntryView>
}

const STOP_WORDS: ReadonlySet<string> = new Set([
	"the",
	"of",
	"in",
	"on",
	"for",
	"and",
	"or",
	"to",
	"by",
	"per",
	"with",
	"our",
	"my",
	"we",
	"how",
	"many",
	"much",
	"what",
	"which",
	"where",
	"show",
	"me",
	"chart",
	"count",
	"number",
	"table",
	"data",
	"database",
	"is",
	"are",
	"was",
	"do",
	"does",
	"all",
	"last",
	"this",
	"week",
	"day",
	"daily",
	"month",
	"today",
	"over",
	"time",
	"graph",
])

const ENVIRONMENT_WORDS = {
	production: ["prod", "production", "live"],
	staging: ["staging", "stage"],
	development: ["dev", "development", "test"],
	other: [],
} satisfies Record<DataSourceEnvironment, ReadonlyArray<string>>

const SCORE = {
	entryName: 6,
	fieldName: 3,
	note: 2,
	sample: 2,
	sourceText: 1,
	environment: 4,
	/** Breaks ties toward production when the words do not name an environment. */
	productionTieBreak: 0.25,
} as const

const DEFAULT_LIMIT = 10

const matchesAny = (haystack: ReadonlyArray<string>, needle: string): boolean =>
	Arr.some(haystack, (word) => word === needle || (needle.length >= 4 && Str.startsWith(needle)(word)))

export const searchCatalogs = (
	sources: ReadonlyArray<SearchableSource>,
	query: string,
	limit: number = DEFAULT_LIMIT,
): ReadonlyArray<DataSourceSearchHit> => {
	const asked = Arr.dedupe(Arr.filter(words(query), (word) => !STOP_WORDS.has(word)))
	const askedEnvironment = Arr.findFirst(Rec.toEntries(ENVIRONMENT_WORDS), ([, envWords]) =>
		Arr.some(asked, (word) => Arr.contains(envWords, word)),
	)
	const contentWords = Arr.filter(
		asked,
		(word) => !Arr.some(Rec.values(ENVIRONMENT_WORDS), (envWords) => Arr.contains(envWords, word)),
	)
	if (contentWords.length === 0) return []

	const hits = Arr.flatMap(sources, (source) => {
		const sourceWords = words(`${source.name} ${source.description} ${Arr.join(source.tags, " ")}`)
		const environmentScore =
			askedEnvironment._tag === "Some"
				? askedEnvironment.value[0] === source.environment
					? SCORE.environment
					: 0
				: source.environment === "production"
					? SCORE.productionTieBreak
					: 0
		return Arr.flatMap(source.entries, (entry): ReadonlyArray<DataSourceSearchHit> => {
			if (!entry.exposed) return []
			const entryWords = words(entry.name)
			const noteWords = words(entry.note ?? "")
			let score = 0
			let sourceScore = 0
			const reasons: Array<string> = []
			const matchedFields = new Set<string>()
			for (const word of contentWords) {
				let matched = false
				if (matchesAny(entryWords, word)) {
					score += SCORE.entryName
					reasons.push(`name matches "${word}"`)
					matched = true
				}
				for (const field of entry.fields) {
					if (matchesAny(words(field.name), word)) {
						score += SCORE.fieldName
						matchedFields.add(field.name)
						matched = true
					} else if (matchesAny(words(field.note ?? ""), word)) {
						score += SCORE.note
						matchedFields.add(field.name)
						matched = true
					} else if (
						Arr.some(field.sampleValues ?? [], (value) => matchesAny(words(value), word))
					) {
						score += SCORE.sample
						matchedFields.add(field.name)
						reasons.push(`${field.name} has values like "${word}"`)
						matched = true
					}
				}
				if (matchesAny(noteWords, word)) {
					score += SCORE.note
					reasons.push(`note mentions "${word}"`)
					matched = true
				}
				if (!matched && matchesAny(sourceWords, word)) sourceScore += SCORE.sourceText
			}
			// The source's own words only rank entries that matched on their own.
			if (score === 0) return []
			score += sourceScore
			if (matchedFields.size > 0 && reasons.length === 0) {
				reasons.push(`fields ${Arr.join(Arr.take(Arr.fromIterable(matchedFields), 4), ", ")}`)
			}
			return [
				{
					source: source.name,
					sourceId: source.id,
					environment: source.environment,
					queryLanguage: source.queryLanguage,
					entry: entry.name,
					matchedFields: Arr.take(Arr.fromIterable(matchedFields), 8),
					reason: Arr.join(Arr.take(Arr.dedupe(reasons), 3), "; "),
					score: score + environmentScore,
				},
			]
		})
	})

	const byScore = Order.combine(
		Order.mapInput(Order.flip(Order.Number), (hit: DataSourceSearchHit) => hit.score),
		Order.mapInput(Order.String, (hit: DataSourceSearchHit) => `${hit.source}.${hit.entry}`),
	)
	return Arr.take(Arr.sort(hits, byScore), limit)
}
