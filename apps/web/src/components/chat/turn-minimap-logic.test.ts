import { describe, expect, it } from "vitest"

import { buildTranscriptRows } from "./transcript-rows"
import { wrapContextPreamble } from "./context-preamble"
import {
	deriveTurnMinimap,
	minimapHasPersistentGutter,
	minimapHitStripWidth,
	minimapIndexFromPointer,
	minimapPreviewTranslate,
	minimapTopPercent,
	resolveCurrentTurnIndex,
} from "./turn-minimap-logic"
import type { UIMessage } from "@/components/ai-elements/types"

const text = (id: string, role: "user" | "assistant", body: string): UIMessage =>
	({ id, role, parts: [{ type: "text", text: body }] }) as UIMessage

// SAFETY: this fixture constructs the tool-only message variant the row builder merges.
const tools = (id: string): UIMessage =>
	({
		id,
		role: "assistant",
		parts: [
			{
				type: "tool-list_services",
				toolCallId: `${id}-0`,
				state: "output-available",
				input: {},
				output: { ok: true },
			},
		],
	}) as unknown as UIMessage

describe("deriveTurnMinimap", () => {
	it("marks one turn per user message and carries the turn's last reply", () => {
		const rows = buildTranscriptRows([
			text("u1", "user", "why is checkout slow"),
			text("a1", "assistant", "looking"),
			text("a2", "assistant", "the db pool is exhausted"),
			text("u2", "user", "how do I fix it"),
			text("a3", "assistant", "raise the pool size"),
		])

		const { items } = deriveTurnMinimap(rows)

		expect(items.map((item) => item.id)).toEqual(["u1", "u2"])
		expect(items[0]!.userText).toBe("why is checkout slow")
		expect(items[0]!.assistantText).toBe("the db pool is exhausted")
		expect(items[1]!.assistantText).toBe("raise the pool size")
	})

	it("attributes a merged tool-run row to the turn that opened it", () => {
		const rows = buildTranscriptRows([
			text("u1", "user", "investigate"),
			tools("m1"),
			tools("m2"),
			text("a1", "assistant", "done"),
		])

		const { items, turnByRowId } = deriveTurnMinimap(rows)

		expect(items).toHaveLength(1)
		// The burst registers with the scroller under its first message's id.
		expect(turnByRowId.get("m1")).toBe(0)
		expect(turnByRowId.get("a1")).toBe(0)
	})

	it("skips a server-seeded machine turn", () => {
		const rows = buildTranscriptRows([
			text("u0", "user", wrapContextPreamble("Investigation context", "")),
			text("a0", "assistant", "starting"),
			text("u1", "user", "what happened"),
		])

		const { items, turnByRowId } = deriveTurnMinimap(rows)

		expect(items.map((item) => item.id)).toEqual(["u1"])
		// Rows before the first human turn belong to no marker.
		expect(turnByRowId.has("u0")).toBe(false)
	})

	it("collapses whitespace in previews and drops empty ones", () => {
		const rows = buildTranscriptRows([text("u1", "user", "  why   is\n\nit slow  ")])

		const { items } = deriveTurnMinimap(rows)

		expect(items[0]!.userText).toBe("why is it slow")
		expect(items[0]!.assistantText).toBeNull()
	})
})

describe("resolveCurrentTurnIndex", () => {
	const turnByRowId = new Map([
		["u1", 0],
		["a1", 0],
		["u2", 1],
	])

	it("is the earliest turn with a row on screen", () => {
		expect(resolveCurrentTurnIndex(["u2", "a1"], turnByRowId)).toBe(0)
	})

	it("is null when nothing on screen belongs to a turn", () => {
		expect(resolveCurrentTurnIndex(["__status"], turnByRowId)).toBeNull()
	})
})

describe("rail geometry", () => {
	it("spreads markers evenly and clamps out-of-range indices", () => {
		expect(minimapTopPercent(0, 5)).toBe(0)
		expect(minimapTopPercent(2, 5)).toBe(50)
		expect(minimapTopPercent(9, 5)).toBe(100)
		expect(minimapTopPercent(0, 1)).toBe(0)
	})

	it("maps a pointer position to the nearest marker", () => {
		const rail = { itemCount: 5, railTop: 100, railHeight: 200 }

		expect(minimapIndexFromPointer({ ...rail, pointerY: 100 })).toBe(0)
		expect(minimapIndexFromPointer({ ...rail, pointerY: 200 })).toBe(2)
		expect(minimapIndexFromPointer({ ...rail, pointerY: 900 })).toBe(4)
		expect(minimapIndexFromPointer({ ...rail, railHeight: 0, pointerY: 120 })).toBeNull()
	})

	it("shows the rail permanently only when the gutter can hold it", () => {
		expect(minimapHasPersistentGutter(1440)).toBe(true)
		expect(minimapHasPersistentGutter(820)).toBe(false)
		expect(minimapHasPersistentGutter(0)).toBe(false)
	})

	it("never lets the hover strip reach into the transcript column", () => {
		expect(minimapHitStripWidth(1440)).toBe(40)
		expect(minimapHitStripWidth(800)).toBe(4)
		expect(minimapHitStripWidth(768)).toBe(0)
	})

	it("keeps the preview inside the rail at both ends", () => {
		expect(minimapPreviewTranslate(0, 4)).toBe("0%")
		expect(minimapPreviewTranslate(1, 4)).toBe("-50%")
		expect(minimapPreviewTranslate(3, 4)).toBe("-100%")
	})
})
