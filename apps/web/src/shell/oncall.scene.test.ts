import * as Animation from "@foldkit/ui/animation"
import { Array as Arr, Option } from "effect"
import type { HtmlBuilder } from "foldkit/html"
import {
	Command,
	expect,
	given,
	hover,
	Mount,
	role,
	scene,
	selector,
	text,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect as expectVitest, test } from "vitest"
import * as Tooltip from "@maple/views/ui/tooltip"
import { LoadOnCall } from "./data"
import { Message } from "./message"
import { init, type Model, OnCallData } from "./model"
import { MeasureSidebarOverflow } from "./mounts"
import { nextHandoffMs, type OnCallShift, type OnCallSnapshot, onCallStatusOf } from "./oncall"
import { enter, update } from "./update"
import { frameView } from "./view"

// The footer's on-call pill: on call until the handoff, not on call, or nothing without schedules.

const flags = { isMobile: false, theme: "dark", pinnedNamespaces: {}, dashboardFavorites: [] } as const

/** Mon 16 Nov 2026, 08:00 UTC: 09:00 in Berlin. */
const HANDOFF = Date.UTC(2026, 10, 16, 8)

const shift = (overrides: Partial<OnCallShift> = {}): OnCallShift => ({
	scheduleName: "Checkout primary",
	timeZone: "Europe/Berlin",
	userId: "user_me",
	endsAtMs: HANDOFF,
	...overrides,
})

const withOnCall = (shifts: ReadonlyArray<OnCallShift>): Model => ({
	...init(flags),
	maybeOrgId: Option.some("org_parity"),
	hasRequestedSidebarData: true,
	onCall: OnCallData.Success({ data: { userId: "user_me", shifts } }),
})

const view = (() => {
	const frame = withViewInputs(frameView, {
		currentPath: "/",
		breadcrumbs: [{ label: "Overview" }],
		page: () => null,
		topbarActions: () => null,
	})()
	return (model: Model, h: HtmlBuilder<Message>) => frame(model, h)
})()

const measured = Mount.resolve(MeasureSidebarOverflow, Message.MeasuredSidebarOverflow())
const footer = selector('[data-slot="sidebar-footer"]')

describe("on-call pill", () => {
	test("on call: until the handoff on the schedule's clock, with the schedule, linking to the schedules", () => {
		scene(
			{ update, view },
			given(withOnCall([shift()])),
			measured,
			expect(footer).toContainText("You're on call"),
			expect(footer).toContainText("until Mon 16 Nov, 09:00"),
			expect(footer).toContainText("Checkout primary"),
			expect(role("link", { name: /You're on call/ })).toHaveAttr("href", "/alerts?tab=oncall"),
		)
	})

	test("not on call: says so with a way to the schedules", () => {
		scene(
			{ update, view },
			given(withOnCall([shift({ userId: "user_someone" })])),
			measured,
			expect(role("link", { name: /You're not on call/ })).toHaveAttr("href", "/alerts?tab=oncall"),
			expect(footer).toContainText("My schedules"),
		)
	})

	test("an org without schedules shows no pill", () => {
		scene(
			{ update, view },
			given(withOnCall([])),
			measured,
			expect(text("You're not on call")).toBeAbsent(),
			expect(text("My schedules")).toBeAbsent(),
		)
	})

	test("a failed read shows no pill", () => {
		scene(
			{ update, view },
			given({ ...withOnCall([]), onCall: OnCallData.Failure({ error: "Failed" }) }),
			measured,
			expect(text("My schedules")).toBeAbsent(),
		)
	})

	test("on the collapsed rail the pill is a dot whose tooltip says the sentence", () => {
		const pill = role("link", { name: /You're on call/ })
		scene(
			{ update, view },
			given({ ...withOnCall([shift()]), isSidebarOpen: false }),
			measured,
			expect(selector('[data-slot="sidebar-footer"] [data-slot="status-dot"]')).toExist(),
			hover(pill),
			Command.resolve(Tooltip.WaitOpenDelay, Tooltip.Message.ElapsedOpenDelay({ generation: 1 })),
			Mount.resolve(Tooltip.MountTooltip, Tooltip.Message.CompletedMountTooltip()),
			Command.resolve(
				Animation.WaitForPaint,
				Animation.Message.CompletedWaitForPaint({ generation: 1 }),
			),
			Command.resolve(
				Animation.WaitForAnimationSettled,
				Animation.Message.EndedAnimation({ generation: 1 }),
			),
			expect(selector('[data-slot="tooltip-popup"]')).toHaveText(
				"You're on call until Mon 16 Nov, 09:00 (Checkout primary)",
			),
		)
	})

	test("the sidebar reads the schedules with its other data, for its org only", () => {
		const entered = enter("org_parity")(init(flags))
		expectVitest(Arr.map(entered.commands ?? [], (command) => command.name)).toContain(LoadOnCall.name)
		const snapshot: OnCallSnapshot = { userId: "user_me", shifts: [shift()] }
		const stale = update(entered.model, Message.SucceededLoadOnCall({ orgId: "org_other", snapshot }))
		expectVitest(stale.model.onCall._tag).toBe("Loading")
		const fresh = update(entered.model, Message.SucceededLoadOnCall({ orgId: "org_parity", snapshot }))
		expectVitest(fresh.model.onCall).toEqual(OnCallData.Success({ data: snapshot }))
	})

	test("a handoff reads the schedules again", () => {
		const loaded = withOnCall([shift()])
		const next = update(loaded, Message.ElapsedOnCallHandoff())
		expectVitest(Arr.map(next.commands ?? [], (command) => command.name)).toEqual([LoadOnCall.name])
	})
})

describe("onCallStatusOf", () => {
	test("the user's soonest-ending shift names the pill, counting the others", () => {
		const status = onCallStatusOf({
			userId: "user_me",
			shifts: [
				shift({ scheduleName: "Payments", endsAtMs: HANDOFF + 86_400_000 }),
				shift({ scheduleName: "Checkout primary" }),
				shift({ scheduleName: "Search", userId: "user_someone" }),
			],
		})
		expectVitest(status).toEqual({
			_tag: "OnCall",
			scheduleName: "Checkout primary",
			otherSchedules: 1,
			until: "Mon 16 Nov, 09:00",
		})
	})

	test("the next handoff is the soonest across every schedule; none in a gap", () => {
		const shifts = [shift({ endsAtMs: HANDOFF + 1 }), shift({ userId: null, endsAtMs: null }), shift()]
		expectVitest(nextHandoffMs({ userId: "user_me", shifts })).toBe(HANDOFF)
		expectVitest(nextHandoffMs({ userId: "user_me", shifts: [shift({ endsAtMs: null })] })).toBeNull()
	})
})
