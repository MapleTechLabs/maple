import * as Animation from "@foldkit/ui/animation"
import { ingestUrl } from "../lib/services/common/ingest-url"
import { click, Command, expect, given, Mount, role, scene, selector, text } from "foldkit/scene"
import { describe, expect as expectVitest, test } from "vitest"
import * as Popover from "../ui/popover"
import { FetchKeys, FetchOverview, init, Message, type Model, ResolveWindow, update } from "./connect-panel"
import { view } from "./connect-panel-view"

/** The top bar's Connect popover (`ConnectButton`): the panel's reads go out when it opens. */
const ORG = "org_a"
const context = { orgId: ORG, pinnedNamespace: "prod" }
const config = { update: (model: Model, message: Message) => update(model, message, context), view }
const window = { startTime: "2026-10-19 10:00:00", endTime: "2026-10-19 11:00:00" }

const trigger = role("button", { name: "Connect" })

/** Click Connect and settle the popover's open transition and its Mount (Commands map their own answers). */
const opened = [
	click(trigger),
	Mount.resolve(Popover.MountPopover, Popover.Message.CompletedMountPopover()),
	Command.resolve(Animation.WaitForPaint, Animation.Message.CompletedWaitForPaint({ generation: 1 })),
	Command.resolve(Animation.WaitForAnimationSettled, Animation.Message.EndedAnimation({ generation: 1 })),
]

describe("connect panel scene", () => {
	test("opening shows the endpoint, reads the keys and the last hour, then the live pill", () => {
		scene(
			config,
			given(init()),
			expect(text("Connect your app")).toBeAbsent(),
			...opened,
			expect(role("dialog", { name: "Connect your app" })).toExist(),
			expect(selector("#connect-ingest-endpoint")).toHaveValue(ingestUrl),
			expect(text("Waiting for telemetry")).toExist(),
			Command.resolve(
				FetchKeys({ orgId: ORG }),
				Message.SucceededLoadKeys({
					orgId: ORG,
					publicKey: "maple_pk_0123456789abcdef",
					privateKey: "maple_sk_x",
				}),
			),
			expect(selector("#connect-public-key")).toHaveValue("maple_pk_01234•••••••cdef"),
			Command.resolve(ResolveWindow({ orgId: ORG }), Message.ResolvedWindow({ orgId: ORG, window })),
			Command.resolve(
				FetchOverview({ orgId: ORG, window, request: 1, pinnedNamespace: "prod" }),
				Message.SucceededLoadOverview({
					orgId: ORG,
					request: 1,
					services: [
						{ serviceName: "demo-api", spanCount: 10 },
						{ serviceName: "checkout", spanCount: 120 },
					],
				}),
			),
			expect(text("Connected · 1 service")).toExist(),
		)
	})

	test("a member who cannot read the keys gets the settings note", () => {
		scene(
			config,
			given(init()),
			...opened,
			Command.resolve(FetchKeys({ orgId: ORG }), Message.FailedLoadKeys({ orgId: ORG })),
			Command.resolve(ResolveWindow({ orgId: ORG }), Message.ResolvedWindow({ orgId: ORG, window })),
			Command.resolve(
				FetchOverview({ orgId: ORG, window, request: 1, pinnedNamespace: "prod" }),
				Message.FailedLoadOverview({ orgId: ORG, request: 1 }),
			),
			expect(role("link", { name: "Settings → Ingestion" })).toHaveAttr(
				"href",
				"/settings?tab=ingestion",
			),
			expect(text("Waiting for telemetry")).toExist(),
		)
	})
})

