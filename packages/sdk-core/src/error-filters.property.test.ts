import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { type ErrorFilterHint, frameUrls, makeErrorFilter } from "./error-filters"

/** Stack-ish text: the characters the frame parser branches on, mixed with anything. */
const stackLine = fc.string({
	unit: fc.oneof(
		fc.constantFrom("(", ")", "@", ":", "/", " ", "at ", "https://", "1", "\t"),
		fc.string({ maxLength: 3 }),
	),
	maxLength: 60,
})
const stack = fc.array(stackLine, { maxLength: 30 }).map((lines) => lines.join("\n"))

const hint: ErrorFilterHint = { source: "captureException", originalError: undefined }

describe("frameUrls", () => {
	it("never throws, and every url it returns is a scheme url without spaces or parens", () => {
		fc.assert(
			fc.property(stack, (text) => {
				for (const url of frameUrls(text)) {
					expect(url).toMatch(/^[a-z][\w+.-]*:\/\//i)
					expect(url).not.toMatch(/[\s()]/)
				}
			}),
		)
	})

	it("reads the url of each well-formed frame, in order", () => {
		const url = fc
			.webUrl({ withQueryParameters: false, withFragments: false })
			.filter((u) => !/[\s()@]/.test(u))
		fc.assert(
			fc.property(fc.array(fc.tuple(url, fc.nat(9999), fc.nat(9999)), { maxLength: 8 }), (frames) => {
				const text = frames
					.map(([u, line, col], i) =>
						i % 2 ? `fn@${u}:${line}:${col}` : `    at f (${u}:${line}:${col})`,
					)
					.join("\n")
				expect(frameUrls(text)).toEqual(frames.map(([u]) => u))
			}),
		)
	})

	it("stays linear on hostile stacks", () => {
		// Shapes that make a backtracking pattern go polynomial: long runs of the delimiters.
		const hostile = [
			"(".repeat(200_000),
			`at ${":1".repeat(100_000)}`,
			`${"@".repeat(100_000)}:1:1`,
			`https://${"a:".repeat(100_000)}x)`,
			Array.from({ length: 50_000 }, () => "at (x:1").join("\n"),
		]
		for (const text of hostile) {
			const started = performance.now()
			frameUrls(text)
			expect(performance.now() - started).toBeLessThan(500)
		}
	})
})

describe("makeErrorFilter", () => {
	it("answers the same on repeated calls with stateful g/y patterns", () => {
		fc.assert(
			fc.property(
				fc.string(),
				fc.constantFrom("g", "y", "gy", ""),
				fc.string({ maxLength: 4 }),
				(message, flags, needle) => {
					const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
					const filter = makeErrorFilter({
						ignore: [new RegExp(escaped, flags)],
						defaultFilters: false,
					})
					const error = new Error(message)
					const first = filter(error, hint)
					expect(filter(error, hint)).toBe(first)
					expect(filter(error, hint)).toBe(first)
				},
			),
		)
	})

	it("keeps the error when beforeCapture throws, whatever it throws", () => {
		fc.assert(
			fc.property(fc.anything(), fc.string(), (thrown, message) => {
				const filter = makeErrorFilter({
					defaultFilters: false,
					beforeCapture: () => {
						throw thrown
					},
				})
				expect(filter(new Error(message), hint)).toBe(true)
			}),
		)
	})
})
