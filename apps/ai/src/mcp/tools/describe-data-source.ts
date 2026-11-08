import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { Array as Arr, Effect, Option, Schema, String as Str } from "effect"
import { DescribeDataSourceOutput } from "@maple/domain/mcp-outputs"
import type { CatalogEntryView } from "@maple/domain/data-sources"
import { ExternalDataSourceService } from "@maple/backend/services/data-sources/ExternalDataSourceService"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import * as P from "../lib/params"
import { doc, type DocBlock } from "../lib/tool-doc"
import { truncate } from "../lib/format"
import { closestMatches } from "../lib/filter-suggestions"
import { AGENT_AUDIENCE, mapDataSourceError, queryLanguageLabel } from "../lib/data-sources"
import { cheatSheet, exampleQuery, fieldLine, queryText } from "../lib/data-source-cheat-sheet"
import { toDataSourceSummary } from "./list-data-sources"

const TOOL = "describe_data_source"
const MAX_ENTRIES = 5
/** Entries per overview page: a 400-table source must not flood the context. */
export const MAX_OVERVIEW_ENTRIES = 100

/** `payments` finds `shop.payments` when only one schema has it. */
const findEntry = (
	entries: ReadonlyArray<CatalogEntryView>,
	asked: string,
): Option.Option<CatalogEntryView> => {
	const exact = Arr.findFirst(entries, (entry) => entry.name === asked)
	if (Option.isSome(exact)) return exact
	const bySuffix = Arr.filter(entries, (entry) => Str.endsWith(`.${asked}`)(entry.name))
	return bySuffix.length === 1 ? Arr.head(bySuffix) : Option.none()
}

const unqualified = (name: string): string => Str.split(".")(name).at(-1) ?? name

/** Closest entry names, compared both qualified (`shop.payments`) and by their last part (`payments`). */
const closestEntries = (asked: string, entries: ReadonlyArray<CatalogEntryView>): ReadonlyArray<string> => {
	const names = Arr.map(entries, (entry) => entry.name)
	const byShort = closestMatches(unqualified(asked), Arr.map(names, unqualified))
	return Arr.take(
		Arr.dedupe([
			...closestMatches(asked, names),
			...Arr.flatMap(byShort, (short) => Arr.filter(names, (name) => unqualified(name) === short)),
		]),
		3,
	)
}

