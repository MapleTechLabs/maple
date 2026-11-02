import { createChartScene, type SceneNode } from "@tanstack/charts"
import { describe, expect, test } from "vitest"
import { buildFixedMetric } from "./fixed-metric"

const START = Date.UTC(2026, 10, 1, 12)
const BUCKET = 5 * 60_000

// A quiet endpoint: p50 reported in three buckets with silence between, p95 in one only.
const rows = [
	{ p50LatencyMs: 10, p95LatencyMs: null, p99LatencyMs: null },
	{ p50LatencyMs: null, p95LatencyMs: null, p99LatencyMs: null },
	{ p50LatencyMs: null, p95LatencyMs: 40, p99LatencyMs: null },
	{ p50LatencyMs: 20, p95LatencyMs: null, p99LatencyMs: null },
	{ p50LatencyMs: null, p95LatencyMs: null, p99LatencyMs: null },
	{ p50LatencyMs: 30, p95LatencyMs: null, p99LatencyMs: null },
].map((row, index) => ({ bucket: new Date(START + index * BUCKET).toISOString(), ...row }))

const flatten = (nodes: ReadonlyArray<SceneNode>): ReadonlyArray<SceneNode> =>
	nodes.flatMap((node) => (node.kind === "group" ? flatten(node.children) : [node]))

const scene = () => {
	const built = buildFixedMetric({
		_tag: "FixedMetric",
		chart: "Latency",
		rows,
		colors: {
			border: "#333",
			background: "#000",
			p50LatencyMs: "#0af",
			p95LatencyMs: "#f80",
			p99LatencyMs: "#f44",
		},
		perSecond: false,
		timeZone: "UTC",
		// Long after the last bucket, so every bucket is closed and draws solid.
		nowMs: START + 24 * 60 * 60_000,
		gradientPrefix: "latency",
		showTooltip: false,
	})
	// The scene is the static definition without its DOM tooltip host.
	const { tooltip: _tooltip, ...definition } = built.definition
	return "marks" in definition
		? flatten(createChartScene(definition, { width: 600, height: 200 }).nodes)
		: []
}

describe("latency chart with missing buckets", () => {
	test("a series with silent buckets draws one line through its readings", () => {
		const p50 = scene().filter((node) => node.kind === "polyline" && node.key.startsWith("p50LatencyMs:"))
		expect(p50).toHaveLength(1)
		expect(p50[0]?.kind === "polyline" ? p50[0].points : []).toHaveLength(3)
	})

	test("a series with a single reading is drawn as a dot", () => {
		const nodes = scene()
		const p95Lines = nodes.filter(
			(node) => node.kind === "polyline" && node.key.startsWith("p95LatencyMs:"),
		)
		// The focus dot carries a background ring; the lone-reading dot is a plain fill.
		const loneDots = nodes.filter(
			(node) => node.kind === "dot" && node.style?.fill === "#f80" && node.style.stroke === undefined,
		)
		expect(p95Lines.flatMap((node) => (node.kind === "polyline" ? node.points : []))).toHaveLength(1)
		expect(loneDots).toHaveLength(1)
	})
})
