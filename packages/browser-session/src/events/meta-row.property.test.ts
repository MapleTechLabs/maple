// TEST-SEAM: the transport posts over the network; this captures the exact body it would send.
import fc from "fast-check"
import { describe, expect, it, vi } from "vitest"

const posted: string[] = []
vi.mock("../platform/transport", () => ({
	ingestHeaders: () => ({}),
	postToIngest: async (_url: string, _headers: unknown, body: string) => {
		posted.push(body)
	},
}))

const { buildSessionMetaRow, formatCHDateTime, postSessionMetaRow } = await import("./meta-row")

const isWellFormed = (text: string): boolean =>
	!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)

/** Every string anywhere in a parsed JSON value, keys included. */
function strings(value: unknown): string[] {
	if (typeof value === "string") return [value]
	if (typeof value !== "object" || value === null) return []
	return Object.entries(value).flatMap(([key, child]) => [key, ...strings(child)])
}

/** Strings that may hold half an emoji, the way user input and truncation produce them. */
const text = fc.string({ unit: "binary", maxLength: 40 })
const url = fc.oneof(fc.webUrl({ withQueryParameters: true, withFragments: true }), text)

const CH_DATE_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/

describe("postSessionMetaRow", () => {
	it("posts a line every string of which is well-formed, whatever the host app passed", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.record({
					sessionId: text,
					serviceName: text,
					userId: text,
					entryUrl: url,
					referrer: url,
					lastUrl: url,
					id: text,
					email: text,
					username: text,
					traitKey: text,
					traitValue: text,
				}),
				async (input) => {
					posted.length = 0
					const row = buildSessionMetaRow({
						sessionId: input.sessionId,
						startedAt: new Date(0),
						version: 1,
						status: "ended",
						serviceName: input.serviceName,
						userId: input.userId,
						recorded: false,
						entry: { entryUrl: input.entryUrl, referrer: input.referrer, utm: {} },
						lastUrl: input.lastUrl,
						// Deliberately not normalized: the serializer is the last line of defence.
						identity: {
							id: input.id,
							email: input.email,
							username: input.username,
							traits: { [input.traitKey]: input.traitValue },
						},
					})
					await postSessionMetaRow(
						{ endpoint: "https://ingest.test", ingestKey: "k", sdk: "t" },
						row,
					)
					expect(posted).toHaveLength(1)
					const line = posted[0] ?? ""
					expect(line.endsWith("\n")).toBe(true)
					expect(line.slice(0, -1)).not.toContain("\n")
					for (const value of strings(JSON.parse(line))) expect(isWellFormed(value)).toBe(true)
				},
			),
		)
	})
})

describe("buildSessionMetaRow", () => {
	it("never puts a query or fragment in the entry and exit paths", () => {
		fc.assert(
			fc.property(url, url, (entryUrl, lastUrl) => {
				const row = buildSessionMetaRow({
					sessionId: "s",
					startedAt: new Date(0),
					version: 1,
					status: "active",
					serviceName: "svc",
					recorded: false,
					entry: { entryUrl, referrer: "", utm: {} },
					lastUrl,
				})
				for (const path of [row.entry_path, row.exit_path]) {
					expect(typeof path).toBe("string")
					expect(String(path)).not.toMatch(/[?#]/)
				}
			}),
		)
	})
})

describe("formatCHDateTime", () => {
	it("writes YYYY-MM-DD HH:MM:SS.mmm in UTC and round-trips every four-digit-year date", () => {
		fc.assert(
			fc.property(
				fc.date({
					min: new Date("0000-01-01T00:00:00.000Z"),
					max: new Date("9999-12-31T23:59:59.999Z"),
					noInvalidDate: true,
				}),
				(date) => {
					const formatted = formatCHDateTime(date)
					expect(formatted).toMatch(CH_DATE_TIME)
					expect(new Date(`${formatted.replace(" ", "T")}Z`).getTime()).toBe(date.getTime())
				},
			),
		)
	})
})
