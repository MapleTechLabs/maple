// Runs the Search Console reads on the real ClickHouse engine (chDB): each day counts only its newest
// complete import, as the importer's completion markers define it, before and after a merge.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CH } from "@maple/query-engine"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import { decodeJsonEachRow } from "@maple/local-server/chdb-rows"
import schemaSql from "@maple/local-server/schema/local-schema.sql" with { type: "text" }
import { Chdb } from "@maple/local-server/chdb"
import { OrgId } from "@maple/domain"
import { SEARCH_TYPE_WEB, SEARCH_TYPE_WEB_COMPLETE } from "@maple/domain/search-console"
import { Array as Arr, Schema, String as Str } from "effect"
import { describeWithChdb } from "./libchdb-test-support"

const ORG = "org_search"
const DAY = "2026-11-10 00:00:00"
const T1 = "2026-11-12 06:00:00.000"
const T2 = "2026-11-13 06:00:00.000"

interface Seed {
	readonly site: string
	readonly at: string
	readonly grain?: "site" | "query"
	readonly day?: string
	readonly query?: string
	readonly clicks?: number
	readonly marker?: boolean
}

const row = (seed: Seed) =>
	`('${ORG}', '${seed.site}', '${seed.grain ?? "query"}', '${seed.marker === true ? SEARCH_TYPE_WEB_COMPLETE : SEARCH_TYPE_WEB}', '${seed.day ?? DAY}', 'https://acme.dev/', '${seed.query ?? ""}', '${seed.marker === true ? "" : "usa"}', '${seed.marker === true ? "" : "desktop"}', ${seed.clicks ?? 0}, ${(seed.clicks ?? 0) * 10}, ${(seed.clicks ?? 0) * 20}, '${seed.at}')`

const marker = (site: string, at: string, grain?: "site"): Seed => ({ site, at, grain, marker: true })

const SEEDS: ReadonlyArray<Seed> = [
	// Written before markers existed: the newest import counts.
	{ site: "legacy", at: T1, query: "a", clicks: 10 },
	{ site: "legacy", at: T2, query: "a", clicks: 12 },
	// A complete re-import that no longer holds query b.
	{ site: "dropped", at: T1, query: "a", clicks: 5 },
	{ site: "dropped", at: T1, query: "b", clicks: 3 },
	marker("dropped", T1),
	{ site: "dropped", at: T2, query: "a", clicks: 6 },
	marker("dropped", T2),
	// Google answered the re-import empty: only its marker lands.
	{ site: "emptied", at: T1, query: "a", clicks: 4 },
	marker("emptied", T1),
	marker("emptied", T2),
	// The re-import failed before its marker: the complete import keeps query b.
	{ site: "partial", at: T1, query: "a", clicks: 7 },
	{ site: "partial", at: T1, query: "b", clicks: 2 },
	marker("partial", T1),
	{ site: "partial", at: T2, query: "a", clicks: 9 },
	// Daily site totals: a day with traffic, a day Google answered empty, a day from before markers.
	{ site: "chart", grain: "site", day: "2026-11-08 00:00:00", at: T1, clicks: 5 },
	{ ...marker("chart", T1, "site"), day: "2026-11-08 00:00:00" },
	{ ...marker("chart", T1, "site"), day: "2026-11-09 00:00:00" },
	{ site: "chart", grain: "site", day: DAY, at: T1, clicks: 3 },
]

describeWithChdb("Search Console reads on chDB", () => {
	let root: string
	let db: Chdb

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "maple-search-console-"))
		db = Chdb.open({ dataDir: join(root, "data"), schemaSql })
		// The warehouse table replaces a key by its newest IngestedAt (`ver`); the local one keeps
		// the last insert. Rebuild it the warehouse's way, then insert newest first, so a merge
		// that kept insert order would fail these expectations.
		const local = db.query("SHOW CREATE TABLE search_console_daily FORMAT TSVRaw")
		db.exec("DROP TABLE search_console_daily")
		db.exec(Str.replace("ENGINE = ReplacingMergeTree", "ENGINE = ReplacingMergeTree(IngestedAt)")(local))
		db.exec(
			`INSERT INTO search_console_daily (OrgId, SiteUrl, Grain, SearchType, Date, Page, Query, Country, Device, Clicks, Impressions, PositionSum, IngestedAt) VALUES ${Arr.join(Arr.map(Arr.reverse(SEEDS), row), ", ")}`,
		)
	})

	afterAll(() => {
		db?.close()
		if (root) rmSync(root, { recursive: true, force: true })
	})

	const decode = decodeJsonEachRow(
		Schema.Struct({ query: Schema.String, clicks: CH.CHNumber, impressions: CH.CHNumber }),
	)

	const topQueries = (site: string, filters: CH.SearchConsoleListOpts = {}) => {
		const compiled = CH.compileUnsafe(CH.searchConsoleTopQueriesQuery(filters), {
			orgId: Schema.decodeSync(OrgId)(ORG),
			siteUrl: site,
			startDate: DAY,
			endDate: DAY,
		})
		return Arr.map(decode(db.query(normalizeSqlForClickHouseClient(compiled.sql))), (entry) => [
			entry.query,
			entry.clicks,
		])
	}

	const daily = decodeJsonEachRow(Schema.Struct({ date: Schema.String, clicks: CH.CHNumber }))

	const timeseries = (site: string) => {
		const compiled = CH.compileUnsafe(CH.searchConsoleTimeseriesQuery(), {
			orgId: Schema.decodeSync(OrgId)(ORG),
			siteUrl: site,
			startDate: "2026-11-07 00:00:00",
			endDate: DAY,
		})
		return Arr.map(daily(db.query(normalizeSqlForClickHouseClient(compiled.sql))), (entry) => [
			entry.date,
			entry.clicks,
		])
	}

	const expectations = () => {
		expect(topQueries("legacy")).toEqual([["a", 12]])
		expect(topQueries("dropped")).toEqual([["a", 6]])
		expect(topQueries("emptied")).toEqual([])
		// A filter narrows the rows, never which import is complete: markers hold '' there.
		expect(topQueries("dropped", { country: "usa", device: "desktop" })).toEqual([["a", 6]])
		expect(topQueries("dropped", { country: "deu" })).toEqual([])
		// An imported empty day is a zero point; a day never imported (Nov 7) is no point.
		expect(timeseries("chart")).toEqual([
			["2026-11-08 00:00:00", 5],
			["2026-11-09 00:00:00", 0],
			["2026-11-10 00:00:00", 3],
		])
	}

	test("counts each day's newest complete import before a merge", () => {
		expect(db.query("SHOW CREATE TABLE search_console_daily FORMAT TSVRaw")).toContain(
			"ReplacingMergeTree(IngestedAt)",
		)
		expectations()
		expect(topQueries("partial")).toEqual([
			["a", 9],
			["b", 2],
		])
	})

	test("keeps the complete import's keys after a merge replaces their older versions", () => {
		db.exec("OPTIMIZE TABLE search_console_daily FINAL")
		expectations()
		expect(topQueries("partial")).toEqual([
			["a", 9],
			["b", 2],
		])
	})
})
