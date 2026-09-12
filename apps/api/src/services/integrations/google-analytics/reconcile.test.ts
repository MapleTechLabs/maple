import { describe, expect, it } from "vitest"
import { DATASET_BY_ID } from "./datasets"
import { mapReport } from "./mapping"
import { type LedgerBucket, parseLedger, reconcile, serializeLedger } from "./reconcile"

const traffic = DATASET_BY_ID.get("traffic")!
const channels = DATASET_BY_ID.get("channels")!

const HOUR = 3_600_000
const BUCKET = Date.parse("2026-09-09T14:00:00.000Z")

/** A `runReport` response for the traffic dataset with a single hour of sessions. */
const trafficResponse = (sessions: number) => ({
	dimensionHeaders: [{ name: "dateHour" }],
	metricHeaders: [{ name: "sessions" }],
	rows: [{ dimensionValues: [{ value: "2026090914" }], metricValues: [{ value: String(sessions) }] }],
})

/** A `runReport` response for the channels dataset: one row per (hour, channel). */
const channelsResponse = (perChannel: ReadonlyArray<readonly [string, number]>) => ({
	dimensionHeaders: [{ name: "dateHour" }, { name: "sessionDefaultChannelGroup" }],
	metricHeaders: [{ name: "sessions" }, { name: "activeUsers" }],
	rows: perChannel.map(([channel, sessions]) => ({
		dimensionValues: [{ value: "2026090914" }, { value: channel }],
		metricValues: [{ value: String(sessions) }, { value: "0" }],
	})),
})

const run = (options: {
	readonly dataset: typeof traffic
	readonly response: ReturnType<typeof trafficResponse> | ReturnType<typeof channelsResponse>
	readonly ledger: ReadonlyArray<LedgerBucket>
}) =>
	reconcile({
		orgId: "org_test",
		propertyId: "123456789",
		propertyName: "Example",
		accountName: "Acme",
		dataset: options.dataset,
		points: mapReport({ dataset: options.dataset, response: options.response, timeZone: "UTC" }),
		ledger: options.ledger,
		coveredFromMs: BUCKET,
		coveredToMs: BUCKET + HOUR,
	})

/** What the warehouse would report for a bucket: every delta ever emitted for it, summed. */
const bucketSum = (...results: ReadonlyArray<ReturnType<typeof reconcile>>) =>
	results.flatMap((result) => result.rows).reduce((total, row) => total + row.value, 0)

