import { describe, expect, it } from "vitest"
import { formatRestarts, restartTone, summarizePodRestarts, type PodRestartRow } from "./pod-restarts"

const row = (overrides: Partial<PodRestartRow>): PodRestartRow => ({
	podName: "api-1",
	namespace: "backend",
	containerName: "app",
	restarts: 0,
	totalRestarts: 0,
	lastTerminatedReason: "",
	...overrides,
})

describe("summarizePodRestarts", () => {
	it("sums restarts across a pod's containers", () => {
		const summary = summarizePodRestarts([
			row({ containerName: "app", restarts: 2, totalRestarts: 5 }),
			row({ containerName: "sidecar", restarts: 1, totalRestarts: 1 }),
		])
		expect(summary.get("backend/api-1")).toEqual({
			restarts: 3,
			totalRestarts: 6,
			lastTerminatedReason: "",
		})
	})

	it("takes the reason from the container that restarted most in the window", () => {
		const summary = summarizePodRestarts([
			row({ containerName: "sidecar", restarts: 1, totalRestarts: 9, lastTerminatedReason: "Error" }),
			row({ containerName: "app", restarts: 4, totalRestarts: 4, lastTerminatedReason: "OOMKilled" }),
		])
		expect(summary.get("backend/api-1")?.lastTerminatedReason).toBe("OOMKilled")
	})

	it("falls back to any container with a reason when the top one has none", () => {
		const summary = summarizePodRestarts([
			row({ containerName: "app", restarts: 3, lastTerminatedReason: "" }),
			row({ containerName: "init", restarts: 0, totalRestarts: 1, lastTerminatedReason: "Completed" }),
		])
		expect(summary.get("backend/api-1")?.lastTerminatedReason).toBe("Completed")
	})

	it("keeps same-named pods in different namespaces apart", () => {
		const summary = summarizePodRestarts([
			row({ namespace: "backend", restarts: 1 }),
			row({ namespace: "staging", restarts: 7 }),
		])
		expect(summary.get("backend/api-1")?.restarts).toBe(1)
		expect(summary.get("staging/api-1")?.restarts).toBe(7)
	})

	it("returns an empty map for no rows", () => {
		expect(summarizePodRestarts([]).size).toBe(0)
	})
})

describe("restartTone", () => {
	it("is neutral without restarts in the window, even with an old OOM kill", () => {
		expect(restartTone(0, "OOMKilled")).toBe("neutral")
	})

	it("reads an OOM kill as critical and other restarts as a warning", () => {
		expect(restartTone(2, "OOMKilled")).toBe("crit")
		expect(restartTone(2, "Error")).toBe("warn")
		expect(restartTone(1, "")).toBe("warn")
	})
})

describe("formatRestarts", () => {
	it("pluralizes", () => {
		expect(formatRestarts(1)).toBe("1 restart")
		expect(formatRestarts(3)).toBe("3 restarts")
	})
})
