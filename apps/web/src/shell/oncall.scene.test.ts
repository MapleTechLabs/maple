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
import { Message } from "./message"
import { init, type Model, OnCallData } from "./model"
import { MeasureSidebarOverflow } from "./mounts"
import {
	isNoSchedulesFresh,
	nextHandoffMs,
	NO_SCHEDULES_TTL_MS,
	ONCALL_IDLE_READ_MS,
	ONCALL_RETRY_MS,
	type OnCallShift,
	type OnCallSnapshot,
	onCallStatusOf,
} from "./oncall"
import { enter, update, type UpdateReturn } from "./update"
import { frameView } from "./view"

// The footer's on-call pill: what it says, and when it reads the schedules again.

const flags = { isMobile: false, theme: "dark", pinnedNamespaces: {}, dashboardFavorites: [] } as const

/** Mon 16 Nov 2026, 08:00 UTC: 09:00 CET for a Berlin viewer. */
const HANDOFF = Date.UTC(2026, 10, 16, 8)
const NOW = HANDOFF - 3 * 60 * 60_000
const ORG = "org_parity"

const shift = (overrides: Partial<OnCallShift> = {}): OnCallShift => ({
	scheduleName: "Checkout primary",
	userId: "user_me",
	endsAtMs: HANDOFF,
	...overrides,
})

const snapshotOf = (shifts: ReadonlyArray<OnCallShift>): OnCallSnapshot => ({
	userId: "user_me",
	viewerTimeZone: "Europe/Berlin",
	shifts,
})

const signedIn = (overrides: Partial<Model> = {}): Model => ({
	...init(flags),
	maybeOrgId: Option.some(ORG),
	hasRequestedSidebarData: true,
	...overrides,
})

const withOnCall = (shifts: ReadonlyArray<OnCallShift>, overrides: Partial<Model> = {}): Model =>
	signedIn({ onCall: OnCallData.Success({ data: snapshotOf(shifts) }), onCallNowMs: NOW, ...overrides })

const answer = (shifts: ReadonlyArray<OnCallShift>, readAtMs = NOW, isFromCache = false) =>
	Message.SucceededLoadOnCall({ orgId: ORG, snapshot: snapshotOf(shifts), readAtMs, isFromCache })

const commandsOf = (step: UpdateReturn) =>
	Arr.map(step.commands ?? [], (command) => ({ name: command.name, args: command.args }))

const viewAt = (currentPath: string) => {
	const frame = withViewInputs(frameView, {
		currentPath,
		breadcrumbs: [{ label: "Overview" }],
		page: () => null,
		topbarActions: () => null,
	})()
	return (model: Model, h: HtmlBuilder<Message>) => frame(model, h)
}

const view = viewAt("/")

const measured = Mount.resolve(MeasureSidebarOverflow, Message.MeasuredSidebarOverflow())

describe("on-call pill", () => {
	test("on call: one row with the weekday and time, the rest in its tooltip and name", () => {
		const pill = role("link", { name: "On call until Mon 09:00 CET, 16 Nov · Checkout primary" })
		scene(
			{ update, view },
			given(withOnCall([shift()])),
			measured,
			expect(pill).toHaveText("On call until Mon 09:00"),
			expect(pill).toHaveAttr("href", "/alerts?tab=oncall"),
			expect(pill).toHaveAttr("data-tooltip", "On call until Mon 09:00 CET, 16 Nov · Checkout primary"),
		)
	})

	test("a handoff more than six days out reads by its date, and other schedules are counted", () => {
		const week = 7 * 24 * 60 * 60_000
		const pill = role("link", { name: "On call until 23 Nov, 09:00 CET · Checkout primary +1 more" })
		scene(
			{ update, view },
			given(
				withOnCall([
					shift({ endsAtMs: HANDOFF + week }),
					shift({ scheduleName: "Payments", endsAtMs: HANDOFF + 2 * week }),
				]),
			),
			measured,
			expect(pill).toHaveText("On call until 23 Nov, 09:00"),
		)
	})

	test("not on call: says so, linking to the schedules", () => {
		const pill = role("link", { name: "Not on call" })
		scene(
			{ update, view },
			given(withOnCall([shift({ userId: "user_someone" })])),
			measured,
			expect(pill).toHaveAttr("href", "/alerts?tab=oncall"),
			expect(pill).not.toHaveAttr("data-tooltip"),
		)
	})

	test("an org without schedules, a first read that failed, or a shift that ended show no pill", () => {
		const absent = [
			expect(text("Not on call")).toBeAbsent(),
			expect(text("On call until Mon 09:00")).toBeAbsent(),
		]
		scene({ update, view }, given(withOnCall([])), measured, ...absent)
		scene(
			{ update, view },
			given(signedIn({ onCall: OnCallData.Failure({ error: "Failed" }) })),
			measured,
			...absent,
		)
		scene(
			{ update, view },
			given(withOnCall([shift()], { onCallNowMs: HANDOFF + 1 })),
			measured,
			...absent,
		)
	})

	test("the pill is a shortcut: on the page it links to, the nav's row is the current page, not the pill", () => {
		const pill = role("link", { name: "Not on call" })
		// Where the pill links today, and where it links once on-call has a page of its own.
		Arr.forEach(["/alerts?tab=oncall", "/alerts/on-call"], (currentPath) =>
			scene(
				{ update, view: viewAt(currentPath) },
				given(withOnCall([shift({ userId: "user_someone" })])),
				measured,
				expect(pill).toExist(),
				expect(pill).not.toHaveAttr("aria-current"),
			),
		)
	})

	test("on the collapsed rail the pill is a badged glyph named by the detail, which its tooltip shows", () => {
		const pill = role("link", { name: "On call until Mon 09:00 CET, 16 Nov · Checkout primary" })
		scene(
			{ update, view },
			given(withOnCall([shift()], { isSidebarOpen: false })),
			measured,
			expect(pill).toHaveText(""),
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
				"On call until Mon 09:00 CET, 16 Nov · Checkout primary",
			),
		)
	})
})

