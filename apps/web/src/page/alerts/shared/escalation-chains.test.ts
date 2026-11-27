import { Array as Arr, Option } from "effect"
import { describe, expect, it } from "vitest"
import * as Policy from "@maple/domain/policy"
import {
	cannotRespondCountText,
	cannotRespondSentence,
	chainSummary,
	formatWait,
	runView,
	unableToRespond,
} from "./escalation-chains"
import { chainDestinations, chainOf, runOf } from "./escalation-test-fixtures"
import {
	formerMemberId,
	memberId,
	membersWithAnalysts,
	mixedTargetChain,
	oncallMembers,
} from "./oncall-test-fixtures"
import { NOW } from "../../kit/alert-test-rows"

const nameOf = (id: string) =>
	Option.getOrElse(
		Option.map(
			Arr.findFirst(chainDestinations, (row) => row.id === id),
			(row) => row.name,
		),
		() => "an unavailable destination",
	)

describe("chainSummary", () => {
	it("reads each step with the wait before it, and the repeats", () => {
		const chain = chainOf({
			n: 1,
			name: "Checkout on-call",
			steps: [
				{ destinations: [1], wait: 10 },
				{ destinations: [2], wait: 15 },
				{ destinations: [3], wait: 30 },
			],
			repeat: 2,
		})
		expect(chainSummary(chain, nameOf)).toBe(
			"Slack #alerts-api, then PagerDuty Checkout after 10m, then Email on-call after 15m; repeats twice",
		)
	})

	it("names two destinations of a step, shortens more, and says nothing of no repeats", () => {
		const chain = chainOf({
			n: 2,
			name: "Wide",
			steps: [
				{ destinations: [1, 2], wait: 90 },
				{ destinations: [3, 4, 5], wait: 5 },
			],
		})
		expect(chainSummary(chain, nameOf)).toBe(
			"Slack #alerts-api and PagerDuty Checkout, then Email on-call and 2 more after 1h 30m",
		)
	})
})

describe("chainSummary with people and schedules", () => {
	it("names the person and whoever is on call on the schedule, and reads generic words without names", () => {
		const chain = mixedTargetChain(chainDestinations[0]?.id ?? "")
		expect(
			chainSummary(chain, nameOf, {
				userName: (id) => (id === memberId(1) ? "Dana Kim" : "Ben Brook"),
				scheduleName: () => "Checkout primary",
			}),
		).toBe(
			"Slack #alerts-api, then whoever is on call on Checkout primary and Dana Kim after 5m, then Ben Brook after 15m; repeats once",
		)
		expect(chainSummary(chain, nameOf)).toBe(
			"Slack #alerts-api, then the on-call and a team member after 5m, then a team member after 15m; repeats once",
		)
	})
})

describe("people a chain pages who cannot respond", () => {
	const { label, action } = Policy.permissions["incidents:respond"]
	const chain = chainOf({
		n: 4,
		name: "Data platform",
		steps: [
			{ destinations: [1], users: [memberId(5), memberId(6), memberId(0)], wait: 10 },
			// Paged again on a later step, and someone who has left the org.
			{ destinations: [], users: [memberId(5), formerMemberId], wait: 20 },
		],
	})
	const targets = Arr.flatMap(chain.steps, (step) => step.targets)

	it("finds each of them once, and nobody who can respond, has left or is not known yet", () => {
		expect(Arr.map(unableToRespond(targets, membersWithAnalysts), (member) => member.name)).toEqual([
			"Mei Chen",
			"Omar Haddad",
		])
		expect(unableToRespond(targets, oncallMembers)).toEqual([])
		expect(unableToRespond(targets, null)).toEqual([])
	})

	it("names them in a step's line with the permission their role lacks", () => {
		const people = unableToRespond(targets, membersWithAnalysts)
		expect(cannotRespondSentence(Arr.take(people, 1))).toEqual(
			Option.some(`Mei Chen can't acknowledge or resolve: their role lacks ${label}.`),
		)
		expect(cannotRespondSentence(people)).toEqual(
			Option.some(`Mei Chen and Omar Haddad can't acknowledge or resolve: their roles lack ${label}.`),
		)
		expect(cannotRespondSentence([])).toEqual(Option.none())
	})

	it("counts them for the chain's row, and says nothing of a chain everyone can answer", () => {
		expect(cannotRespondCountText(chain, membersWithAnalysts)).toEqual(
			Option.some(`Pages 2 people who can't ${action}`),
		)
		expect(
			cannotRespondCountText(
				chainOf({ n: 5, name: "One", steps: [{ destinations: [], users: [memberId(6)], wait: 5 }] }),
				membersWithAnalysts,
			),
		).toEqual(Option.some(`Pages 1 person who can't ${action}`))
		expect(cannotRespondCountText(chain, oncallMembers)).toEqual(Option.none())
	})
})

describe("formatWait", () => {
	it("reads minutes, hours and a day", () => {
		expect([formatWait(1), formatWait(60), formatWait(75), formatWait(1440)]).toEqual([
			"1m",
			"1h",
			"1h 15m",
			"1d",
		])
	})
})

describe("runView", () => {
	it("an active run says where it is and when it pages next", () => {
		const view = runView(runOf("active", { nextStepAt: "2026-10-01T14:25:00.000Z" }), false, "UTC", NOW)
		expect(view.state).toBe("escalating")
		expect(view.detail).toMatch(/^Step 2 of 3, pass 1 of 3, next page at .*2:25/u)
	})

	it("an acknowledged incident reads as paused even before the run itself pauses", () => {
		expect(runView(runOf("active"), true, "UTC", NOW)).toMatchObject({
			state: "paused",
			label: "Paused: acknowledged",
		})
	})

	it("an unacknowledged incident whose run the scheduler has not resumed yet reads as resuming", () => {
		expect(runView(runOf("acknowledged"), false, "UTC", NOW)).toMatchObject({
			state: "escalating",
			label: "Resuming",
		})
	})

	it("an ended run says why it ended", () => {
		expect(runView(runOf("exhausted"), false, "UTC", NOW)).toEqual({
			state: "finished",
			label: "Finished",
			detail: "Every step was sent",
		})
		expect(runView(runOf("resolved"), true, "UTC", NOW).detail).toBe("Ended when the incident resolved")
	})
})
