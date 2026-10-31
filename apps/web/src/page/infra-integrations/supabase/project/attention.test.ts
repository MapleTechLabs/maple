import { SupabaseLogIssue, SupabaseProjectInsights } from "@maple/domain/http"
import { Schema } from "effect"
import { describe, expect, test } from "vitest"
import { MAX_ATTENTION_ITEMS, needsAttention } from "./attention"

const lint = (advisor: "security" | "performance", level: "ERROR" | "WARN" | "INFO", title: string) => ({
	advisor,
	name: title,
	title,
	level,
	categories: [advisor.toUpperCase()],
	description: "",
	detail: "Table `public.invoices` is exposed",
	remediation: "https://supabase.com/docs",
	schema: "public",
	object: "invoices",
	objectType: "table",
	cacheKey: `${advisor}-${title}`,
})

const insights = Schema.decodeUnknownSync(SupabaseProjectInsights)({
	projectRef: "abcdefghijklmnopqrst",
	advisors: {
		error: [lint("security", "ERROR", "RLS disabled in public")],
		warn: [lint("performance", "WARN", "Unindexed foreign keys")],
		info: [lint("performance", "INFO", "Unused index")],
	},
	advisorsCheckedAt: 1,
	advisorsError: null,
	topQueries: [],
	queriesCheckedAt: null,
	queriesError: null,
})

const issue = (message: string, maxSeverity: number) =>
	Schema.decodeUnknownSync(SupabaseLogIssue)({
		projectRef: "abcdefghijklmnopqrst",
		source: "postgres_logs",
		message,
		count: 14,
		lastSeen: "2026-10-01T09:41:00Z",
		maxSeverity,
	})

describe("needsAttention", () => {
	test("orders advisor errors, error logs, saturation, then advisor warnings, leaving out info lints and warn logs", () => {
		const items = needsAttention({
			insights,
			issues: [issue("deadlock detected", 17), issue("slow checkpoint", 13)],
			connections: { peak: 57, limit: 60 },
		})
		expect(items.map((item) => [item.label, item.title])).toEqual([
			["Security", "RLS disabled in public"],
			["Errors", "deadlock detected (14×)"],
			["Saturation", "Connections hit 57 / 60"],
			["Performance", "Unindexed foreign keys"],
		])
		expect(items[0]?.detail).toBe("Advisor · Table public.invoices is exposed")
		expect(items[1]?.detail).toBe("postgres logs")
	})

	test("the panel budget applies after ranking, so error logs are never hidden behind an advisor warning", () => {
		const errorLogs = ["a", "b", "c", "d", "e"].map((message) => issue(message, 17))
		const warnOnly = Schema.decodeUnknownSync(SupabaseProjectInsights)({
			...Schema.encodeSync(SupabaseProjectInsights)(insights),
			advisors: { error: [], warn: insights.advisors.warn, info: [] },
		})
		const shown = (inputs: Parameters<typeof needsAttention>[0]) =>
			needsAttention(inputs)
				.slice(0, MAX_ATTENTION_ITEMS)
				.map((item) => item.title)
		expect(shown({ insights: warnOnly, issues: errorLogs, connections: null })).toEqual([
			"a (14×)",
			"b (14×)",
			"c (14×)",
			"d (14×)",
			"e (14×)",
			"Unindexed foreign keys",
		])
		expect(shown({ insights, issues: [...errorLogs, issue("f", 17)], connections: null })).toEqual([
			"RLS disabled in public",
			"a (14×)",
			"b (14×)",
			"c (14×)",
			"d (14×)",
			"e (14×)",
		])
	})

	test("connections under 90% of the limit, or without a known limit, are not saturation", () => {
		const labels = (connections: { peak: number; limit: number | null }) =>
			needsAttention({ insights: null, issues: [], connections }).map((item) => item.label)
		expect(labels({ peak: 53, limit: 60 })).toEqual([])
		expect(labels({ peak: 540, limit: null })).toEqual([])
		expect(labels({ peak: 54, limit: 60 })).toEqual(["Saturation"])
	})

	test("nothing loaded and nothing wrong is nothing to attend to", () => {
		expect(needsAttention({ insights: null, issues: [], connections: null })).toEqual([])
	})
})
