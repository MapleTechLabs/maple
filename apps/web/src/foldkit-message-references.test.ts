import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { describe, expect, test } from "vitest"

// Guards `patches/foldkit@0.171.0.patch`. Unpatched, foldkit rebuilds every array and object field
// of a message, so live-sync rows arrive as new objects on each resend and reference caches
// (`reuseUnchangedRows`, row decode caches, lazy views) never hit. Drop this file only together
// with the patch, once upstream foldkit keeps references itself.

const Row = Schema.Struct({ id: Schema.String, value: Schema.Number })
const Child = defineMessageUnion({ Clicked: { id: Schema.String } })
const Message = defineMessageUnion({
	UpdatedRows: { rows: Schema.Array(Row) },
	GotChildMessage: { message: Child },
	Renamed: { name: Schema.String },
})

describe("foldkit message constructors (patched)", () => {
	test("a message keeps the caller's array and rows by reference", () => {
		const rows = [
			{ id: "a", value: 1 },
			{ id: "b", value: 2 },
		]
		const message = Message.UpdatedRows({ rows })
		expect(message.rows).toBe(rows)
		expect(message.rows[1]).toBe(rows[1])
		expect(message._tag).toBe("UpdatedRows")
	})

	test("a wrapped child message is the child itself", () => {
		const child = Child.Clicked({ id: "row-1" })
		expect(Message.GotChildMessage({ message: child }).message).toBe(child)
	})

	test("a payload that does not match its schema is still refused", () => {
		const rows = [{ id: "a", value: "one" }]
		// @ts-expect-error: the wrong field type is the point of the test.
		expect(() => Message.UpdatedRows({ rows })).toThrow()
	})

	test("primitive-only messages are unchanged", () => {
		expect(Message.Renamed({ name: "orders" })).toEqual({ _tag: "Renamed", name: "orders" })
	})
})
