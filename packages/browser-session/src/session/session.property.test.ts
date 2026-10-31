import fc from "fast-check"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parseJsonObject } from "../platform/json"
import { resetPersistenceForTests } from "../platform/persistence"
import { resetVisitorCacheForTests } from "../identity/visitor"
import {
	getSession,
	nextChunkSeq,
	nextMetaVersion,
	peekSession,
	resetSessionStorageStateForTests,
	resetTabLeaseForTests,
	rotateSession,
	type SessionRecord,
} from "./session"

class FakeStorage {
	private store = new Map<string, string>()
	getItem(key: string): string | null {
		return this.store.get(key) ?? null
	}
	setItem(key: string, value: string): void {
		this.store.set(key, value)
	}
	removeItem(key: string): void {
		this.store.delete(key)
	}
	key(index: number): string | null {
		return [...this.store.keys()][index] ?? null
	}
	get length(): number {
		return this.store.size
	}
	clear(): void {
		this.store.clear()
	}
}

const MINUTE = 60_000
let storage: FakeStorage

beforeEach(() => {
	vi.useFakeTimers()
	vi.setSystemTime(new Date("2026-05-22T12:00:00Z"))
	resetVisitorCacheForTests()
	resetSessionStorageStateForTests()
	resetTabLeaseForTests()
	storage = new FakeStorage()
	vi.stubGlobal("window", { sessionStorage: storage, localStorage: new FakeStorage() })
	vi.stubGlobal("document", { cookie: "" })
})

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
	resetPersistenceForTests()
})

type Step =
	| { kind: "chunk" | "meta"; past: number | undefined }
	| { kind: "rotate" | "idle" | "reload" | "clear" | "wait" }

const step: fc.Arbitrary<Step> = fc.oneof(
	fc.record({
		kind: fc.constantFrom("chunk" as const, "meta" as const),
		past: fc.option(fc.nat(5), { nil: undefined }),
	}),
	fc.record({
		kind: fc.constantFrom(
			"rotate" as const,
			"idle" as const,
			"reload" as const,
			"clear" as const,
			"wait" as const,
		),
	}),
)

describe("session counters", () => {
	it("strictly increase per session id under any interleaving of rotation, reloads and storage clears", () => {
		fc.assert(
			fc.property(fc.array(step, { maxLength: 60 }), (steps) => {
				resetSessionStorageStateForTests()
				resetTabLeaseForTests()
				storage.clear()
				const seen: string[] = [getSession().id]
				const issued = new Map<string, { chunks: number[]; versions: number[] }>()
				const take = (id: string, kind: "chunk" | "meta") => {
					const value = kind === "chunk" ? nextChunkSeq(id) : nextMetaVersion(id)
					if (value === undefined) return
					const entry = issued.get(id) ?? { chunks: [], versions: [] }
					;(kind === "chunk" ? entry.chunks : entry.versions).push(value)
					issued.set(id, entry)
				}
				for (const current of steps) {
					switch (current.kind) {
						case "chunk":
						case "meta": {
							// The live session, or a writer of an earlier one flushing late.
							const id =
								current.past === undefined
									? getSession().id
									: seen[Math.max(0, seen.length - 1 - current.past)]!
							take(id, current.kind)
							break
						}
						case "rotate":
							rotateSession()
							break
						case "idle":
							vi.advanceTimersByTime(31 * MINUTE)
							getSession()
							break
						case "reload":
							resetSessionStorageStateForTests()
							resetTabLeaseForTests()
							break
						case "clear":
							storage.clear()
							break
						case "wait":
							vi.advanceTimersByTime(MINUTE)
							break
					}
					const id = peekSession()?.id
					if (id !== undefined && seen.at(-1) !== id) seen.push(id)
				}
				for (const { chunks, versions } of issued.values()) {
					for (let i = 1; i < chunks.length; i++) expect(chunks[i]!).toBeGreaterThan(chunks[i - 1]!)
					for (let i = 1; i < versions.length; i++)
						expect(versions[i]!).toBeGreaterThan(versions[i - 1]!)
				}
			}),
			{ numRuns: 300 },
		)
	})
})

describe("stored session record decoding", () => {
	it("never throws on any JSON in storage, and yields only well-typed records", () => {
		fc.assert(
			fc.property(fc.oneof(fc.json(), fc.string()), (raw) => {
				resetSessionStorageStateForTests()
				storage.setItem("maple.session", raw)
				const record = peekSession()
				if (record === undefined) return
				// Only a JSON object carrying the four required fields, typed, is accepted.
				const parsed = parseJsonObject(raw)
				expect({
					id: record.id,
					startedAt: record.startedAt,
					lastActivityAt: record.lastActivityAt,
					chunkSeq: record.chunkSeq,
				}).toEqual({
					id: parsed?.id,
					startedAt: parsed?.startedAt,
					lastActivityAt: parsed?.lastActivityAt,
					chunkSeq: parsed?.chunkSeq,
				})
				expect([typeof record.id, typeof record.startedAt, typeof record.chunkSeq]).toEqual([
					"string",
					"number",
					"number",
				])
			}),
			{ numRuns: 500 },
		)
	})

	const record: fc.Arbitrary<SessionRecord> = fc.record(
		{
			id: fc.string({ minLength: 1 }),
			startedAt: fc.integer(),
			lastActivityAt: fc.integer(),
			chunkSeq: fc.nat(),
			metaVersion: fc.nat(),
			billable: fc.boolean(),
			entryUrl: fc.string(),
			entryReferrer: fc.string(),
			utm: fc.dictionary(fc.string(), fc.string()),
			visitorIsNew: fc.boolean(),
			lastUrl: fc.string(),
			pageViews: fc.nat(),
			clickCount: fc.nat(),
			errorCount: fc.nat(),
			replaySampled: fc.boolean(),
			replayBuffered: fc.boolean(),
			replayTrigger: fc.constant("error" as const),
			replayHalted: fc.boolean(),
		},
		{ requiredKeys: ["id", "startedAt", "lastActivityAt", "chunkSeq"] },
	)

	it("reads back exactly what was stored, ignoring keys a newer SDK added", () => {
		fc.assert(
			fc.property(
				record,
				fc.dictionary(
					fc.string().map((key) => `future_${key}`),
					fc.jsonValue(),
				),
				(stored, extra) => {
					resetSessionStorageStateForTests()
					storage.setItem("maple.session", JSON.stringify({ ...extra, ...stored }))
					expect(peekSession()).toEqual(stored)
				},
			),
			{ numRuns: 300 },
		)
	})
})
