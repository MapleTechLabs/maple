import { describe, expect, it } from "vitest"
import type { UIMessage } from "@flue/react"
import { makeUserMessage, mergeUserMessages, type UserLogEntry } from "./flue-user-log"

const assistant = (id: string): UIMessage => ({ id, role: "assistant", parts: [] })
const entry = (n: number, turnsBefore: number): UserLogEntry => ({
	id: `c:user:${n}`,
	text: `message ${n}`,
	turnsBefore,
})

const shape = (messages: UIMessage[]) =>
	messages.map((m) => ({
		role: m.role,
		id: m.id,
		text: m.parts.map((p) => (p.type === "text" ? p.text : `<${p.type}>`)).join(""),
	}))

describe("mergeUserMessages", () => {
	it("returns nothing for an empty conversation", () => {
		expect(mergeUserMessages([], [])).toEqual([])
	})

	it("shows a just-sent user message before any assistant turn exists", () => {
		const merged = mergeUserMessages([], [entry(0, 0)])
		expect(shape(merged)).toEqual([{ role: "user", id: "c:user:0", text: "message 0" }])
	})

	it("interleaves single-turn exchanges in order", () => {
		const flue = [assistant("turn:a0"), assistant("turn:a1")]
		const log = [entry(0, 0), entry(1, 1)]
		expect(shape(mergeUserMessages(flue, log)).map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
		])
	})

	it("keeps a user message before all assistant turns of a multi-turn (tool-using) submission", () => {
		// u0 → 3 assistant turns (a0,a1,a2); u1 (turnsBefore=3) → a3
		const flue = [assistant("turn:a0"), assistant("turn:a1"), assistant("turn:a2"), assistant("turn:a3")]
		const log = [entry(0, 0), entry(1, 3)]
		expect(shape(mergeUserMessages(flue, log)).map((m) => m.id)).toEqual([
			"c:user:0",
			"turn:a0",
			"turn:a1",
			"turn:a2",
			"c:user:1",
			"turn:a3",
		])
	})

	it("is order-stable across reload (same inputs → same interleave)", () => {
		const flue = [assistant("turn:a0"), assistant("turn:a1"), assistant("turn:a2")]
		const log = [entry(0, 0), entry(1, 2)]
		expect(shape(mergeUserMessages(flue, log))).toEqual(shape(mergeUserMessages(flue, log)))
	})

	it("appends a trailing user message whose assistant turn hasn't started yet", () => {
		const flue = [assistant("turn:a0")]
		const log = [entry(0, 0), entry(1, 1)] // u1 sent, assistant not started
		expect(shape(mergeUserMessages(flue, log)).map((m) => m.id)).toEqual([
			"c:user:0",
			"turn:a0",
			"c:user:1",
		])
	})

	it("drops Flue's transient optimistic/echoed user messages, rendering our own", () => {
		const flue: UIMessage[] = [
			{ id: "local:maple-chat:c:1", role: "user", parts: [{ type: "text", text: "dupe" }] },
			assistant("turn:a0"),
		]
		const log = [entry(0, 0)]
		const merged = mergeUserMessages(flue, log)
		expect(merged.filter((m) => m.role === "user").map((m) => m.id)).toEqual(["c:user:0"])
	})
})

describe("makeUserMessage", () => {
	it("builds a Flue-shaped user message with a done text part", () => {
		expect(makeUserMessage(entry(0, 0))).toEqual({
			id: "c:user:0",
			role: "user",
			parts: [{ type: "text", text: "message 0", state: "done" }],
		})
	})
})
