import { Result, Array as Arr } from "effect"
import {
	click,
	Command,
	expect as expectView,
	given,
	Mount,
	role,
	scene,
	text,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { LinkedCursorMessage, MountLinkedCursor } from "@maple/views/charts/linked-cursor"
import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
import { buildErrorsLabFixture } from "../../../lab/errors-fixture"
import {
	CRITICAL_INCIDENT,
	DOWN_MONITOR,
	OBSERVER_CONTEXT,
	type ObserverHomeState,
	observerHomeModel,
	TOP_ERRORS,
	WARNING_INCIDENT,
} from "../../../lab/observer-home-fixture"
import { AppRoute, hrefOf } from "../../../route"
import { sloHref } from "../../alerts/shared/slo-commands"
import { checkoutSlo, searchSlo } from "../../alerts/shared/slo-test-fixtures"
import type { PageContext } from "../../contract"
import { incidentHref } from "../../kit/alert-links"
import { NOW } from "../../kit/alert-test-rows"
import { monitorHref } from "../../kit/uptime/commands"
import { httpMonitor } from "../../kit/uptime/test-monitors"
import { Message } from "../message"
import type { Model } from "../model"
import { init, update } from "../update"
import { view as pageView } from "../view"
import {
	FetchMonitors,
	FetchSlos,
	FetchTopErrors,
	LoadSignalPresence,
	MountObserverHome,
	ReadClock,
} from "./command"
import { topErrorsOf } from "./derive"
import { Message as ObserverMessage } from "./message"
import type { Model as ObserverModel } from "./model"
import { subscriptions } from "../subscription"

// The Overview an observer gets: a verdict, what backs it, and no control that sets anything up.

const OPERATOR_CONTEXT: PageContext = { ...OBSERVER_CONTEXT, audience: "operator" }

const pageUpdate = (model: Model, message: Message) => update(model, message, OBSERVER_CONTEXT)
const view = withViewInputs(pageView, { context: OBSERVER_CONTEXT })()

const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

/** The Overview page holding the observer page as its reads left it in `state`. */
const at = (state: ObserverHomeState): Model => ({
	...init({ search: {} }, OBSERVER_CONTEXT).model,
	observer: observerHomeModel(state),
})

const verdict = (name: string | RegExp) => role("heading", { level: 1, name })

/** The page's Mount: a no-op once `init` started the reads. */
const mounted = Mount.resolve(MountObserverHome, ObserverMessage.Entered())

describe("overview, observer", () => {
	test("with nothing open or failing the verdict says so, backed by the counts", () => {
		scene(
			{ update: pageUpdate, view },
			given(at("clear")),
			mounted,
			expectView(verdict("Everything is working.")).toExist(),
			expectView(
				text("No open incidents · 5 of 5 uptime checks passing · 2 of 2 SLOs within budget"),
			).toExist(),
			expectView(text("All 5 checks are passing")).toExist(),
			expectView(text("All 2 SLOs are within budget")).toExist(),
			expectView(role("link", { name: /All incidents/ })).toHaveAttr("href", "/alerts"),
			expectView(role("link", { name: /All uptime checks/ })).toHaveAttr("href", "/alerts/uptime"),
			expectView(role("link", { name: /All SLOs/ })).toHaveAttr("href", "/alerts/slos"),
			expectView(role("link", { name: /All errors/ })).toHaveAttr("href", "/errors"),
			expectView(role("link", { name: "Get a weekly summary by email" })).toHaveAttr(
				"href",
				"/account?tab=email-preferences",
			),
		)
	})

	test("open incidents, a failing check and troubled SLOs are named, and each row links to its page", () => {
		const topError = Arr.getUnsafe(TOP_ERRORS, 0)
		scene(
			{ update: pageUpdate, view },
			given(at("attention")),
			mounted,
			expectView(
				verdict("2 incidents open. 1 check failing. 1 SLO burning. 1 SLO out of budget."),
			).toExist(),
			expectView(
				text(
					"2 open incidents, 1 critical · 5 of 6 uptime checks passing · 0 of 2 SLOs within budget",
				),
			).toExist(),
			expectView(role("link", { name: /Critical.*checkout-api.*Open 1h 50m/ })).toHaveAttr(
				"href",
				incidentHref(CRITICAL_INCIDENT.id),
			),
			expectView(role("link", { name: /Warning.*search-api.*Open 26m/ })).toHaveAttr(
				"href",
				incidentHref(WARNING_INCIDENT.id),
			),
			expectView(role("link", { name: /payments-api.*Down 6m/ })).toHaveAttr(
				"href",
				monitorHref(DOWN_MONITOR.id),
			),
			expectView(role("link", { name: /Checkout API.*Burning.*12%/ })).toHaveAttr(
				"href",
				sloHref(checkoutSlo().id),
			),
			expectView(role("link", { name: /Search latency.*Out of budget.*-35%/ })).toHaveAttr(
				"href",
				sloHref(searchSlo().id),
			),
			expectView(
				role("link", { name: new RegExp(`${topError.serviceName}.*12,408 events`) }),
			).toHaveAttr("href", hrefOf(AppRoute.ErrorIssue({ issueId: topError.id, search: {} }))),
		)
	})

	test("an org with nothing set up is told what is missing and who can add it, with no setup control", () => {
		scene(
			{ update: pageUpdate, view },
			given(at("empty")),
			mounted,
			expectView(verdict("Nothing is monitored yet.")).toExist(),
			expectView(
				text("An engineer on your team can set up alert rules, uptime checks and SLOs."),
			).toExist(),
			expectView(text("No alert rules yet. An engineer on your team can set them up.")).toExist(),
			expectView(text("No uptime checks yet. An engineer on your team can set them up.")).toExist(),
			expectView(text("No SLOs yet. An engineer on your team can set them up.")).toExist(),
			expectView(text("No error data yet. An engineer on your team can connect your app.")).toExist(),
			expectView(verdict("Everything is working.")).toBeAbsent(),
			expectView(role("button", { name: /connect|new|create|set up/i })).toBeAbsent(),
			expectView(role("link", { name: /connect|new|create|settings|set up/i })).toBeAbsent(),
		)
	})

	test("while the reads are out there is no verdict", () => {
		scene(
			{ update: pageUpdate, view },
			given(at("loading")),
			mounted,
			expectView(role("heading", { level: 1 })).toBeAbsent(),
			expectView(text("Everything is working.")).toBeAbsent(),
		)
	})

	test("a failed uptime read is named in the verdict, the other sections still show, and Try again asks again", () => {
		const failed = at("failed")
		scene(
			{ update: pageUpdate, view },
			given(failed),
			mounted,
			expectView(verdict("No problems found, but uptime couldn't be checked.")).toExist(),
			expectView(verdict("Everything is working.")).toBeAbsent(),
			expectView(
				text("No open incidents · Couldn't check uptime · 2 of 2 SLOs within budget"),
			).toExist(),
			expectView(text("Couldn't load uptime checks")).toExist(),
			expectView(text("No open incidents")).toExist(),
			expectView(text("All 2 SLOs are within budget")).toExist(),
			expectView(role("link", { name: /12,408 events/ })).toExist(),
			click(role("button", { name: "Try again" })),
			Command.resolve(
				FetchMonitors,
				ObserverMessage.CompletedFetchMonitors({
					key: failed.observer?.monitors.key ?? "",
					result: Result.succeed([httpMonitor()]),
				}),
			),
			expectView(verdict("Everything is working.")).toExist(),
			expectView(text("The 1 check is passing")).toExist(),
		)
	})

	/** `state` after one more answer from the observer page's reads. */
	const after = (state: ObserverHomeState, answer: (observer: ObserverModel) => ObserverMessage): Model => {
		const model = at(state)
		if (model.observer === null) return model
		return pageUpdate(model, Message.GotObserverMessage({ message: answer(model.observer) })).model
	}

	test("checks that are all paused do not count as everything working", () => {
		const paused = after("clear", (observer) =>
			ObserverMessage.CompletedFetchMonitors({
				key: observer.monitors.key ?? "",
				result: Result.succeed([httpMonitor({ enabled: false })]),
			}),
		)
		scene(
			{ update: pageUpdate, view },
			given(paused),
			mounted,
			expectView(verdict("No problems found, but uptime couldn't be checked.")).toExist(),
			expectView(verdict("Everything is working.")).toBeAbsent(),
		)
	})

	test("an empty error list is only called a clean day when the app is known to send data", () => {
		const noErrors = (observer: ObserverModel) =>
			ObserverMessage.CompletedFetchErrors({
				key: observer.errors.key ?? "",
				result: Result.succeed([]),
			})
		scene(
			{ update: pageUpdate, view },
			given(after("clear", noErrors)),
			mounted,
			expectView(text("No open errors in the last 24 hours")).toExist(),
		)
		// The presence read has not answered: nothing says the app was watched.
		scene(
			{ update: pageUpdate, view },
			given(after("loading", noErrors)),
			mounted,
			expectView(text("No open errors in the last 24 hours")).toBeAbsent(),
			expectView(text("No open errors found")).toExist(),
		)
	})

	test("the engineers' live rows are not read while an observer's page is drawn", () => {
		const drawn = (model: Model) =>
			subscriptions.incidents.modelToDependencies({ model, context: OBSERVER_CONTEXT }).isDrawn
		expect(drawn(at("clear"))).toBe(false)
		expect(drawn(init({ search: {} }, OPERATOR_CONTEXT).model)).toBe(true)
	})

	test("an observer's entry starts their reads and none of the engineers'", () => {
		const entered = init({ search: {} }, OBSERVER_CONTEXT)
		expect(names(entered.commands)).toEqual(
			expect.arrayContaining([
				"ReadObserverHomeClock",
				"FetchObserverHomeMonitors",
				"FetchObserverHomeSlos",
				"LoadObserverHomeSignalPresence",
			]),
		)
		expect(names(entered.commands)).not.toContain("ReadOverviewEntry")
		expect(entered.model.setup).toBeNull()
	})

	test("a role that arrives after entry draws the observer page, and its mount starts the reads once", () => {
		const asOperator = init({ search: {} }, OPERATOR_CONTEXT).model
		const loading = observerHomeModel("loading")
		scene(
			{ update: pageUpdate, view },
			given(asOperator),
			expectView(role("heading", { level: 1, name: "Overview" })).toBeAbsent(),
			expectView(text("Open incidents")).toExist(),
			mounted,
			Command.resolve(ReadClock, ObserverMessage.CompletedReadClock({ nowMs: NOW })),
			Command.resolve(
				LoadSignalPresence,
				ObserverMessage.CompletedLoadSignalPresence({ result: Result.succeed({}) }),
			),
			Command.resolve(
				FetchMonitors,
				ObserverMessage.CompletedFetchMonitors({
					key: loading.monitors.key ?? "",
					result: Result.succeed([]),
				}),
			),
			Command.resolve(
				FetchSlos,
				ObserverMessage.CompletedFetchSlos({
					key: loading.slos.key ?? "",
					result: Result.succeed([]),
				}),
			),
			Command.resolve(
				FetchTopErrors,
				ObserverMessage.CompletedFetchErrors({
					key: loading.errors.key ?? "",
					result: Result.succeed([]),
				}),
			),
			expectView(text("No uptime checks yet. An engineer on your team can set them up.")).toExist(),
		)
		const entered = pageUpdate(
			asOperator,
			Message.GotObserverMessage({ message: ObserverMessage.Entered() }),
		)
		const again = pageUpdate(
			entered.model,
			Message.GotObserverMessage({ message: ObserverMessage.Entered() }),
		)
		expect(names(again.commands)).toEqual([])
	})

	test("the top errors wait for the clock, then are asked for over the last 24 hours", () => {
		const entered = init({ search: {} }, OBSERVER_CONTEXT)
		expect(names(entered.commands)).not.toContain("FetchObserverHomeTopErrors")
		const clocked = pageUpdate(
			entered.model,
			Message.GotObserverMessage({ message: ObserverMessage.CompletedReadClock({ nowMs: NOW }) }),
		)
		expect(names(clocked.commands)).toEqual(["FetchObserverHomeTopErrors"])
		expect(clocked.model.observer?.window).toEqual({
			startTime: "2026-09-30 12:00:00",
			endTime: "2026-10-01 12:00:00",
		})
	})

	test("an operator still gets the engineers' overview and its reads", () => {
		const entered = init({ search: {} }, OPERATOR_CONTEXT)
		expect(entered.model.observer).toBeNull()
		expect(names(entered.commands)).toEqual(
			expect.arrayContaining(["ReadOverviewEntry", "LoadOverviewSignalPresence"]),
		)
		expect(names(entered.commands)).not.toContain("FetchObserverHomeMonitors")
		scene(
			{
				update: (model: Model, message: Message) => update(model, message, OPERATOR_CONTEXT),
				view: withViewInputs(pageView, { context: OPERATOR_CONTEXT })(),
			},
			given(entered.model),
			Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} })),
			Mount.resolve(MountLinkedCursor, LinkedCursorMessage.CompletedMountLinkedCursor()),
			expectView(role("heading", { level: 1, name: "Overview" })).toExist(),
			expectView(text("Open incidents")).toBeAbsent(),
			expectView(text("Top errors")).toBeAbsent(),
		)
	})
})

describe("topErrorsOf", () => {
	const issues = Arr.map(buildErrorsLabFixture(NOW).signals, (signal) => signal.issue)
	const counted = (fingerprintHash: string, count: number) => ({
		fingerprintHash,
		errorLabel: "",
		sampleMessage: "",
		count,
		affectedServicesCount: 1,
		firstSeen: new Date(NOW),
		lastSeen: new Date(NOW),
	})

	test("ranks issues by their events in the window and leaves out the ones with none", () => {
		const first = Arr.getUnsafe(issues, 0)
		const second = Arr.getUnsafe(issues, 1)
		const top = topErrorsOf(issues, [
			counted(second.fingerprintHash, 40),
			counted(first.fingerprintHash, 7),
		])
		expect(Arr.map(top, (error) => [error.id, error.count])).toEqual([
			[second.id, 40],
			[first.id, 7],
		])
	})

	test("lists five at most", () => {
		const top = topErrorsOf(
			issues,
			Arr.map(issues, (issue, index) => counted(issue.fingerprintHash, index + 1)),
		)
		expect(top).toHaveLength(Math.min(5, issues.length))
		expect(Arr.map(top, (error) => error.count)).toEqual(
			Arr.map(top, (_, index) => issues.length - index),
		)
	})
})
