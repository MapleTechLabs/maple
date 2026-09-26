import { describe, expect, it } from "vitest"
import {
	emptyOnboardingChecklistInputs,
	evaluateOnboardingChecklist,
	ONBOARDING_CHECKLIST_STEP_IDS,
	ONBOARDING_REWARD_WINDOW_MS,
	type OnboardingChecklistInputs,
} from "./onboarding-checklist"

const CREATED = Date.parse("2026-07-27T00:00:00.000Z")
const NOW = CREATED + 6 * 60 * 60 * 1000

const allDone: OnboardingChecklistInputs = {
	orgCreatedAtMs: CREATED,
	rewardClaimedAtMs: null,
	telemetryPresent: true,
	githubConnected: true,
	alertRuleCount: 1,
	alertDestinationCount: 1,
	memberCount: 2,
	mcpKeyUsed: true,
	supportChannelAvailable: true,
	supportChannelCreated: true,
}

describe("evaluateOnboardingChecklist", () => {
	it("always reports every step, in order", () => {
		const report = evaluateOnboardingChecklist(
			{
				...emptyOnboardingChecklistInputs({ orgCreatedAtMs: CREATED, rewardClaimedAtMs: null }),
				supportChannelAvailable: true,
			},
			NOW,
		)
		expect(report.steps.map((step) => step.id)).toEqual([...ONBOARDING_CHECKLIST_STEP_IDS])
		expect(report.status).toBe("in_progress")
		expect(report.completedCount).toBe(0)
		expect(report.totalCount).toBe(4)
		expect(report.deadlineAtMs).toBe(CREATED + ONBOARDING_REWARD_WINDOW_MS)
	})

	it("is claimable only when every step is done inside the window", () => {
		expect(evaluateOnboardingChecklist(allDone, NOW).status).toBe("claimable")
		expect(evaluateOnboardingChecklist({ ...allDone, mcpKeyUsed: false }, NOW).status).toBe("in_progress")
	})

	it("treats the deadline itself as inside the window", () => {
		const deadline = CREATED + ONBOARDING_REWARD_WINDOW_MS
		expect(evaluateOnboardingChecklist(allDone, deadline).status).toBe("claimable")
		expect(evaluateOnboardingChecklist(allDone, deadline + 1).status).toBe("expired")
	})

	it("expires an org whose age is unknown rather than rewarding it", () => {
		const report = evaluateOnboardingChecklist({ ...allDone, orgCreatedAtMs: null }, NOW)
		expect(report.status).toBe("expired")
		expect(report.deadlineAtMs).toBeNull()
	})

	it("keeps a claim final even after the window closes", () => {
		const claimedAt = CREATED + 60_000
		const report = evaluateOnboardingChecklist(
			{ ...allDone, rewardClaimedAtMs: claimedAt },
			CREATED + 10 * ONBOARDING_REWARD_WINDOW_MS,
		)
		expect(report.status).toBe("claimed")
		expect(report.claimedAtMs).toBe(claimedAt)
	})

	it("needs both a rule and a destination for the alert step", () => {
		const step = (inputs: OnboardingChecklistInputs) =>
			evaluateOnboardingChecklist(inputs, NOW).steps.find((s) => s.id === "create_alert_rule")
				?.completed
		expect(step({ ...allDone, alertDestinationCount: 0 })).toBe(false)
		expect(step({ ...allDone, alertRuleCount: 0 })).toBe(false)
		expect(step(allDone)).toBe(true)
	})

	it("counts a teammate only beyond the founding member", () => {
		const step = (memberCount: number) =>
			evaluateOnboardingChecklist({ ...allDone, memberCount }, NOW).steps.find(
				(s) => s.id === "invite_teammate",
			)?.completed
		expect(step(1)).toBe(false)
		expect(step(2)).toBe(true)
	})

	it("shows the Slack step only where channels can be created, and never requires it", () => {
		const ids = (inputs: OnboardingChecklistInputs) =>
			evaluateOnboardingChecklist(inputs, NOW).steps.map((s) => s.id)
		expect(ids({ ...allDone, supportChannelAvailable: false })).not.toContain("join_slack_channel")
		expect(ids(allDone).at(-1)).toBe("join_slack_channel")
		const withoutChannel = evaluateOnboardingChecklist({ ...allDone, supportChannelCreated: false }, NOW)
		expect(withoutChannel.status).toBe("claimable")
		expect(withoutChannel.totalCount).toBe(4)
	})
})
