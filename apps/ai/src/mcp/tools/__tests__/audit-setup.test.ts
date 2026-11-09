import { describe, expect, it } from "vitest"
import { Schema, Array as Arr, String as Str } from "effect"
import { AuditSetupOutput } from "@maple/domain/mcp-outputs"
import { PublicIdPrefixes, encodePublicId } from "@maple/domain/http/v2"
import type { AuditCheckResult, SetupAuditReport } from "@maple/domain/setup-audit"
import { renderToolDoc, type ToolDoc } from "../../lib/tool-doc"
import {
	byUrgency,
	clipWords,
	formatAffected,
	nextCallsOf,
	registerAuditSetupTool,
	toStructured,
} from "../audit-setup"
import type { McpToolRegistrar } from "../types"

let render: ((output: typeof AuditSetupOutput.Encoded) => ToolDoc) | undefined
const registrar: McpToolRegistrar = {
	define: (spec) => {
		render = (output) => spec.render(Schema.decodeSync(spec.output)(output))
	},
}
registerAuditSetupTool(registrar)

const RULE_UUID = "0b5c1f4e-7a39-4c47-9d2e-5f1a3b8c6d21"

const check = (overrides: Partial<AuditCheckResult> = {}): AuditCheckResult => ({
	id: "CFG-ALERT-01",
	category: "alerting",
	title: "At least one notification destination is enabled",
	severity: "warn",
	status: "fail",
	detail: null,
	affected: [],
	affectedCount: 0,
	fixHint: "Add a destination.",
	...overrides,
})

const report = (checks: ReadonlyArray<AuditCheckResult>, openRecommendationCount = 0): SetupAuditReport => ({
	generatedAt: Date.UTC(2026, 10, 9),
	dataStatus: "ok",
	warehouseAvailable: true,
	summary: { critical: 0, warn: checks.length, info: 0, pass: 0, skip: 0 },
	checks,
	openRecommendationCount,
})

const structured = (checks: ReadonlyArray<AuditCheckResult>, openRecommendationCount = 0) =>
	toStructured(report(checks, openRecommendationCount))

const unroutedRule = check({
	id: "CFG-ALERT-03",
	severity: "critical",
	affected: [
		{ kind: "alert_rule", id: RULE_UUID, name: "SLO burn: API", note: "no destinations selected" },
	],
	affectedCount: 1,
})
const silentErrorPolicy = check({ id: "CFG-NOTIF-01", category: "notifications" })
const orphanSpans = check({
	id: "TRC-01",
	category: "traces",
	affected: [
		{
			kind: "service",
			name: "maple-api",
			note: "23% of entry spans reference a parent that never arrived (e.g. trace 0000000000000000f6377067ada2a7cd)",
		},
	],
	affectedCount: 1,
})

describe("byUrgency", () => {
	it("puts findings first, then skipped, then passing", () => {
		const ordered = Arr.map(
			[
				check({ id: "a", status: "pass" }),
				check({ id: "b", status: "skip" }),
				check({ id: "c", status: "fail" }),
			].sort(byUrgency),
			(row) => row.id,
		)
		expect(ordered).toEqual(["c", "b", "a"])
	})

	it("orders findings critical before warn before info", () => {
		const ordered = Arr.map(
			[
				check({ id: "info", severity: "info" }),
				check({ id: "critical", severity: "critical" }),
				check({ id: "warn", severity: "warn" }),
			].sort(byUrgency),
			(row) => row.id,
		)
		expect(ordered).toEqual(["critical", "warn", "info"])
	})

	it("ranks a severity's checks by how many entities they name, entity-less ones last", () => {
		const ordered = Arr.map(
			[
				check({ id: "CFG-A", affectedCount: 0 }),
				check({ id: "CFG-B", affectedCount: 2 }),
				check({ id: "CFG-C", affectedCount: 9 }),
			].sort(byUrgency),
			(row) => row.id,
		)
		expect(ordered).toEqual(["CFG-C", "CFG-B", "CFG-A"])
	})

	it("falls back to the check id so the table is stable across runs", () => {
		const ordered = Arr.map([check({ id: "CFG-B" }), check({ id: "CFG-A" })].sort(byUrgency), (r) => r.id)
		expect(ordered).toEqual(["CFG-A", "CFG-B"])
	})
})

describe("clipWords", () => {
	it("never cuts a word in half", () => {
		const clipped = clipWords("then run update_error_notification_policy with enabled true", 30)
		expect(clipped).toBe("then run…")
	})

	it("prefers ending at a sentence boundary", () => {
		const clipped = clipWords(
			"Logs carry no trace id. Correlation from a trace to its logs is unavailable.",
			44,
		)
		expect(clipped).toBe("Logs carry no trace id. …")
	})
})

describe("clipWords abbreviations", () => {
	it("drops a clipped parenthetical whole instead of reading `e.g.` as a sentence end", () => {
		const note =
			"23% of entry spans reference a parent that never arrived (e.g. trace 0000000000000000f6377067ada2a7cd)"
		expect(clipWords(note, 64)).toBe("23% of entry spans reference a parent that never arrived…")
	})
})

