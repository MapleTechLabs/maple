import { describe, expect, it } from "@effect/vitest"
import { Effect, String as Str } from "effect"
import { compile, compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import {
	searchConsoleLandingPagesQuery,
	searchConsoleOverviewQuery,
	searchConsoleTimeseriesQuery,
	searchConsoleTopPagesQuery,
	searchConsoleTopQueriesQuery,
} from "./search-console"
import { webAnalyticsEntryPagesQuery } from "./web-analytics"

const params = {
	orgId: OrgId.make("org_1"),
	siteUrl: "sc-domain:acme.dev",
	startDate: "2026-10-01 00:00:00",
	endDate: "2026-10-28 00:00:00",
}

const oneLine = (sql: string): string => Str.replace(/\s+/g, " ")(sql)

describe("searchConsoleOverviewQuery", () => {
	it("splits one site-grain scan into the window and the period before it", () => {
		const { sql, tenantScope, route } = compileUnsafe(searchConsoleOverviewQuery(), {
			...params,
			previousStartDate: "2026-09-03 00:00:00",
		})
		const flat = oneLine(sql)
		expect(tenantScope).toBe("single-tenant")
		expect(route).toBe("ingest")
		expect(flat).toContain("FROM search_console_daily")
		expect(flat).toContain("Grain = 'site'")
		expect(flat).toContain("SiteUrl = 'sc-domain:acme.dev'")
		expect(flat).toContain("Date >= '2026-09-03 00:00:00'")
		// Only each day's newest import counts: the join keeps rows at that day's max IngestedAt.
		expect(flat).toContain("max(search_console_daily.IngestedAt) AS ingestedAt")
		expect(flat).toContain(
			"AS newest ON (search_console_daily.Date = newest.date AND search_console_daily.IngestedAt = newest.ingestedAt)",
		)
		expect(flat).toMatch(/sumIf\(latest\.clicks, latest\.date >= '2026-10-01 00:00:00'\)/)
		expect(flat).toMatch(/sumIf\(latest\.clicks, NOT \(latest\.date >= '2026-10-01 00:00:00'\)\)/)
	})

	it.effect("decodes UInt64 sums sent as JSON strings", () =>
		Effect.gen(function* () {
			const compiled = yield* compile(searchConsoleOverviewQuery(), {
				...params,
				previousStartDate: "2026-09-03 00:00:00",
			})
			const [row] = yield* compiled.decodeRows([
				{
					clicks: "120",
					impressions: "4000",
					ctr: 0.03,
					position: 7.5,
					previousClicks: "100",
					previousImpressions: "5000",
					previousCtr: 0.02,
					previousPosition: 9,
				},
			])
			expect(row?.clicks).toBe(120)
			expect(row?.previousImpressions).toBe(5000)
		}),
	)
})

describe("searchConsoleTimeseriesQuery", () => {
	it("groups the site grain by day and divides position by impressions", () => {
		const flat = oneLine(compileUnsafe(searchConsoleTimeseriesQuery(), params).sql)
		expect(flat).toContain("Grain = 'site'")
		expect(flat).toContain("GROUP BY date")
		expect(flat).toContain("ORDER BY date ASC")
		expect(flat).toContain("ifNotFinite(sum(latest.positionSum) / sum(latest.impressions), 0)")
	})
})

describe("searchConsoleTopQueriesQuery / searchConsoleTopPagesQuery", () => {
	it("reads only the query grain and applies the filters", () => {
		const flat = oneLine(
			compileUnsafe(
				searchConsoleTopQueriesQuery({
					sortBy: "impressions",
					limit: 20,
					country: "deu",
					device: "mobile",
					page: "https://acme.dev/docs",
				}),
				params,
			).sql,
		)
		expect(flat).toContain("Grain = 'query'")
		expect(flat).toContain("Country = 'deu'")
		expect(flat).toContain("Device = 'mobile'")
		expect(flat).toContain("Page = 'https://acme.dev/docs'")
		// Filters narrow the rows, never which import is newest: the day's max is taken unfiltered.
		expect(flat).toMatch(
			/max\(search_console_daily\.IngestedAt\) AS ingestedAt FROM search_console_daily WHERE (?:(?!Country)[^)])*GROUP BY date\) AS newest/,
		)
		expect(flat).toContain("ORDER BY impressions DESC")
		expect(flat).toContain("LIMIT 20")
	})

	it("sorts position ascending by default, since lower is better", () => {
		const flat = oneLine(compileUnsafe(searchConsoleTopPagesQuery({ sortBy: "position" }), params).sql)
		expect(flat).toContain("Grain = 'page'")
		expect(flat).toContain("ORDER BY position ASC")
	})

	it("breaks ties on the busier row before the name, so zero-click rows are not alphabetical", () => {
		const byClicks = oneLine(compileUnsafe(searchConsoleTopQueriesQuery(), params).sql)
		expect(byClicks).toContain("ORDER BY clicks DESC, impressions DESC, query ASC")
		// Impressions cannot break their own ties, so clicks do.
		const byImpressions = oneLine(
			compileUnsafe(searchConsoleTopPagesQuery({ sortBy: "impressions" }), params).sql,
		)
		expect(byImpressions).toContain("ORDER BY impressions DESC, clicks DESC, page ASC")
	})

	it("narrows pages by page only: the page grain has no country or device", () => {
		const flat = oneLine(
			compileUnsafe(searchConsoleTopPagesQuery({ page: "https://acme.dev/docs" }), params).sql,
		)
		expect(flat).toContain("Page = 'https://acme.dev/docs'")
		expect(flat).not.toContain("Country =")
		expect(flat).not.toContain("Device =")
	})

	it("lists landing pages by clicks from the page grain", () => {
		const flat = oneLine(compileUnsafe(searchConsoleLandingPagesQuery({ limit: 30 }), params).sql)
		expect(flat).toContain("Grain = 'page'")
		expect(flat).toContain("GROUP BY page")
		expect(flat).toContain("ORDER BY clicks DESC")
		expect(flat).toContain("LIMIT 30")
	})

	it("cuts landing pages by the table's sort, so a metric sort picks its own top rows", () => {
		const byImpressions = oneLine(
			compileUnsafe(searchConsoleLandingPagesQuery({ sortBy: "impressions", limit: 30 }), params).sql,
		)
		expect(byImpressions).toContain("ORDER BY impressions DESC")
		const byPosition = oneLine(
			compileUnsafe(searchConsoleLandingPagesQuery({ sortBy: "position" }), params).sql,
		)
		expect(byPosition).toContain("ORDER BY position ASC")
	})
})

describe("webAnalyticsEntryPagesQuery", () => {
	it("counts sessions per landing page, narrowed to the given paths", () => {
		const { sql, tenantScope } = compileUnsafe(
			webAnalyticsEntryPagesQuery({ entryPaths: ["/", "/docs"], traffic: "humans" }),
			{ orgId: OrgId.make("org_1"), startTime: "2026-10-01 00:00:00", endTime: "2026-10-28 00:00:00" },
		)
		const flat = oneLine(sql)
		expect(tenantScope).toBe("single-tenant")
		expect(flat).toContain("FROM session_replays")
		expect(flat).toContain("EntryPath IN ('/', '/docs')")
		expect(flat).toContain("GROUP BY host, entryPath")
		expect(flat).toContain("NOT (multiSearchAnyCaseInsensitive(session_replays.UserAgent")
	})
})
