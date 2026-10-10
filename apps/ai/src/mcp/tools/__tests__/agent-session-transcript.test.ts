import { describe, expect, it } from "vitest"
import type { AgentTranscriptRow } from "@maple/domain/mcp-outputs"
import { distinguishingOpenings, earliestFailure, failureTimeline } from "../get-agent-session-transcript"

type Row = typeof AgentTranscriptRow.Type

const span = (id: string) => ({ spanId: id, traceId: "t", timestamp: "2026-10-10T01:55:00.000Z" })

describe("failureTimeline", () => {
	it("puts a run's stop after the steps that stopped it when they share a moment", () => {
		const rows: ReadonlyArray<Row> = [
			{
				kind: "turn",
				depth: 0,
				turn: 2,
				offsetMs: 10_000,
				durationMs: 44_400,
				failed: true,
				...span("anchor"),
			},
			{
				kind: "tool",
				depth: 1,
				turn: 2,
				offsetMs: 54_400,
				failed: true,
				toolName: "sandbox_exec",
				...span("step"),
			},
			{
				kind: "tool",
				depth: 0,
				turn: 5,
				offsetMs: 43_100,
				failed: true,
				toolName: "sandbox_exec",
				...span("cause"),
			},
		]
		expect(failureTimeline(rows).map((row) => row.spanId)).toEqual(["cause", "step", "anchor"])
	})
})

describe("earliestFailure", () => {
	it("dates a stopped run by when it stopped, not when it started", () => {
		const rows: ReadonlyArray<Row> = [
			{
				kind: "turn",
				depth: 0,
				turn: 2,
				offsetMs: 5_000,
				durationMs: 40_000,
				failed: true,
				...span("stopped-run"),
			},
			{ kind: "tool", depth: 0, turn: 3, offsetMs: 15_100, failed: true, ...span("first-step") },
		]
		expect(earliestFailure(rows)?.spanId).toBe("first-step")
	})
})

describe("distinguishingOpenings", () => {
	const brief =
		"Pull request #1358 of MapleTechLabs/maple, head 5f964beceffb73c5fb0ea63b3e8b76de. Review these files: "
	const turn = (n: number, agentName: string) => ({
		turn: n,
		anchorKind: "agent-root" as const,
		agentName,
		offsetMs: 0,
		durationMs: 1,
		failed: false,
	})

	it("drops the brief sub-agents share, so each one's own part leads", () => {
		const turns = [turn(1, "pr-review"), turn(2, "worker"), turn(3, "worker")]
		const rows: ReadonlyArray<Row> = [
			{ kind: "user", depth: 0, turn: 1, text: "Review PR #1358" },
			{ kind: "user", depth: 0, turn: 2, text: `${brief}src/a.ts, src/b.ts` },
			{ kind: "user", depth: 0, turn: 3, text: `${brief}src/c.ts` },
		]
		const openings = distinguishingOpenings(turns, rows)
		expect(openings.get(1)).toBe("Review PR #1358")
		expect(openings.get(2)).toBe("…src/a.ts, src/b.ts")
		expect(openings.get(3)).toBe("…src/c.ts")
	})

	it("keeps an opening whole when siblings share too little to strip", () => {
		const turns = [turn(2, "worker"), turn(3, "worker")]
		const rows: ReadonlyArray<Row> = [
			{ kind: "user", depth: 0, turn: 2, text: "Fix the a bug" },
			{ kind: "user", depth: 0, turn: 3, text: "Fix the b bug" },
		]
		expect(distinguishingOpenings(turns, rows).get(2)).toBe("Fix the a bug")
	})
})
