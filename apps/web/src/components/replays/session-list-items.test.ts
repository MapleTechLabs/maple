import { describe, expect, it } from "vitest"
import type { SessionTag } from "@maple/domain/query-engine"
import { sessionListItems } from "./session-list-items"

const at = (id: string, tags: ReadonlyArray<SessionTag>, errorCount = 0) => ({
	sessionId: id,
	status: "ended",
	startTime: "2026-09-27 12:00:00",
	lastActivityAt: "2026-09-27 12:00:05",
	errorCount,
	tags,
})

const nowMs = Date.parse("2026-09-27T13:00:00Z")
const rowIds = (items: ReturnType<typeof sessionListItems>) =>
	items.map((item) => (item.kind === "quiet" ? `quiet:${item.count}` : item.session.sessionId))

describe("sessionListItems", () => {
	const sessions = [
		at("a", ["engaged"]),
		at("b", ["bot"]),
		at("c", ["bounce", "new_visitor"]),
		at("d", ["bot"]),
		at("e", ["engaged", "signed_in"]),
		at("f", ["idle"]),
		at("g", ["engaged"]),
	]

	it("folds runs of two or more low-signal sessions and leaves a lone one inline", () => {
		const items = sessionListItems(sessions, { collapse: true, expanded: new Set(), nowMs })
		expect(rowIds(items)).toEqual(["a", "quiet:3", "e", "f", "g"])
		const lone = items[3]
		expect(lone?.kind === "session" && lone.lowSignal).toBe(true)
	})

	it("summarizes a run by tier, most common first", () => {
		const items = sessionListItems(sessions, { collapse: true, expanded: new Set(), nowMs })
		const quiet = items.find((item) => item.kind === "quiet")
		expect(quiet?.kind === "quiet" && quiet.summary).toBe("2 bots · 1 bounce")
	})

	it("lists an expanded run's sessions under its summary", () => {
		const items = sessionListItems(sessions, { collapse: true, expanded: new Set(["b"]), nowMs })
		expect(rowIds(items)).toEqual(["a", "quiet:3", "b", "c", "d", "e", "f", "g"])
	})

	it("never folds a session with errors", () => {
		const items = sessionListItems([at("a", ["bot"]), at("b", ["bot"], 2), at("c", ["bot"])], {
			collapse: true,
			expanded: new Set(),
			nowMs,
		})
		expect(rowIds(items)).toEqual(["a", "b", "c"])
	})

	it("keeps every row when collapsing is off", () => {
		const items = sessionListItems(sessions, { collapse: false, expanded: new Set(), nowMs })
		expect(rowIds(items)).toEqual(["a", "b", "c", "d", "e", "f", "g"])
	})
})
