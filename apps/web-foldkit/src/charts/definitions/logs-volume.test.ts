import { Option } from "effect"
import { describe, expect, test } from "vitest"
import { buildLogsVolume } from "./logs-volume"

const bucket = "2026-10-01 11:00:00"
const row = { bucket, INFO: 12_345 }

describe("logs volume tooltip", () => {
	test("prints counts compactly, as the y axis does", () => {
		const built = buildLogsVolume({
			_tag: "LogsVolume",
			buckets: [{ bucket, counts: { INFO: 12_345 } }],
			seriesKeys: ["INFO"],
			colors: { INFO: "#00f" },
			border: "#ccc",
			selection: null,
			isSelecting: false,
			timeZone: "UTC",
		})
		const point = {
			key: "INFO",
			markId: "bar",
			group: null,
			groupLabel: "",
			datum: { row, bucket, date: new Date(0), severity: "INFO", value: 12_345 },
			datumIndex: 0,
			xValue: new Date(0),
			yValue: 12_345,
			x: 0,
			y: 0,
			color: "#00f",
		}
		const tooltip = Option.getOrUndefined(built.tooltipOf([point]))
		expect(tooltip?._tag === "Bucket" ? tooltip.rows.map((r) => r.value) : []).toEqual(["12.3K"])
	})
})
