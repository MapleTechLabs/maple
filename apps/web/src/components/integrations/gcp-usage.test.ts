import { describe, expect, it } from "vitest"

import { gcpLogVolume, gcpWorkloadCounts } from "./gcp-usage"

const at = (iso: string) => Date.parse(iso)

describe("gcpLogVolume", () => {
	const start = at("2026-10-08T09:20:00.000Z")
	const end = at("2026-10-09T09:20:00.000Z")

	it("counts an hour per row and zero for an hour without one, from the first full hour", () => {
		const volume = gcpLogVolume(
			[
				{ bucket: "2026-10-08 10:00:00", series: { all: 4 } },
				{ bucket: "2026-10-09T09:00:00.000Z", series: { all: 6 } },
			],
			start,
			end,
		)
		expect(volume.total).toBe(10)
		// 10:00 on the 8th up to and including 09:00 on the 9th.
		expect(volume.hourly).toHaveLength(24)
		expect(volume.hourly[0]).toBe(4)
		expect(volume.hourly[23]).toBe(6)
		expect(volume.hourly.slice(1, 23).every((entries) => entries === 0)).toBe(true)
	})

	it("adds the severities of one hour and leaves out a row outside the window", () => {
		const volume = gcpLogVolume(
			[
				{ bucket: "2026-10-08 09:00:00", series: { ERROR: 100 } },
				{ bucket: "2026-10-08 12:00:00", series: { ERROR: 2, INFO: 5 } },
			],
			start,
			end,
		)
		expect(volume.total).toBe(7)
		expect(volume.hourly[2]).toBe(7)
		expect(volume.errors).toBe(2)
	})

	it("counts errors and worse apart from warnings, whatever their case", () => {
		const volume = gcpLogVolume(
			[
				{
					bucket: "2026-10-08 12:00:00",
					series: { ERROR: 2, Critical: 1, EMERGENCY: 1, WARNING: 4, warn: 1, INFO: 9, DEFAULT: 3 },
				},
			],
			start,
			end,
		)
		expect(volume).toMatchObject({ total: 21, errors: 4, warnings: 5 })
	})

	it("is all zeros without rows", () => {
		expect(gcpLogVolume([], start, end)).toEqual({
			total: 0,
			errors: 0,
			warnings: 0,
			hourly: Array.from({ length: 24 }, () => 0),
		})
	})
})

describe("gcpWorkloadCounts", () => {
	it("lists the services that reported, most workloads first", () => {
		expect(
			gcpWorkloadCounts([
				{ service: "cloudRun", workloads: [1, 2] },
				{ service: "cloudSql", workloads: [] },
				{ service: "gke", workloads: [1, 2, 3] },
			]),
		).toEqual([
			{ service: "gke", count: 3 },
			{ service: "cloudRun", count: 2 },
		])
	})
})
