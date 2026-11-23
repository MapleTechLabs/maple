import { describe, expect, it } from "vitest"
import { Option, Schema } from "effect"
import {
	GithubAuditCategoryChanges,
	githubAuditCategoryEnabled,
	githubAuditCategoryOfAction,
	githubAuditCategoryStates,
} from "./github-audit"

describe("github audit categories", () => {
	it("finds an action's category by its event name", () => {
		expect(githubAuditCategoryOfAction("push.forced")).toEqual(Option.some("forcePushes"))
		expect(githubAuditCategoryOfAction("pull_request_review.approved")).toEqual(
			Option.some("pullRequests"),
		)
		expect(githubAuditCategoryOfAction("security_and_analysis.changed")).toEqual(
			Option.some("securitySettings"),
		)
		expect(githubAuditCategoryOfAction("workflow_run.completed")).toEqual(Option.none())
	})

	it("uses the org's choice where it made one, and the default elsewhere", () => {
		const overrides = { forcePushes: false, releases: true, retiredCategory: true }
		expect(githubAuditCategoryEnabled(overrides, "forcePushes")).toBe(false)
		expect(githubAuditCategoryEnabled(overrides, "releases")).toBe(true)
		expect(githubAuditCategoryEnabled(overrides, "members")).toBe(true)
		expect(githubAuditCategoryEnabled(overrides, "refCreations")).toBe(false)
		const states = githubAuditCategoryStates({})
		expect(states.refDeletions).toBe(true)
		expect(states.securityAlerts).toBe(false)
	})

	it("reads a partial change, keeping only categories it knows", () => {
		const decode = Schema.decodeUnknownOption(GithubAuditCategoryChanges)
		expect(decode({ forks: true })).toEqual(Option.some({ forks: true }))
		expect(decode({ forks: true, notACategory: true })).toEqual(Option.some({ forks: true }))
		expect(Option.isNone(decode({ forks: "yes" }))).toBe(true)
	})
})
