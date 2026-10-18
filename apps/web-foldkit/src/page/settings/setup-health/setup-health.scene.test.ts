import { describe, expect, test } from "vitest"
import { healthSegments, orderFindings, resolvedChecks, setupHealthAction } from "./derive"
import { Message } from "./model"
import { init, update } from "./update"

const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) => (commands ?? []).map(({ name }) => name)

describe("setup health", () => {
	test("entry runs the audit; Re-run re-runs it once while the first is in flight", () => {
		expect(names(init().commands)).toEqual(["FetchSetupAudit"])
		expect(names(update(init().model, Message.ClickedRetry()).commands)).toEqual(["FetchSetupAudit"])
	})

	test("findings put the most severe first and skip what passed", () => {
		const checks = [
			{ status: "fail", severity: "info" },
			{ status: "pass", severity: "critical" },
			{ status: "fail", severity: "critical" },
		] as const
		expect(orderFindings(checks).map((check) => check.severity)).toEqual(["critical", "info"])
		expect(resolvedChecks([{ status: "pass" }, { status: "skip" }]).label).toBe("Passing (1) and skipped (1)")
	})

	test("the summary bar drops empty segments, and a check names where it is fixed", () => {
		expect(healthSegments({ critical: 0, warn: 2, info: 0, pass: 41, skip: 0 })).toEqual([
			{ segment: "warn", count: 2 },
			{ segment: "pass", count: 41 },
		])
		expect(setupHealthAction({ id: "CFG-MAP-01", affected: [] })).toEqual({
			kind: "link",
			label: "Open ingestion",
			href: "/settings?tab=ingestion",
		})
	})
})
