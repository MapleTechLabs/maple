import { LOGS_TABLE_BENCH_ROWS } from "../../lab/bench/logs-table-bench-fixture"
import { Option } from "effect"
import { describe, expect, test } from "vitest"
import { logTimeFormat, toLogRowView } from "./log-row-view"
import { init, update } from "./logs-stream"
import { Message } from "./logs-stream-message"
import { pinnedColumnParts } from "./logs-stream-view"

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
	const label = (key: string) => pinnedColumnParts(key).label
	const whole = (key: string) => {
		const parts = pinnedColumnParts(key)
		return `${parts.prefix}${parts.label}${parts.suffix}`
	}

	test("names the attribute by its last specific segment", () => {
		expect(label("deployment.environment.name")).toBe("environment")
		expect(label("service.name")).toBe("service")
		expect(label("k8s.pod.id")).toBe("pod")
		expect(label("cloud.region")).toBe("region")
		expect(label("name")).toBe("name")
		expect(label("http.response.status_code")).toBe("status_code")
	})

	test("the parts still spell the full key", () => {
		for (const key of ["deployment.environment.name", "cloud.region", "name", "k8s.pod.id"]) {
			expect(whole(key)).toBe(key)
		}
	})
})