describe("connect panel update", () => {
	const open = (model: Model) =>
		update(model, Message.GotPopoverMessage({ message: Popover.Message.ClickedTrigger() }), context)

	test("another org's late answers are dropped and the poll re-reads the clock", () => {
		const opened = update(
			open(init()).model,
			Message.ResolvedWindow({ orgId: ORG, window }),
			context,
		).model
		const stale = update(
			opened,
			Message.SucceededLoadKeys({ orgId: "org_b", publicKey: "pk", privateKey: "sk" }),
			context,
		)
		expectVitest(stale.model.keys).toEqual({ _tag: "Loading" })
		const answered = update(
			opened,
			Message.SucceededLoadOverview({ orgId: ORG, request: 1, services: [] }),
			context,
		).model
		const polled = update(answered, Message.TickedPoll(), context)
		expectVitest(polled.commands?.map((command) => command.name)).toEqual(["ResolveConnectWindow"])
	})

	test("a poll during a slow overview read waits for it, and the slow answer lands", () => {
		const opened = update(
			open(init()).model,
			Message.ResolvedWindow({ orgId: ORG, window }),
			context,
		).model
		expectVitest(update(opened, Message.TickedPoll(), context).commands ?? []).toEqual([])
		const services = [{ serviceName: "checkout", spanCount: 3 }]
		const landed = update(
			opened,
			Message.SucceededLoadOverview({ orgId: ORG, request: 1, services }),
			context,
		).model
		expectVitest(landed.services).toEqual(services)
		const polled = update(landed, Message.TickedPoll(), context)
		expectVitest(polled.commands?.map((command) => command.name)).toEqual(["ResolveConnectWindow"])
	})

	test("a poll asks the overview for the last hour up to now and takes its answer", () => {
		const opened = update(
			open(init()).model,
			Message.ResolvedWindow({ orgId: ORG, window }),
			context,
		).model
		const later = { startTime: "2026-10-19 10:05:00", endTime: "2026-10-19 11:05:00" }
		const polled = update(opened, Message.ResolvedWindow({ orgId: ORG, window: later }), context)
		expectVitest(polled.commands?.map((command) => command.args)).toEqual([
			{ orgId: ORG, window: later, request: 2, pinnedNamespace: "prod" },
		])
		const services = [{ serviceName: "checkout", spanCount: 3 }]
		const landed = update(
			polled.model,
			Message.SucceededLoadOverview({ orgId: ORG, request: 2, services }),
			context,
		)
		expectVitest(landed.model.services).toEqual(services)
	})

	test("a failed poll keeps the services already found", () => {
		const opened = update(
			open(init()).model,
			Message.ResolvedWindow({ orgId: ORG, window }),
			context,
		).model
		const services = [{ serviceName: "checkout", spanCount: 3 }]
		const found = update(
			opened,
			Message.SucceededLoadOverview({ orgId: ORG, request: 1, services }),
			context,
		).model
		const failed = update(found, Message.FailedLoadOverview({ orgId: ORG, request: 1 }), context)
		expectVitest(failed.model.services).toEqual(services)
	})

	test("a failure from an earlier opening does not end the read in flight, even for the same window", () => {
		const first = update(
			open(init()).model,
			Message.ResolvedWindow({ orgId: ORG, window }),
			context,
		).model
		const closed = update(
			first,
			Message.GotPopoverMessage({ message: Popover.Message.ClickedClose() }),
			context,
		).model
		const opened = update(
			open(closed).model,
			Message.ResolvedWindow({ orgId: ORG, window }),
			context,
		).model
		const stale = update(opened, Message.FailedLoadOverview({ orgId: ORG, request: 1 }), context)
		expectVitest(stale.model.isOverviewInFlight).toBe(true)
		expectVitest(update(stale.model, Message.TickedPoll(), context).commands ?? []).toEqual([])
	})

	test("a reopen in the same org keeps the keys it read and does not read them again", () => {
		const ready = update(
			open(init()).model,
			Message.SucceededLoadKeys({ orgId: ORG, publicKey: "pk", privateKey: "sk" }),
			context,
		)
		const closed = update(
			ready.model,
			Message.GotPopoverMessage({ message: Popover.Message.ClickedClose() }),
			context,
		)
		expectVitest(update(closed.model, Message.TickedPoll(), context).commands ?? []).toEqual([])
		const reopened = open(closed.model)
		expectVitest(reopened.commands?.map((command) => command.name)).not.toContain(
			"FetchConnectIngestKeys",
		)
		expectVitest(reopened.model.keys._tag).toBe("Ready")
	})
})
