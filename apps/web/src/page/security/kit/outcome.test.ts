import type { SecurityAuditEvent, SecurityAuditUnit } from "@maple/domain/http"
import { describe, expect, it } from "vitest"
import {
	eventLineOf,
	leadsLine,
	matchesEventFilter,
	plainName,
	stopNoteOf,
	stopSummaryOf,
	unitContext,
	unitName,
} from "./outcome"

const event = (fields: Partial<SecurityAuditEvent>): SecurityAuditEvent => ({
	id: "evt",
	at: 0,
	kind: "Agent",
	role: null,
	agentId: null,
	outcome: null,
	message: null,
	phase: null,
	detail: null,
	costUsd: null,
	inputTokens: null,
	outputTokens: null,
	...fields,
})

const unit = (fields: Partial<SecurityAuditUnit>): SecurityAuditUnit => ({
	coverageId: "u-1",
	status: "covered",
	wave: 1,
	agentId: null,
	stale: false,
	subsystem: null,
	surface: null,
	boundary: null,
	attackClass: null,
	priorStatus: null,
	priority: null,
	failedAttempts: null,
	resultFingerprints: [],
	carriedFingerprint: null,
	unresolved: [],
	...fields,
})

describe("stopNoteOf", () => {
	it("leads with the first reason, lists the rest, and counts the gaps", () => {
		const note = stopNoteOf(
			"critic_unavailable: post-wave critic after wave 2; record_verification_incomplete; org_budget_unavailable",
			28,
		)
		expect(note.title).toBe("Stopped adding units after wave 2")
		expect(note.body).toContain("Also: a lead was not re-checked; billing could not be reached.")
		expect(note.body).toContain("28 units were not audited and are listed as gaps.")
		expect(note.action).toBe("start")
	})

	it("keeps an engine detail that is itself a list inside its own reason", () => {
		const note = stopNoteOf(
			"findings_failed_validation: records[0].trace is empty; records[2].title is empty; org_budget_unavailable",
			0,
		)
		expect(note.body).not.toContain("records[2].title is empty.")
		expect(note.body).toContain("Also: billing could not be reached.")
	})

	it("reads a failure under the run louder than a limit the run followed", () => {
		expect([
			stopNoteOf("org_budget_unavailable", 0).tone,
			stopNoteOf("org_spend_limit_reached", 3).tone,
			stopNoteOf("budget_cannot_fund_a_hunter", 0).tone,
		]).toEqual(["crit", "warn", "warn"])
	})

	it("offers the control that fixes the stop", () => {
		expect([
			stopNoteOf("org_spend_limit_reached", 0).action,
			stopNoteOf("budget_cannot_fund_a_hunter", 0).action,
			stopNoteOf("org_no_ai_credits", 0).action,
			stopNoteOf("reconnaissance_synthesis_failed", 0).action,
		]).toEqual(["limit", "settings", null, "start"])
	})

	it("keeps an unknown code readable instead of hiding it", () => {
		const note = stopNoteOf("sandbox_quota_hit", 1)
		expect(note.body).toBe(
			"The run ended early: sandbox quota hit. 1 unit was not audited and is listed as a gap.",
		)
		expect(stopNoteOf(null, 0).body).toBe("The run ended early: stopped early.")
	})

	it("tells the final coverage review apart from a post-wave one", () => {
		expect(stopNoteOf("critic_unavailable: final-clean critic", 0).title).toBe(
			"The final coverage review failed",
		)
	})
})

describe("stopSummaryOf", () => {
	it("is one line: the first reason and how many more", () => {
		expect([
			stopSummaryOf("critic_unavailable: post-wave critic after wave 3; org_budget_unavailable"),
			stopSummaryOf("org_spend_limit_reached"),
			stopSummaryOf(null),
		]).toEqual([
			"coverage review failed after wave 3 · +1 more",
			"reached the monthly spend limit",
			"stopped early",
		])
	})
})

describe("leadsLine", () => {
	it("drops the side that is zero", () => {
		expect([leadsLine(2, 6), leadsLine(0, 6), leadsLine(3, 0), leadsLine(0, 0)]).toEqual([
			"2 confirmed · 6 to validate",
			"6 to validate",
			"3 confirmed",
			"none open",
		])
	})
})

describe("unit names", () => {
	it("reads skill anchors and file entry points as plain names", () => {
		expect([
			plainName("ATTACK-CLASSES.md#Injection"),
			plainName("ATTACK-CLASSES.md#Broken-Access-Control"),
			plainName("src/share/routes.ts#GET /share/:token"),
			plainName("open redirect"),
		]).toEqual(["Injection", "Broken Access Control", "GET /share/:token", "open redirect"])
	})

	it("titles a unit by its surface, with subsystem and attack class under it", () => {
		const decoded = unit({
			subsystem: "query engine",
			surface: "src/sql/run.ts#POST raw sql",
			attackClass: "ATTACK-CLASSES.md#Injection",
		})
		expect([unitName(decoded), unitContext(decoded)]).toEqual([
			"POST raw sql",
			"query engine · Injection",
		])
	})

	it("falls back to the subsystem, then the coverage id", () => {
		const noSurface = unit({ subsystem: "exports", attackClass: "ATTACK-CLASSES.md#Injection" })
		expect([unitName(noSurface), unitContext(noSurface), unitName(unit({}))]).toEqual([
			"exports",
			"Injection",
			"u-1",
		])
	})
})

describe("eventLineOf", () => {
	it("writes agent outcomes as sentences and flags the ones that went wrong", () => {
		const discarded = eventLineOf(
			event({
				role: "critic",
				agentId: "critic-w2-post",
				outcome: "discarded",
				message: "result broke its contract at: missing_units[3]",
			}),
		)
		const finished = eventLineOf(event({ role: "hunter", agentId: "hunter-w1-8", outcome: "ok" }))
		expect([discarded.sentence, discarded.meta, discarded.isProblem]).toEqual([
			"Coverage review answer discarded: its answer did not match the format at missing_units[3]",
			"critic-w2-post",
			true,
		])
		expect([finished.sentence, finished.isProblem]).toEqual(["Hunter finished", false])
	})

	it("turns the engine's notes into plain words", () => {
		expect([
			eventLineOf(event({ kind: "Note", message: "incomplete: record_verification_incomplete" }))
				.sentence,
			eventLineOf(event({ kind: "Note", message: "hunter-w3-1 not run: spend could not be read" }))
				.sentence,
		]).toEqual([
			"Stopping early: a lead was not re-checked.",
			"Agent hunter-w3-1 was not started: spend could not be read",
		])
	})

	it("files validation work under Leads and failures under Problems", () => {
		const verifier = eventLineOf(event({ role: "candidate-verifier", outcome: "ok" }))
		const phase = eventLineOf(
			event({ kind: "Phase", phase: "candidate-validation", message: "Validating" }),
		)
		const failed = eventLineOf(event({ role: "hunter", outcome: "failed", message: "timed out" }))
		expect([
			matchesEventFilter(verifier, "leads"),
			matchesEventFilter(phase, "leads"),
			matchesEventFilter(failed, "leads"),
			matchesEventFilter(failed, "problems"),
			matchesEventFilter(verifier, "problems"),
			matchesEventFilter(verifier, "all"),
		]).toEqual([true, true, false, true, false, true])
	})
})
