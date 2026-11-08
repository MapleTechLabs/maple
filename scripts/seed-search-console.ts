#!/usr/bin/env bun
// Usage: TINYBIRD_HOST=... TINYBIRD_TOKEN=... bun scripts/seed-search-console.ts --org <orgId> [--site sc-domain:acme.dev] [--days 90]
// Writes Search Console fixture rows, consistent across the site, page and query grains, through the
// importer's row mapping and the warehouse's Events API insert (`.env.local` points at local Tinybird).
import { parseArgs } from "node:util"
import { Console, Effect, Array as Arr, Record as Rec, String as Str } from "effect"
import { FetchHttpClient } from "effect/http"
import type { SearchAnalyticsRow } from "../packages/backend/src/services/integrations/google-search-console/client"
import {
	addDays,
	GRAINS,
	pacificToday,
	SEARCH_CONSOLE_DATASOURCE,
	type SearchConsoleGrain,
	toDailyRows,
	toWarehouseDateTime64,
} from "../packages/backend/src/services/integrations/google-search-console/import-plan"
import { __testables } from "../packages/backend/src/services/warehouse/WarehouseQueryService"

const { values } = parseArgs({
	options: {
		org: { type: "string" },
		site: { type: "string", default: "sc-domain:acme.dev" },
		days: { type: "string", default: "90" },
	},
})
const host = process.env.TINYBIRD_HOST
const token = process.env.TINYBIRD_TOKEN
if (values.org === undefined || host === undefined || token === undefined) {
	console.error("Pass --org <orgId> with TINYBIRD_HOST and TINYBIRD_TOKEN set")
	process.exit(2)
}
const orgId = values.org
const siteUrl = values.site ?? "sc-domain:acme.dev"
const dayCount = Number(values.days)

let seed = 7
const random = () => {
	seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31
	return seed / 2 ** 31
}
const pick = (items: ReadonlyArray<string>): string => items[Math.floor(random() * items.length)] ?? ""
const slug = Str.replaceAll(" ", "-")

const origin = Str.startsWith("sc-domain:")(siteUrl)
	? `https://${siteUrl.slice("sc-domain:".length)}`
	: siteUrl
const SECTIONS = ["docs", "blog", "guides", "integrations", "changelog"]
const TOPICS = [
	"opentelemetry",
	"tracing",
	"logs",
	"metrics",
	"clickhouse",
	"alerts",
	"service map",
	"error tracking",
	"session replay",
	"kubernetes",
	"cloudflare workers",
	"nextjs",
]
const MODIFIERS = [
	"how to",
	"best",
	"vs datadog",
	"pricing",
	"tutorial",
	"self hosted",
	"open source",
	"setup",
]
const COUNTRIES = ["usa", "gbr", "deu", "ind", "can", "fra", "bra", "nld"]
const DEVICES = ["DESKTOP", "MOBILE", "TABLET"]

const pages = [
	`${origin}/`,
	`${origin}/pricing`,
	...Arr.flatMap(SECTIONS, (section) =>
		Arr.map(Arr.range(1, 30), (index) => `${origin}/${section}/${slug(pick(TOPICS))}-${index}`),
	),
]
const queries = Arr.dedupe(
	Arr.map(Arr.range(1, 320), () => `${pick(MODIFIERS)} ${pick(TOPICS)}${random() < 0.3 ? " 2026" : ""}`),
)
// Each query ranks on one or two pages, with a base demand and position.
const rankings = Arr.flatMap(queries, (query) =>
	Arr.map(Arr.range(1, random() < 0.3 ? 2 : 1), () => ({
		query,
		page: pick(pages),
		demand: 5 + random() * 120,
		position: 1 + random() * 30,
	})),
)

interface Cell {
	readonly date: string
	readonly page: string
	readonly query: string
	readonly country: string
	readonly device: string
	readonly clicks: number
	readonly impressions: number
	readonly positionSum: number
}

const today = pacificToday(Date.now())
const days = Arr.map(Arr.range(1, dayCount), (offset) => addDays(today, -offset))

