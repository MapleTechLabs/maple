import { createChartScene, type SceneNode } from "@tanstack/charts"
import { describe, expect, test } from "vitest"
import { infraMetricSpec } from "../infra-metric-chart"
import { buildInfraMetric } from "./infra-metric"

const START = Date.UTC(2026, 11, 1, 12)
const MINUTE = 60_000
const bucket = (index: number) => new Date(START + index * MINUTE).toISOString()

// 1-minute buckets; the workload reported in every bucket but the third.
const rows = [0, 1, 3, 4].map((index) => ({ bucket: bucket(index), attributeValue: "", value: 10 + index }))
const xDomain = [0, 1, 2, 3, 4].map(bucket)

const flatten = (nodes: ReadonlyArray<SceneNode>): ReadonlyArray<SceneNode> =>
	nodes.flatMap((node) => (node.kind === "group" ? flatten(node.children) : [node]))

/** The point count of every drawn line segment. */
const segments = (gaps: boolean) => {
	const built = buildInfraMetric(
		infraMetricSpec({
			rows,
			unit: "count",
			xDomain,
			gaps,
			theme: {},
			timeZone: "UTC",
			gradientPrefix: "cpu",
		}),
	)
	const { tooltip: _tooltip, ...definition } = built.definition
	const nodes =
		"marks" in definition ? flatten(createChartScene(definition, { width: 600, height: 200 }).nodes) : []
	return nodes.flatMap((node) => (node.kind === "polyline" ? [node.points.length] : []))
}

describe("infra metric lines with a silent minute", () => {
	test("a gaps chart breaks the line at the silent bucket", () => {
		expect(segments(true)).toEqual([2, 2])
	})

	test("any other chart bridges the one-minute silence", () => {
		expect(segments(false)).toEqual([4])
	})
})