describe("on-call reads", () => {
	test("the sidebar reads the schedules with its other data; an answer for another org is dropped", () => {
		const entered = enter(ORG)(init(flags))
		expectVitest(commandsOf(entered)).toContainEqual({
			name: "LoadOnCall",
			args: { orgId: ORG, noSchedulesCheckedAtMs: null },
		})
		const stale = update(entered.model, {
			...answer([shift()]),
			orgId: "org_other",
		})
		expectVitest(stale.model.onCall._tag).toBe("Loading")
	})

	test("an answer reads again after the next handoff, or within the hour while the user is off call", () => {
		const onCall = update(signedIn(), answer([shift()])).model
		expectVitest(onCall.onCallNextReadAtMs).toBe(HANDOFF + 5_000)
		const offCall = update(signedIn(), answer([shift({ userId: "user_someone", endsAtMs: null })])).model
		expectVitest(offCall.onCallNextReadAtMs).toBe(NOW + ONCALL_IDLE_READ_MS)
	})

	test("an answer whose handoff has already passed retries with a growing delay", () => {
		const late = HANDOFF + 1_000
		const first = update(signedIn(), answer([shift()], late)).model
		expectVitest(first.onCallNextReadAtMs).toBe(late + ONCALL_RETRY_MS)
		const second = update(first, answer([shift()], late)).model
		expectVitest(second.onCallNextReadAtMs).toBe(late + 2 * ONCALL_RETRY_MS)
	})

	test("a failed re-read keeps the last answer up and retries from a minute, doubling", () => {
		const loaded = withOnCall([shift()])
		const failed = update(loaded, Message.FailedLoadOnCall({ orgId: ORG, failedAtMs: NOW })).model
		expectVitest(failed.onCall).toEqual(OnCallData.Success({ data: snapshotOf([shift()]) }))
		expectVitest(failed.onCallNextReadAtMs).toBe(NOW + ONCALL_RETRY_MS)
		const again = update(failed, Message.FailedLoadOnCall({ orgId: ORG, failedAtMs: NOW })).model
		expectVitest(again.onCallNextReadAtMs).toBe(NOW + 2 * ONCALL_RETRY_MS)
	})

	test("the timer reads again; coming back into focus reads only once a minute has passed", () => {
		const loaded = withOnCall([shift()])
		expectVitest(
			Arr.map(
				commandsOf(update(loaded, Message.ElapsedOnCallTimer({ nowMs: HANDOFF }))),
				(c) => c.name,
			),
		).toEqual(["LoadOnCall"])
		expectVitest(commandsOf(update(loaded, Message.WokeOnCall({ nowMs: NOW + 10_000 })))).toEqual([])
		expectVitest(
			Arr.map(commandsOf(update(loaded, Message.WokeOnCall({ nowMs: NOW + 61_000 }))), (c) => c.name),
		).toEqual(["LoadOnCall"])
	})

	test("an org with no schedules is remembered, skipped on the next read, and forgotten on a write", () => {
		const empty = update(signedIn(), answer([]))
		expectVitest(commandsOf(empty)).toEqual([
			{ name: "SaveNoSchedules", args: { orgId: ORG, checkedAtMs: NOW } },
		])
		expectVitest(empty.model.onCallNextReadAtMs).toBeNull()
		const booted = enter(ORG)(init({ ...flags, noScheduleOrgs: { [ORG]: NOW } }))
		expectVitest(commandsOf(booted)).toContainEqual({
			name: "LoadOnCall",
			args: { orgId: ORG, noSchedulesCheckedAtMs: NOW },
		})
		const written = update(empty.model, Message.ChangedOnCallSchedules())
		expectVitest(commandsOf(written)).toEqual([
			{ name: "LoadOnCall", args: { orgId: ORG, noSchedulesCheckedAtMs: null } },
			{ name: "SaveNoSchedules", args: { orgId: ORG, checkedAtMs: null } },
		])
	})

	test("a teammate's first schedule: back in focus, an aged 'no schedules' answer is asked again", () => {
		// The marker was read from storage at sign-in, so the first read never reached the API.
		const booted = enter(ORG)(init({ ...flags, noScheduleOrgs: { [ORG]: NOW } }))
		const cached = update(booted.model, answer([], NOW + 1_000, true)).model
		expectVitest(commandsOf(update(cached, Message.WokeOnCall({ nowMs: NOW + 61_000 })))).toEqual([])

		const agedAtMs = NOW + NO_SCHEDULES_TTL_MS
		expectVitest(isNoSchedulesFresh(NOW, agedAtMs - 1)).toBe(true)
		expectVitest(isNoSchedulesFresh(NOW, agedAtMs)).toBe(false)
		const woke = update(cached, Message.WokeOnCall({ nowMs: agedAtMs }))
		expectVitest(commandsOf(woke)).toEqual([
			{ name: "LoadOnCall", args: { orgId: ORG, noSchedulesCheckedAtMs: NOW } },
		])

		const found = update(woke.model, answer([shift({ userId: "user_someone" })], agedAtMs))
		expectVitest(commandsOf(found)).toEqual([
			{ name: "SaveNoSchedules", args: { orgId: ORG, checkedAtMs: null } },
		])
		scene(
			{ update, view },
			given(found.model),
			measured,
			expect(role("link", { name: "Not on call" })).toExist(),
		)
	})

	test("an org still without schedules is asked at most once per lifetime of its answer", () => {
		const empty = update(signedIn(), answer([])).model
		const agedAtMs = NOW + NO_SCHEDULES_TTL_MS
		const woke = update(empty, Message.WokeOnCall({ nowMs: agedAtMs }))
		const stillEmpty = update(woke.model, answer([], agedAtMs))
		expectVitest(commandsOf(stillEmpty)).toEqual([
			{ name: "SaveNoSchedules", args: { orgId: ORG, checkedAtMs: agedAtMs } },
		])
		expectVitest(
			commandsOf(update(stillEmpty.model, Message.WokeOnCall({ nowMs: agedAtMs + 61_000 }))),
		).toEqual([])
	})
})

