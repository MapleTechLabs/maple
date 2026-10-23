import { describe, expect, test } from "vitest"
import type { FleetRead } from "../../infra-integrations/aws/data"
import { findingHref } from "./links"
import { summarizeAws } from "./summarize-aws"

const point = (keys: ReadonlyArray<string>, metric: string, total: number, samples = 1) => ({
	keys,
	metric,
	total,
	samples,
	peak: total,
	lastSeen: "2026-10-23T12:00:00.000Z",
})

const ecs: FleetRead = {
	kind: "ecs",
	failed: false,
	points: [
		point(["checkout", "prod", "us-east-1", "123"], "aws.ecs.memory_utilization", 94),
		point(["search", "prod", "us-east-1", "123"], "aws.ecs.cpu_utilization", 40),
	],
}
const ec2: FleetRead = {
	kind: "ec2",
	failed: false,
	points: [point(["i-0abc", "eu-west-1", "123"], "aws.ec2.status_check_failed", 1)],
}
const time = { timePreset: "1h" }

describe("summarizeAws", () => {
	test("counts every kind's resources and lists the failing one before the hot one", () => {
		const summary = summarizeAws([ecs, ec2])
		expect(summary?.resources).toBe("3 resources")
		expect(summary?.headlineTone).toBe("crit")
		expect(summary?.findings.map((finding) => [finding.subject, finding.tone])).toEqual([
			["i-0abc", "crit"],
			["checkout", "warn"],
		])
		expect(summary?.segments).toEqual([
			{ key: "ok", count: 1 },
			{ key: "elevated", count: 1 },
			{ key: "saturated", count: 1 },
		])
	})

	test("a finding opens the resource's own page with its cluster and region", () => {
		const finding = summarizeAws([ecs])?.findings[0]
		expect(finding && findingHref(finding.target, time)).toMatch(
			/^\/infra\/aws\/ecs\/checkout\?.*cluster=prod/,
		)
	})

	test("a fleet whose every read failed is unreadable, not empty", () => {
		expect(summarizeAws([{ ...ecs, points: [], failed: true }])).toBeNull()
		expect(summarizeAws([])?.headline).toBe("no metrics in this window")
	})
})
