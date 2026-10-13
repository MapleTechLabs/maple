// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
import { afterEach, describe, expect, it, vi } from "vitest"

const calls: string[] = []
vi.mock("../replay/record", () => ({
	startRecording: () => {
		calls.push("stream")
		return { stop: () => calls.push("stream.stop"), flush: async () => {}, getClickCount: () => 0 }
	},
	startBufferedRecording: () => {
		calls.push("buffer")
		return {
			drain: async () => {
				calls.push("buffer.drain")
			},
			stop: () => calls.push("buffer.stop"),
			getClickCount: () => 2,
		}
	},
}))
vi.mock("../replay/events", () => ({
	startEventCapture: () => {
		calls.push("events")
		return { flush: async () => {}, stop: () => {} }
	},
}))
const rows: Array<Record<string, unknown>> = []
vi.mock("../platform/transport", async (importOriginal) => ({
	...(await importOriginal<typeof import("../platform/transport")>()),
	postSessionMeta: async (_config: unknown, row: Record<string, unknown>) => {
		rows.push(row)
	},
}))

const { startReplaySession } = await import("./replay-session")
const { claimReplayMode, getSession } = await import("./session")

const resourceAttribute = (row: Record<string, unknown> | undefined, key: string): string | undefined => {
	const attributes = row?.resource_attributes
	if (typeof attributes !== "object" || attributes === null) return undefined
	const value = Object.entries(attributes).find(([name]) => name === key)?.[1]
	return typeof value === "string" ? value : undefined
}
const recorded = (row: Record<string, unknown> | undefined) =>
	resourceAttribute(row, "maple.session.recorded")
const trigger = (row: Record<string, unknown> | undefined) =>
	resourceAttribute(row, "maple.session.replay_trigger")

afterEach(() => {
	calls.length = 0
	rows.length = 0
	sessionStorage.clear()
})

describe("startReplaySession in buffer mode", () => {
	it("buffers until triggered, then drains, streams, and re-announces the session as recorded", async () => {
		getSession()
		const handle = startReplaySession({
			endpoint: "https://ingest.test",
			sdk: "maple-test/0.0.0",
			serviceName: "web",
			maskAllInputs: true,
			maskAllText: false,
			mode: "buffer",
		})
		expect(calls).toEqual(["buffer"])
		expect(recorded(rows.at(-1))).toBe("false")

		await handle?.trigger()
		expect(calls).toEqual(["buffer", "buffer.drain", "buffer.stop", "stream", "events"])
		expect(recorded(rows.at(-1))).toBe("true")
		expect(trigger(rows.at(-1))).toBe("error")
		// The next load of this session records from the start.
		expect(claimReplayMode(0, 0)).toBe("record")

		await handle?.trigger()
		expect(calls.filter((call) => call === "stream")).toHaveLength(1)
		await handle?.shutdown()
	})

	it("records from the start in record mode, where trigger does nothing", async () => {
		getSession()
		const handle = startReplaySession({
			endpoint: "https://ingest.test",
			sdk: "maple-test/0.0.0",
			serviceName: "web",
			maskAllInputs: true,
			maskAllText: false,
		})
		await handle?.trigger()
		expect(calls).toEqual(["stream", "events"])
		expect(recorded(rows.at(-1))).toBe("true")
		expect(trigger(rows.at(-1))).toBeUndefined()
		await handle?.shutdown()
	})
})