describe("reconcile", () => {
	it("emits the raw value the first time a bucket is seen", () => {
		const result = run({ dataset: traffic, response: trafficResponse(100), ledger: [] })
		const sessions = result.rows.filter((row) => row.metric_name === "google_analytics.sessions")
		expect(sessions).toHaveLength(1)
		expect(sessions[0]!.value).toBe(100)
	})

	it("emits DELTA temporality, non-monotonic, at the bucket's own timestamp", () => {
		const [row] = run({ dataset: traffic, response: trafficResponse(100), ledger: [] }).rows
		expect(row!.aggregation_temporality).toBe(1)
		expect(row!.is_monotonic).toBe(false)
		expect(row!.timestamp).toBe("2026-09-09 14:00:00.000")
		expect(row!.service_name).toBe("google-analytics/123456789")
	})

	// The core contract: however many times GA4 revises an hour, the bucket's summed deltas
	// equal GA4's latest answer — which is exactly what `sum(Value)` per bucket reads back.
	it("sums to the revised value after an upward revision", () => {
		const first = run({ dataset: traffic, response: trafficResponse(100), ledger: [] })
		const second = run({ dataset: traffic, response: trafficResponse(140), ledger: first.ledger })

		const delta = second.rows.filter((row) => row.metric_name === "google_analytics.sessions")
		expect(delta).toHaveLength(1)
		expect(delta[0]!.value).toBe(40)
		expect(bucketSum(first, second)).toBe(140)
	})

	it("sums to the revised value after a DOWNWARD revision", () => {
		const first = run({ dataset: traffic, response: trafficResponse(100), ledger: [] })
		const second = run({ dataset: traffic, response: trafficResponse(60), ledger: first.ledger })

		const delta = second.rows.filter((row) => row.metric_name === "google_analytics.sessions")
		expect(delta[0]!.value).toBe(-40)
		expect(bucketSum(first, second)).toBe(60)
	})

	it("stays correct across a long chain of revisions", () => {
		let ledger: ReadonlyArray<LedgerBucket> = []
		const results = []
		for (const value of [10, 25, 25, 24, 90, 3, 3, 117]) {
			const result = run({ dataset: traffic, response: trafficResponse(value), ledger })
			ledger = result.ledger
			results.push(result)
		}
		expect(bucketSum(...results)).toBe(117)
	})

	it("writes nothing at all when a re-poll is unchanged", () => {
		const first = run({ dataset: traffic, response: trafficResponse(100), ledger: [] })
		const second = run({ dataset: traffic, response: trafficResponse(100), ledger: first.ledger })
		expect(second.rows).toHaveLength(0)
		expect(bucketSum(first, second)).toBe(100)
	})

	it("retracts a series that disappears from the report", () => {
		// "Paid Social" is reported, then revised away entirely. Without a retraction its old
		// value would linger in the bucket's sum forever.
		const first = run({
			dataset: channels,
			response: channelsResponse([
				["Organic Search", 80],
				["Paid Social", 20],
			]),
			ledger: [],
		})
		const second = run({
			dataset: channels,
			response: channelsResponse([["Organic Search", 80]]),
			ledger: first.ledger,
		})

		const retraction = second.rows.find(
			(row) => row.metric_attributes["google_analytics.channel_group"] === "Paid Social",
		)
		expect(retraction?.value).toBe(-20)
		expect(bucketSum(first, second)).toBe(80)
	})

	it("round-trips a breakdown value containing spaces", () => {
		// The retraction path has to rebuild attributes from the ledger key, and GA4's channel
		// groups are multi-word ("Organic Search", "Paid Social", "Cross-network").
		const first = run({
			dataset: channels,
			response: channelsResponse([["Organic Search", 55]]),
			ledger: [],
		})
		const second = run({ dataset: channels, response: channelsResponse([]), ledger: first.ledger })

		const retraction = second.rows.find((row) => row.metric_name === "google_analytics.sessions.by_channel")
		expect(retraction?.metric_attributes["google_analytics.channel_group"]).toBe("Organic Search")
		expect(retraction?.value).toBe(-55)
		expect(bucketSum(first, second)).toBe(0)
	})

	it("zeroes a covered bucket when the report comes back empty", () => {
		// GA4 was asked about this hour and answered "nothing" — a revision to zero, not a gap.
		const first = run({ dataset: traffic, response: trafficResponse(100), ledger: [] })
		const second = run({
			dataset: traffic,
			response: { dimensionHeaders: [{ name: "dateHour" }], metricHeaders: [{ name: "sessions" }], rows: [] },
			ledger: first.ledger,
		})
		expect(second.rows.map((row) => row.value)).toEqual([-100])
		expect(bucketSum(first, second)).toBe(0)
	})

	it("leaves buckets outside the covered window untouched", () => {
		const stale: LedgerBucket = { bucketMs: BUCKET - 10 * HOUR, emitted: { "google_analytics.sessions": 7 } }
		const result = run({ dataset: traffic, response: trafficResponse(100), ledger: [stale] })

		// No retraction for the old bucket — the report said nothing about it, which is not the
		// same as saying it is zero.
		expect(result.rows.every((row) => row.timestamp === "2026-09-09 14:00:00.000")).toBe(true)
		expect(result.ledger).toContainEqual(stale)
	})

	it("drops zero-valued series from the ledger instead of accumulating them", () => {
		const result = run({
			dataset: channels,
			response: channelsResponse([
				["Organic Search", 80],
				["Paid Social", 0],
			]),
			ledger: [],
		})
		const bucket = result.ledger.find((entry) => entry.bucketMs === BUCKET)
		expect(Object.keys(bucket?.emitted ?? {})).toEqual([
			"google_analytics.sessions.by_channel google_analytics.channel_group=Organic Search",
		])
	})
})

describe("ledger serialization", () => {
	it("round-trips", () => {
		const emitted = { "google_analytics.sessions": 12, "google_analytics.sessions.by_channel x=y": 3.5 }
		expect(parseLedger(serializeLedger(emitted))).toEqual(emitted)
	})

	it("treats an absent or corrupt blob as nothing-emitted", () => {
		expect(parseLedger(null)).toEqual({})
		expect(parseLedger("")).toEqual({})
		expect(parseLedger("{ not json")).toEqual({})
		expect(parseLedger("[1,2,3]")).toEqual({})
	})

	it("discards non-finite values rather than letting NaN reach a delta", () => {
		expect(parseLedger('{"a": 1, "b": "x", "c": null}')).toEqual({ a: 1 })
	})
})