describe("formatAffected", () => {
	it("renders a dash when nothing is named", () => {
		expect(formatAffected(structured([check()]).checks[0]!)).toBe("-")
	})

	it("shows an addressable entity's public id next to its name", () => {
		expect(formatAffected(structured([unroutedRule]).checks[0]!)).toBe(
			`SLO burn: API [${encodePublicId(PublicIdPrefixes.alertRule, RULE_UUID)}] (no destinations selected)`,
		)
	})

	it("prints a note shared by several entities once", () => {
		const affected = Arr.map(["a", "b"], (name) => ({
			kind: "service" as const,
			name,
			note: "traces only",
		}))
		expect(formatAffected(structured([check({ affected, affectedCount: 2 })]).checks[0]!)).toBe(
			"a, b (traces only)",
		)
	})

	it("shows at most three entities and counts the rest from the true total", () => {
		const affected = Arr.map(Arr.range(0, 2), (index) => ({
			kind: "alert_rule" as const,
			name: `rule-${index}`,
		}))
		// affectedCount exceeds affected.length because the registry caps the list at 20.
		const result = formatAffected(structured([check({ affected, affectedCount: 25 })]).checks[0]!)
		expect(result).toBe("rule-0, rule-1, rule-2; +22 more")
	})
})

describe("toStructured", () => {
	it("carries alert rule ids as the public ids the alert tools accept", () => {
		const [row] = structured([unroutedRule]).checks
		expect(row?.affected[0]?.id).toBe(encodePublicId(PublicIdPrefixes.alertRule, RULE_UUID))
	})

	it("leaves the id off entities that are not addressable resources", () => {
		const [row] = structured([orphanSpans]).checks
		expect(row?.affected[0]).not.toHaveProperty("id")
	})

	it("produces output that round-trips through the published schema", () => {
		const output = structured([unroutedRule, orphanSpans])
		const roundTripped = Schema.decodeSync(AuditSetupOutput)(Schema.encodeSync(AuditSetupOutput)(output))
		expect(roundTripped.checks[0]?.affected[0]?.id).toBe(output.checks[0]?.affected[0]?.id)
	})
})

describe("nextCallsOf", () => {
	const callsFor = (checks: ReadonlyArray<AuditCheckResult>, openRecommendations = 0) =>
		nextCallsOf(structured(checks).checks, openRecommendations)

	it("opens the unrouted alert rule by its id", () => {
		const [call] = callsFor([unroutedRule])
		expect(call?.tool).toBe("get_alert_rule")
		expect(call?.args).toEqual({ rule_id: encodePublicId(PublicIdPrefixes.alertRule, RULE_UUID) })
	})

	it("reads the error notification policy when it delivers nowhere", () => {
		expect(Arr.map(callsFor([silentErrorPolicy]), (call) => call.tool)).toEqual([
			"get_error_notification_policy",
		])
	})

	it("inspects the sampled trace named in the evidence", () => {
		const [call] = callsFor([orphanSpans])
		expect(call?.tool).toBe("inspect_trace")
		expect(call?.args).toEqual({ trace_id: "0000000000000000f6377067ada2a7cd" })
	})

	it("suggests no trace inspection when the evidence names no trace", () => {
		const withoutId = check({
			id: "TRC-02",
			category: "traces",
			affected: [{ kind: "service", name: "maple-api", note: "1.3% of traces have no root" }],
			affectedCount: 1,
		})
		expect(callsFor([withoutId])).toEqual([])
	})

	it("filters integrations to the one provider that fails, and widens when several do", () => {
		const cloudflare = check({
			id: "CFG-INTEG-02",
			category: "integrations",
			detail: "3 Cloudflare datasets failed.",
		})
		const planetscale = check({
			id: "CFG-INTEG-05",
			category: "integrations",
			detail: "PlanetScale has 1 problem.",
		})
		expect(callsFor([cloudflare])[0]?.args).toEqual({ provider: "cloudflare" })
		expect(callsFor([cloudflare, planetscale])[0]?.args).toEqual({})
	})

	it("keeps the most urgent five, one per tool", () => {
		const calls = callsFor(
			[
				unroutedRule,
				check({ id: "CFG-ALERT-05", affected: unroutedRule.affected, affectedCount: 1 }),
				silentErrorPolicy,
				orphanSpans,
				check({ id: "CFG-ALERT-04" }),
				check({ id: "CFG-ATTR-01", category: "attributes" }),
				check({ id: "CFG-INTEG-02", category: "integrations" }),
			],
			3,
		)
		expect(Arr.map(calls, (call) => call.tool)).toEqual([
			"get_alert_rule",
			"get_error_notification_policy",
			"inspect_trace",
			"list_alert_destinations",
			"get_instrumentation_recommendations",
		])
	})
})

describe("audit_setup render", () => {
	const renderChecks = (checks: ReadonlyArray<AuditCheckResult>) =>
		renderToolDoc(render!(Schema.encodeSync(AuditSetupOutput)(structured(checks))))

	it("prints a long fix hint whole, so the tool names it cites stay callable", () => {
		const fixHint =
			"Error notifications have no settings screen yet. Ask the Maple MCP to read the policy with " +
			"`get_error_notification_policy`, then run `update_error_notification_policy` with `enabled: true` " +
			"and at least one enabled destination from Alerts, Routing."
		const text = renderChecks([check({ id: "CFG-NOTIF-01", category: "notifications", fixHint })])
		expect(Str.includes(fixHint)(text)).toBe(true)
	})

	it("lists critical findings before warnings", () => {
		const text = renderChecks([orphanSpans, unroutedRule])
		expect(text.indexOf("CFG-ALERT-03")).toBeLessThan(text.indexOf("TRC-01"))
	})
})
