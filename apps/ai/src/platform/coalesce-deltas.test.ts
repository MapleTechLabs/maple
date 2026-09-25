/**
 * Joined deltas carry the same text in fewer parts, and never cross a part or a kind.
 */
import { Effect, Stream } from "effect"
import { Response } from "effect/unstable/ai"
import { assert, describe, it } from "vitest"
import { COALESCED_DELTA_CHARS, coalesceDeltas } from "./coalesce-deltas"

const run = (parts: ReadonlyArray<Response.AnyPart>) =>
	Effect.runPromise(Stream.runCollect(coalesceDeltas(Stream.fromIterable(parts))))

describe("coalesceDeltas", () => {
	it("joins a part's deltas and keeps every other part in order", async () => {
		const out = await run([
			Response.makePart("reasoning-start", { id: "r" }),
			Response.makePart("reasoning-delta", { id: "r", delta: "Let " }),
			Response.makePart("reasoning-delta", { id: "r", delta: "me " }),
			Response.makePart("reasoning-delta", { id: "r", delta: "check." }),
			Response.makePart("reasoning-end", { id: "r" }),
			Response.makePart("text-delta", { id: "t", delta: "Done" }),
			Response.makePart("text-delta", { id: "t", delta: "." }),
		])
		assert.deepEqual(
			out.map((part) => part.type),
			["reasoning-start", "reasoning-delta", "reasoning-end", "text-delta"],
		)
		assert.equal(out[1]!.type === "reasoning-delta" ? out[1]!.delta : "", "Let me check.")
		// The last delta is flushed when the stream ends.
		assert.equal(out[3]!.type === "text-delta" ? out[3]!.delta : "", "Done.")
	})

	it("never joins two parts, two kinds, or past the size bound", async () => {
		const big = "x".repeat(COALESCED_DELTA_CHARS)
		const out = await run([
			Response.makePart("text-delta", { id: "a", delta: "1" }),
			Response.makePart("text-delta", { id: "b", delta: "2" }),
			Response.makePart("reasoning-delta", { id: "b", delta: "3" }),
			Response.makePart("reasoning-delta", { id: "b", delta: big }),
		])
		assert.equal(out.length, 4)
	})
})