describe("onCallStatusOf", () => {
	test("the user's soonest-ending live shift names the pill, counting the others", () => {
		const status = onCallStatusOf(
			snapshotOf([
				shift({ scheduleName: "Payments", endsAtMs: HANDOFF + 86_400_000 }),
				shift({ scheduleName: "Checkout primary" }),
				shift({ scheduleName: "Search", userId: "user_someone" }),
			]),
			NOW,
		)
		expectVitest(status).toEqual({
			_tag: "OnCall",
			scheduleName: "Checkout primary",
			otherSchedules: 1,
			until: { short: "Mon 09:00", rest: "CET, 16 Nov" },
		})
	})

	test("a shift past its end is not trusted: the next live one names the pill, or none does", () => {
		const shifts = [shift(), shift({ scheduleName: "Payments", endsAtMs: HANDOFF + 86_400_000 })]
		expectVitest(onCallStatusOf(snapshotOf(shifts), HANDOFF + 1)).toMatchObject({
			scheduleName: "Payments",
		})
		expectVitest(onCallStatusOf(snapshotOf([shift()]), HANDOFF + 1)).toEqual({ _tag: "Unknown" })
	})

	test("the next handoff is the soonest across every schedule; none in a gap", () => {
		const shifts = [shift({ endsAtMs: HANDOFF + 1 }), shift({ userId: null, endsAtMs: null }), shift()]
		expectVitest(nextHandoffMs(snapshotOf(shifts))).toBe(HANDOFF)
		expectVitest(nextHandoffMs(snapshotOf([shift({ endsAtMs: null })]))).toBeNull()
	})
})
