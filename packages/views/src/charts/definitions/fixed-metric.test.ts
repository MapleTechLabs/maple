import { createChartScene, type SceneNode } from "@tanstack/charts"
import { describe, expect, test } from "vitest"
import { buildFixedMetric } from "./fixed-metric"

const START = Date.UTC(2026, 10, 1, 12)
const BUCKET = 5 * 60_000

// 5-minute buckets. p50: one empty bucket between its first two readings, then two empty
// before its last pair. p95: two readings 20 minutes apart.
const P50 = [10, null, 20, null, null, 30, 40, null]
const P95 = [null, null, 40, null, null, null, 50, null]
const rows = P50.map((p50, index) => ({
	bucket: new Date(START + index * BUCKET).toISOString(),
	p50LatencyMs: p50,
	p95LatencyMs: P95[index] ?? null,
	p99LatencyMs: null,
}))

const flatten = (nodes: ReadonlyArray<SceneNode>): ReadonlyArray<SceneNode> =>
	nodes.flatMap((node) => (node.kind === "group" ? flatten(node.children) : [node]))

const scene = (chartRows: typeof rows = rows, nowMs = START + 24 * 60 * 60_000) => {
	const built = buildFixedMetric({
		_tag: "FixedMetric",
		chart: "Latency",
		rows: chartRows,
		colors: {
			border: "#333",
			background: "#000",
			p50LatencyMs: "#0af",
			p95LatencyMs: "#f80",
			p99LatencyMs: "#f44",
		},
		perSecond: false,
		timeZone: "UTC",
		// By default long after the last bucket, so every bucket is closed and draws solid.
		nowMs,
		gradientPrefix: "latency",
		showTooltip: false,
	})
	// The scene is the static definition without its DOM tooltip host.
	const { tooltip: _tooltip, ...definition } = built.definition
	return "marks" in definition
		? flatten(createChartScene(definition, { width: 600, height: 200 }).nodes)
		: []
}

const lines = (nodes: ReadonlyArray<SceneNode>, key: string) =>
	nodes.flatMap((node) =>
		node.kind === "polyline" && node.key.startsWith(`${key}:`) ? [node.points.length] : [],
	)

describe("latency chart with missing buckets", () => {
	test("a line bridges one empty bucket and breaks on a longer silence", () => {
		expect(lines(scene(), "p50LatencyMs")).toEqual([2, 2])
	})

	test("a longer silence is drawn as a faint dashed line between the two runs", () => {
		const bridges = scene().flatMap((node) =>
			node.kind === "polyline" && node.key.startsWith("p50LatencyMs-silence:") ? [node] : [],
		)
		expect(bridges.map((node) => [node.points.length, node.style?.strokeDasharray])).toEqual([[2, "2 4"]])
	})

	test("closed readings one empty bucket apart stay solid next to an in-flight bucket", () => {
		// 12:40 and 12:50 readings, charted at 12:57: only the 12:55 bucket is still in flight.
		const late = Array.from({ length: 12 }, (_, index) => ({
			bucket: new Date(START + index * BUCKET).toISOString(),
			p50LatencyMs: index === 8 || index === 10 ? 20 : null,
			p95LatencyMs: null,
			p99LatencyMs: null,
		}))
		const nodes = scene(late, START + 57 * 60_000)
		expect(lines(nodes, "p50LatencyMs")).toEqual([2])
		expect(lines(nodes, "p50LatencyMs-partial")).toEqual([])
	})

	test("readings too far apart to share a line draw as dots", () => {
		const nodes = scene()
		// The focus dot carries a background ring; a lone-reading dot is a plain fill.
		const loneDots = nodes.filter(
			(node) => node.kind === "dot" && node.style?.fill === "#f80" && node.style.stroke === undefined,
		)
		expect(lines(nodes, "p95LatencyMs").filter((points) => points > 1)).toEqual([])
		expect(loneDots).toHaveLength(2)
	})
})