// The query grain is the base; page and site add anonymized traffic. Page rows carry no
// country/device, as Google drops anonymized traffic when page is split by them.
const queryCells: ReadonlyArray<Cell> = Arr.filter(
	Arr.flatMap(days, (date) =>
		Arr.flatMap(rankings, (ranking) =>
			Arr.map(COUNTRIES.slice(0, 1 + Math.floor(random() * 3)), (country) => {
				const impressions = Math.round(ranking.demand * random() * (country === "usa" ? 1 : 0.4))
				const position = Math.max(1, ranking.position + (random() - 0.5) * 4)
				return {
					date,
					page: ranking.page,
					query: ranking.query,
					country,
					device: pick(DEVICES),
					clicks: Math.round(impressions * Math.min(0.4, 0.35 / position) * random() * 2),
					impressions,
					positionSum: position * impressions,
				}
			}),
		),
	),
	(cell) => cell.impressions > 0,
)

const rollUp = (cells: ReadonlyArray<Cell>, withPage: boolean, anonymized: number): ReadonlyArray<Cell> =>
	Arr.map(
		Rec.values(
			Arr.groupBy(cells, (cell) =>
				Arr.join(withPage ? [cell.date, cell.page] : [cell.date, cell.country, cell.device], "|"),
			),
		),
		(group) => {
			const first = group[0]
			const clicks = Arr.reduce(group, 0, (sum, cell) => sum + cell.clicks)
			const impressions = Arr.reduce(group, 0, (sum, cell) => sum + cell.impressions)
			const positionSum = Arr.reduce(group, 0, (sum, cell) => sum + cell.positionSum)
			const extra = Math.round(impressions * anonymized)
			return {
				...first,
				page: withPage ? first.page : "",
				query: "",
				country: withPage ? "" : first.country,
				device: withPage ? "" : first.device,
				clicks: clicks + Math.round(clicks * anonymized),
				impressions: impressions + extra,
				positionSum: positionSum + (positionSum / impressions) * extra,
			}
		},
	)

const cellsByGrain = {
	query: queryCells,
	page: rollUp(queryCells, true, 0.2),
	site: rollUp(queryCells, false, 0.2),
} satisfies Record<SearchConsoleGrain, ReadonlyArray<Cell>>

const keyOf = (cell: Cell, dimension: string) =>
	dimension === "date"
		? cell.date
		: dimension === "page"
			? cell.page
			: dimension === "query"
				? cell.query
				: dimension === "country"
					? cell.country
					: cell.device

const ingestedAt = toWarehouseDateTime64(Date.now())
const rows = Arr.flatMap(GRAINS, (grain) =>
	toDailyRows(
		{ orgId, siteUrl, grain: grain.grain, dimensions: grain.dimensions, ingestedAt },
		Arr.map(cellsByGrain[grain.grain], (cell): SearchAnalyticsRow => ({
			keys: Arr.map(grain.dimensions, (dimension) => keyOf(cell, dimension)),
			clicks: cell.clicks,
			impressions: cell.impressions,
			ctr: cell.clicks / cell.impressions,
			position: cell.positionSum / cell.impressions,
		})),
	),
)

const program = Effect.gen(function* () {
	const client = yield* __testables.createTinybirdSqlClient({ kind: "tinybird", host, token })
	yield* Effect.forEach(
		Arr.chunksOf(rows, 10_000),
		(batch) => client.insert(SEARCH_CONSOLE_DATASOURCE, batch),
		{ discard: true },
	)
	const counts = Arr.map(GRAINS, (grain) => `${grain.grain}=${cellsByGrain[grain.grain].length}`)
	yield* Console.log(
		`Wrote ${rows.length} ${SEARCH_CONSOLE_DATASOURCE} rows for ${orgId} / ${siteUrl}, ${days.at(-1)} to ${days[0]} (${Arr.join(counts, ", ")})`,
	)
})

await Effect.runPromise(program.pipe(Effect.provide(FetchHttpClient.layer)))
