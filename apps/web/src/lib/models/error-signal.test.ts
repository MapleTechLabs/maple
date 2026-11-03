import { describe, expect, it } from "vitest"

import type { WorkflowState } from "@maple/domain/http"
import type { V2Investigation } from "@maple/domain/http/v2"

import { ErrorIssueDocument } from "@maple/domain/http"

import { buildErrorsLabFixture } from "../../lab/errors-fixture"
import {
	buildErrorSignals,
	densifySpark,
	resolveSignalState,
	sparkFingerprintHashes,
	surgeRatio,
} from "./error-signal"

const HOUR_MS = 3_600_000

/** `resolveSignalState` reads exactly these two fields, so the fixture is the
 *  real argument type rather than a cast-down document. */
const issue = (fields: { hasOpenIncident?: boolean; workflowState?: WorkflowState }) => ({
	hasOpenIncident: fields.hasOpenIncident ?? false,
	workflowState: fields.workflowState ?? ("triage" as WorkflowState),
})

const investigation = (fields: {
	status: V2Investigation["status"]
	confidence?: V2Investigation["confidence"]
}) => ({
	id: "inv_1",
	status: fields.status,
	confidence: fields.confidence ?? null,
})

describe("resolveSignalState", () => {
	it("puts an open incident above everything else", () => {
		const state = resolveSignalState(
			issue({ hasOpenIncident: true, workflowState: "done" }),
			investigation({ status: "diagnosed" }),
		)
		expect(state).toEqual({ kind: "incident" })
	})

	it("puts a live investigation above the workflow state", () => {
		// The whole point of the precedence: "Maple diagnosed this" is more
		// actionable than "someone marked it todo".
		const state = resolveSignalState(
			issue({ workflowState: "todo" }),
			investigation({ status: "diagnosed", confidence: "high" }),
		)
		expect(state).toMatchObject({ kind: "investigation", status: "diagnosed", confidence: "high" })
	})

	it("falls back to the workflow state when nothing is running", () => {
		const state = resolveSignalState(issue({ workflowState: "in_review" }), undefined)
		expect(state).toEqual({ kind: "workflow", state: "in_review" })
	})
})

describe("sparkFingerprintHashes", () => {
	it("keeps only the issues whose fingerprint the warehouse can parse", () => {
		// Alert and integration issues reuse the fingerprint column for a
		// synthetic key. Sending one to the batched spark query makes ClickHouse
		// reject `toUInt64('alert:…')` and fails the sparklines for every row.
		const hashes = sparkFingerprintHashes([
			{ kind: "error", fingerprintHashes: ["753390793895937054"] },
			{ kind: "alert", fingerprintHashes: ["alert:550bb2c5-8fe0-4ab9-b2f8-e566674cb0a2:scraper"] },
			{ kind: "integration", fingerprintHashes: ["planetscale:maple:branch.out_of_memory"] },
			{ kind: "error", fingerprintHashes: ["1037926342141719040"] },
		])
		expect(hashes).toEqual(["753390793895937054", "1037926342141719040"])
	})
})

describe("densifySpark", () => {
	const window = { startMs: 0, endMs: 4 * HOUR_MS, bucketMs: HOUR_MS }

	it("zero-fills the buckets the warehouse omitted", () => {
		// Silence is a fact about the fingerprint; a line drawn straight across
		// the gap would read as steady traffic.
		const dense = densifySpark(
			[
				{ bucket: new Date(0).toISOString(), count: 5 },
				{ bucket: new Date(3 * HOUR_MS).toISOString(), count: 2 },
			],
			window,
		)
		expect(dense).toEqual([5, 0, 0, 2])
	})

	it("drops points outside the window rather than folding them into an edge bucket", () => {
		const dense = densifySpark(
			[
				{ bucket: new Date(-HOUR_MS).toISOString(), count: 99 },
				{ bucket: new Date(HOUR_MS).toISOString(), count: 1 },
				{ bucket: new Date(9 * HOUR_MS).toISOString(), count: 99 },
			],
			window,
		)
		expect(dense).toEqual([0, 1, 0, 0])
	})

	it("ignores unparseable buckets instead of NaN-indexing", () => {
		const dense = densifySpark([{ bucket: "not a date", count: 7 }], window)
		expect(dense).toEqual([0, 0, 0, 0])
	})

	it("returns nothing for a degenerate window", () => {
		expect(densifySpark([], { startMs: 0, endMs: HOUR_MS, bucketMs: 0 })).toEqual([])
	})
})

describe("surgeRatio", () => {
	it("stays silent when the window is too quiet to mean anything", () => {
		// Three events at the end of a window is not a spike, it is three events.
		expect(surgeRatio([0, 0, 0, 3])).toBeNull()
	})

	it("reads ~1 for volume spread evenly across the window", () => {
		const flat = Array.from({ length: 10 }, () => 10)
		const ratio = surgeRatio(flat)
		expect(ratio).not.toBeNull()
		expect(ratio ?? 0).toBeCloseTo(1, 5)
	})

	it("reads high when the same volume lands entirely at the end", () => {
		const burst = [...Array.from({ length: 9 }, () => 0), 100]
		// All 100 events in the last tenth of a window whose expected tail share
		// is a fifth: 100 / (100 * 0.2) = 5.
		expect(surgeRatio(burst) ?? 0).toBeGreaterThan(2.5)
	})

	it("reads low when a fingerprint is dying off", () => {
		const fading = [100, 60, 30, 10, 0, 0, 0, 0, 0, 0]
		expect(surgeRatio(fading) ?? 1).toBeLessThan(0.5)
	})
})

describe("buildErrorSignals", () => {
	it("sums a merged issue's volume and spark across every hash it owns", () => {
		const base = buildErrorsLabFixture(Date.parse("2026-11-03T12:00:00Z")).signals[0]!.issue
		const merged = new ErrorIssueDocument({ ...base, fingerprintHashes: ["1", "2"] })
		const day = (n: number) => `2026-11-0${n}T00:00:00.000Z`
		const [signal] = buildErrorSignals({
			issues: [merged],
			warehouse: [
				{ fingerprintHash: "1", count: 4, affectedServicesCount: 1 },
				{ fingerprintHash: "2", count: 6, affectedServicesCount: 2 },
			].map((row) => ({
				...row,
				errorLabel: "",
				sampleMessage: "",
				firstSeen: new Date(0),
				lastSeen: new Date(0),
			})),
			spark: [
				{
					fingerprintHash: "1",
					points: [
						{ bucket: day(1), count: 1 },
						{ bucket: day(2), count: 3 },
					],
				},
				{ fingerprintHash: "2", points: [{ bucket: day(2), count: 6 }] },
			],
			investigations: new Map(),
		})
		expect(signal?.windowCount).toBe(10)
		expect(signal?.affectedServicesCount).toBe(2)
		expect(signal?.spark).toEqual([
			{ bucket: day(1), count: 1 },
			{ bucket: day(2), count: 9 },
		])
	})
})
