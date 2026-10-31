import { OrgId } from "@maple/domain"
import { Schema } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { LinkedCursorMessage, MountLinkedCursor } from "../../charts/linked-cursor"
import { ResolveThemeColors, ThemeMessage } from "../../charts/theme-colors"
import { toLoadFailure } from "../../data/load-failure"
import { failureSentence } from "../../ui/error-state"
import * as Tabs from "../../ui/tabs"
import { PageOutMessage, type PageContext } from "../contract"
import { DEFAULT_QUICK_START_STATE } from "../onboarding/quick-start-state"
import { Message } from "./message"
import type { Model } from "./model"
import { Message as SetupMessage } from "./setup-checklist"
import { realServices as realServicesOf } from "./setup-checklist-update"
import { subscriptions } from "./subscription"
import { initWith, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const setup = (message: SetupMessage) => Message.GotSetupMessage({ message })
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

/** Entered in Clerk mode with the clock and the stored quick-start state read. */
const entered = (isClerk: boolean, state = DEFAULT_QUICK_START_STATE) => {
	const start = initWith(isClerk)({ search: {} }, context)
	const clocked = pageUpdate(
		start.model,
		Message.CompletedReadEntry({ nowMs: NOW, hint: { environment: null, preset: "24h", seen: false } }),
	)
	const read = pageUpdate(clocked.model, setup(SetupMessage.ReadState({ state })))
	return { start, clocked, read }
}

const withServices = (model: Model, services: ReadonlyArray<string>): Model =>
	pageUpdate(
		model,
		setup(
			SetupMessage.SucceededLoadOverview({
				window: model.setup?.window ?? { startTime: "", endTime: "" },
				services: services.map((serviceName) => ({ serviceName, spanCount: 10 })),
			}),
		),
	).model

const failOverview = (model: Model): Model =>
	pageUpdate(
		model,
		setup(
			SetupMessage.FailedLoadOverview({
				window: model.setup?.window ?? { startTime: "", endTime: "" },
				failure: toLoadFailure("boom"),
			}),
		),
	).model

/** The card's services as the celebration reads them, `[]` while unknown. */
const realServices = (model: Model) => (model.setup === null ? [] : realServicesOf(model.setup))

const RECT = { left: 0, right: 225, top: 4, bottom: 5, width: 112, height: 32 }
const pageMounts = [
	Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} })),
	Mount.resolve(MountLinkedCursor, LinkedCursorMessage.CompletedMountLinkedCursor()),
] as const
/** The guided setup's two underline tab lists (snippets and package managers). */
const tabMounts = [
	Mount.resolve<string, Tabs.Message>(
		Tabs.MeasureTabIndicator,
		Tabs.Message.MeasuredIndicator({ rect: RECT }),
	),
	Mount.resolve<string, Tabs.Message>(
		Tabs.MeasureTabIndicator,
		Tabs.Message.MeasuredIndicator({ rect: RECT }),
	),
] as const