export function registerDescribeDataSourceTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "Describe Data Source",
		description:
			"The catalog of one connected data source (an external database or API), with its query language first. " +
			"Without `entries`: its tables or resources with row estimates, time field and notes, paged. With up to " +
			`${MAX_ENTRIES} \`entries\`: each one's fields, types, time field, API capabilities, PII flags, notes and sample ` +
			"values, the data source's saved example queries, and a cheat sheet for its query language (SQL macros, or the " +
			"resource query JSON with a worked example). Read it before query_data_source instead of guessing names. " +
			"Not for Maple's own warehouse tables: that is describe_warehouse_tables.",
		parameters: Schema.Struct({
			data_source: P.text(
				"Data source name (from list_data_sources or search_data_sources), e.g. shop-prod",
			),
			entries: P.optionalList(`Tables or resources to describe in full (at most ${MAX_ENTRIES})`),
			offset: P.offset({ max: 5_000 }),
		}),
		aliases: { source: "data_source", name: "data_source", tables: "entries", resources: "entries" },
		output: DescribeDataSourceOutput,
		hints: { readOnly: true },
		phrases: ["Reading a data source's catalog", "Describing a data source"],
		handler: Effect.fn("McpTool.describeDataSource")(function* ({ data_source, entries, offset }) {
			const tenant = yield* CurrentMcpTenant
			const service = yield* ExternalDataSourceService
			const catalog = yield* service
				.catalog(tenant.orgId, data_source, AGENT_AUDIENCE)
				.pipe(mapDataSourceError(TOOL))
			const summary = { ...toDataSourceSummary(catalog.source), entryCount: catalog.entries.length }
			const examples = Arr.map(catalog.examples, (example) => ({
				title: example.title,
				query: queryText(example.query),
			}))
			const asked = Arr.dedupe(Arr.filter(Arr.map(entries ?? [], Str.trim), (name) => name !== ""))
			yield* Effect.annotateCurrentSpan({
				"maple.data_source.kind": catalog.source.kind,
				"maple.data_source.entries_asked": asked.length,
			})
			if (asked.length === 0) {
				return {
					source: summary,
					entries: Arr.map(
						catalog.entries.slice(offset, offset + MAX_OVERVIEW_ENTRIES),
						(entry) => ({
							name: entry.name,
							kind: entry.kind,
							...(entry.rowEstimate === undefined
								? undefined
								: { rowEstimate: entry.rowEstimate }),
							...(entry.timeField === undefined ? undefined : { timeField: entry.timeField }),
							...(entry.note === undefined ? undefined : { note: entry.note }),
							fieldCount: entry.fields.length,
						}),
					),
					totalEntries: catalog.entries.length,
					offset,
					examples,
				}
			}
			if (asked.length > MAX_ENTRIES) {
				return yield* new McpInvalidInputError({
					message: `Ask for at most ${MAX_ENTRIES} entries at a time; got ${asked.length}.`,
					parameter: "entries",
				})
			}
			const described = yield* Effect.forEach(asked, (name) =>
				Option.match(findEntry(catalog.entries, name), {
					onSome: Effect.succeed,
					onNone: () => {
						const close = closestEntries(name, catalog.entries)
						return Effect.fail(
							new McpInvalidInputError({
								message: `"${catalog.source.name}" has no table or resource "${name}".${
									close.length === 0
										? " Call describe_data_source without entries to list them."
										: ` Did you mean ${Arr.join(
												Arr.map(close, (c) => `"${c}"`),
												" or ",
											)}?`
								}`,
								parameter: "entries",
							}),
						)
					},
				}),
			)
			return {
				source: summary,
				totalEntries: catalog.entries.length,
				offset: 0,
				described: Arr.map(described, (entry) => ({
					name: entry.name,
					kind: entry.kind,
					...(entry.rowEstimate === undefined ? undefined : { rowEstimate: entry.rowEstimate }),
					...(entry.timeField === undefined ? undefined : { timeField: entry.timeField }),
					...(entry.note === undefined ? undefined : { note: entry.note }),
					fields: [...entry.fields],
				})),
				examples,
				cheatSheet: [...cheatSheet(catalog.source.queryLanguage, described)],
				exampleQuery: exampleQuery(catalog.source.queryLanguage, described),
			}
		}),
		render: (output) => {
			const s = output.source
			const header = doc.text(
				`Data source \`${s.name}\`: ${queryLanguageLabel(s.queryLanguage)}, ${s.kind}, ${s.environment}. ${s.description}`,
			)
			const examples: ReadonlyArray<DocBlock> =
				output.examples.length === 0
					? []
					: [
							doc.heading("Example queries"),
							doc.list(Arr.map(output.examples, (e) => `${e.title}: \`${e.query}\``)),
						]
			if (output.described !== undefined) {
				const example = output.exampleQuery
				return {
					title: `${s.name}: ${Arr.join(
						Arr.map(output.described, (e) => e.name),
						", ",
					)}`,
					blocks: [
						header,
						...Arr.flatMap(output.described, (entry) => [
							doc.heading(`\`${entry.name}\` (${entry.kind})`),
							...(entry.note === undefined ? [] : [doc.text(entry.note)]),
							doc.list(Arr.map(entry.fields, (field) => fieldLine(field, entry.timeField))),
						]),
						doc.heading("How to query"),
						doc.list(output.cheatSheet ?? []),
						...examples,
					],
					...(example === undefined
						? undefined
						: {
								next: [
									doc.next(
										"query_data_source",
										{
											data_source: s.name,
											...(s.queryLanguage === "resource"
												? { resource: example }
												: { sql: example }),
											explain: true,
										},
										"plan the example query without running it, then drop explain to run it",
									),
								],
							}),
				}
			}
			const entries = output.entries ?? []
			const shownEnd = output.offset + entries.length
			const first = entries[0]
			return {
				title: `${s.name} (${output.totalEntries} ${s.queryLanguage === "resource" ? "resources" : "tables"})`,
				blocks: [
					header,
					doc.table(
						["Entry", "Kind", "Rows (est.)", "Time field", "Fields", "Note"],
						Arr.map(entries, (e) => [
							e.name,
							e.kind,
							e.rowEstimate === undefined ? "-" : String(e.rowEstimate),
							e.timeField ?? "-",
							String(e.fieldCount),
							truncate(e.note ?? "", 120),
						]),
					),
					...examples,
				],
				...(output.totalEntries === 0
					? { empty: { message: "This data source exposes no tables or resources to agents." } }
					: undefined),
				...(shownEnd < output.totalEntries
					? {
							truncation: {
								shown: entries.length,
								total: output.totalEntries,
								noun: "entries (search_data_sources finds one by topic)",
								next: doc.next(
									TOOL,
									{ data_source: s.name, offset: shownEnd },
									"the next page of entries",
								),
							},
						}
					: undefined),
				...(first === undefined
					? undefined
					: {
							next: [
								doc.next(
									TOOL,
									{ data_source: s.name, entries: [first.name] },
									"an entry's fields and how to query it",
								),
							],
						}),
			}
		},
	})
}
