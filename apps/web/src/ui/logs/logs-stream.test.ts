import { LOGS_TABLE_BENCH_ROWS } from "../../lab/bench/logs-table-bench-fixture"
import { Option } from "effect"
import { describe, expect, test } from "vitest"
import { logTimeFormat, toLogRowView } from "./log-row-view"
import { init, update } from "./logs-stream"
import { Message } from "./logs-stream-message"
import { pinnedColumnLabel } from "./logs-stream-view"

const ROWS = LOGS_TABLE_BENCH_ROWS.slice(0, 30).map((log) => toLogRowView(log, [], logTimeFormat("UTC")))

// Scene resolves every Command before the next event, so a delay that fires after the pointer has
// already left is driven through update directly.
describe("logs stream: chip delays", () => {
	test("sweeping across a chip opens nothing: its stale delay is dropped", () => {
		const chip = { index: 0, key: "attribute.0" }
		const steps = [
			Message.EnteredChip(chip),
			Message.LeftChip(chip),
			Message.ElapsedChipDelay({ generation: 1 }),
		]
		const swept = steps.reduce((model, message) => update(model, message).model, init("stream", ROWS))
		expect(Option.isNone(swept.visibleChip)).toBe(true)
		expect(Option.isNone(swept.pendingOpen)).toBe(true)
	})

	test("moving to a second chip hands the card over instead of adding one", () => {
		const first = { index: 0, key: "attribute.0" }
		const second = { index: 1, key: "attribute.0" }
		const steps = [
			Message.EnteredChip(first),
			Message.ElapsedChipDelay({ generation: 1 }),
			Message.LeftChip(first),
			Message.EnteredChip(second),
			Message.ElapsedChipDelay({ generation: 2 }),
			Message.ElapsedChipDelay({ generation: 3 }),
		]
		const moved = steps.reduce((model, message) => update(model, message).model, init("stream", ROWS))
		expect(moved.visibleChip).toEqual(Option.some(second))
	})
})

describe("logs stream: pinned column labels", () => {
	test("skips trailing generic segments so the header names the attribute", () => {
		expect(pinnedColumnLabel("deployment.environment.name")).toBe("environment")
		expect(pinnedColumnLabel("service.name")).toBe("service")
		expect(pinnedColumnLabel("k8s.pod.id")).toBe("pod")
	})

	test("keeps the last segment when it is specific, or when every segment is generic", () => {
		expect(pinnedColumnLabel("cloud.region")).toBe("region")
		expect(pinnedColumnLabel("name")).toBe("name")
		expect(pinnedColumnLabel("http.response.status_code")).toBe("status_code")
	})
})