describe("overview setup checklist", () => {
	test("self-hosted has no card and reads nothing for it", () => {
		const { start } = entered(false)
		expect(start.model.setup).toBeNull()
		expect(names(start.commands)).not.toContain("ReadSetupChecklistState")
	})

	test("under Clerk the card mounts its keys and last-hour overview reads", () => {
		const { start, read } = entered(true)
		expect(names(start.commands)).toContain("ReadSetupChecklistState")
		expect(names(read.commands)).toEqual(
			expect.arrayContaining(["FetchSetupChecklistKeys", "FetchSetupChecklistOverview"]),
		)
	})

	test("waiting for telemetry shows the connect card; demo services do not count", () => {
		scene(
			{ update: pageUpdate, view },
			given(withServices(entered(true).read.model, ["demo-frontend"])),
			...pageMounts,
			...tabMounts,
			expectView(text("Connect your app to see real data")).toExist(),
			expectView(text("Listening for your first trace")).toExist(),
			expectView(role("button", { name: "Dismiss setup checklist" })).toExist(),
		)
	})

	test("a real service turns the card into the first-trace celebration", () => {
		scene(
			{ update: pageUpdate, view },
			given(withServices(entered(true).read.model, ["checkout"])),
			...pageMounts,
			expectView(text("checkout is sending telemetry.")).toExist(),
			expectView(text("Connect your app to see real data")).not.toExist(),
		)
	})

	test("dismissing hides the card, saves the state and toasts", () => {
		const model = entered(true).read.model
		const dismissed = pageUpdate(model, setup(SetupMessage.ClickedDismiss()))
		expect(dismissed.model.setup?.state?.checklistDismissed).toBe(true)
		expect(names(dismissed.commands)).toEqual(["SaveSetupChecklistState"])
		expect(dismissed.outMessage).toEqual(
			PageOutMessage.RequestedToast({
				type: "success",
				title: "Setup checklist hidden. You can reset it from settings later",
				description: "",
			}),
		)
		scene(
			{ update: pageUpdate, view },
			given(dismissed.model),
			...pageMounts,
			expectView(text("Connect your app to see real data")).not.toExist(),
		)
	})

	test("each poll re-reads the clock and asks the overview for the last hour up to now", () => {
		const model = withServices(entered(true).read.model, [])
		const polled = pageUpdate(model, setup(SetupMessage.TickedPoll()))
		expect(names(polled.commands)).toEqual(["ResolveSetupChecklistPollWindow"])
		const later = { startTime: "2026-10-01 11:05:00", endTime: "2026-10-01 12:05:00" }
		const resolved = pageUpdate(polled.model, setup(SetupMessage.ResolvedPollWindow({ window: later })))
		expect(resolved.commands?.map((command) => command.args)).toEqual([
			{ window: later, pinnedNamespace: null },
		])
		expect(realServices(withServices(resolved.model, ["checkout"]))).toEqual([
			{ serviceName: "checkout", spanCount: 10 },
		])
	})

	test("a poll during a slow overview read waits for it, and the slow answer lands", () => {
		const reading = entered(true).read.model
		const polled = pageUpdate(reading, setup(SetupMessage.TickedPoll()))
		expect(names(polled.commands)).toEqual([])
		const landed = withServices(polled.model, ["checkout"])
		expect(realServices(landed)).toEqual([{ serviceName: "checkout", spanCount: 10 }])
		expect(names(pageUpdate(landed, setup(SetupMessage.TickedPoll())).commands)).toEqual([
			"ResolveSetupChecklistPollWindow",
		])
	})

	test("a failed poll keeps the services already found", () => {
		const found = withServices(entered(true).read.model, ["checkout"])
		const failed = failOverview(found)
		expect(realServices(failed)).toEqual([{ serviceName: "checkout", spanCount: 10 }])
	})

	test("nothing renders until the first overview read says whether data arrived", () => {
		scene(
			{ update: pageUpdate, view },
			given(entered(true).read.model),
			...pageMounts,
			expectView(text("Connect your app to see real data")).not.toExist(),
			expectView(text(/is sending telemetry/)).not.toExist(),
		)
	})

	test("a first overview read that fails shows the failure, not the waiting card", () => {
		scene(
			{ update: pageUpdate, view },
			given(failOverview(entered(true).read.model)),
			...pageMounts,
			expectView(text(failureSentence(toLoadFailure("boom")), { exact: false })).toExist(),
			expectView(text("Listening for your first trace")).not.toExist(),
		)
	})

	test("the page strip's Try again also polls a failed setup check", () => {
		const failed = failOverview(entered(true).read.model)
		const retried = pageUpdate(failed, Message.ClickedRetryPage())
		expect(names(retried.commands)).toContain("ResolveSetupChecklistPollWindow")
	})

	test("the failure stays on screen while the next poll retries", () => {
		const failed = failOverview(entered(true).read.model)
		const polled = pageUpdate(failed, setup(SetupMessage.TickedPoll())).model
		const later = { startTime: "2026-10-01 11:05:00", endTime: "2026-10-01 12:05:00" }
		const retrying = pageUpdate(polled, setup(SetupMessage.ResolvedPollWindow({ window: later }))).model
		scene(
			{ update: pageUpdate, view },
			given(retrying),
			...pageMounts,
			expectView(text(failureSentence(toLoadFailure("boom")), { exact: false })).toExist(),
		)
	})

	test("the card polls while it waits for a real service and stops once one lands", () => {
		const polling = (model: Model) =>
			subscriptions.setupPoll.modelToDependencies({ model, context }).isPolling
		const read = entered(true).read.model
		expect(polling(read)).toBe(true)
		expect(polling(withServices(read, ["demo-frontend"]))).toBe(true)
		const connected = withServices(read, ["demo-frontend", "checkout"])
		expect(polling(connected)).toBe(false)
		expect(polling(failOverview(connected))).toBe(false)
	})

	test("a dismissed card does not poll", () => {
		const { read } = entered(true, { ...DEFAULT_QUICK_START_STATE, checklistDismissed: true })
		expect(subscriptions.setupPoll.modelToDependencies({ model: read.model, context }).isPolling).toBe(
			false,
		)
	})

	test("a stored dismissal sends none of the card's reads", () => {
		const { read } = entered(true, { ...DEFAULT_QUICK_START_STATE, checklistDismissed: true })
		expect(names(read.commands)).toEqual([])
	})
})
