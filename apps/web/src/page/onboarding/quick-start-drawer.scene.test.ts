import { OrgId } from "@maple/domain"
import { encodePublicId, PublicIdPrefixes, V2SourceWithSecret } from "@maple/domain/http/v2"
import { Result, Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { expect as expectView, given, Mount, role, scene, text } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../data/load-failure"
import type { StackPlatform } from "../../lib/onboarding-stack"
import * as Dialog from "../../ui/dialog"
import * as Tabs from "../../ui/tabs"
import type { PageContext } from "../contract"
import { Message as FlowMessage } from "../sources/new/message"
import { init, Message, type Model, update as updateWith } from "./quick-start"
import { ConnectMessage } from "./quick-start-connect"
import { DrawerMessage, isDrawerListening } from "./quick-start-drawer"
import { drawerView } from "./quick-start-drawer-view"
import { DEFAULT_QUICK_START_STATE } from "./quick-start-state"
import { connectStep } from "./quick-start-view"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_parity"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const update = (model: Model, message: Message) => updateWith(model, message, true, context)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const atConnect = (platforms: ReadonlyArray<StackPlatform>): Model => ({
	...init("maple-onboarding-v6-org_parity", false, false, "/", "org_parity").model,
	state: {
		...DEFAULT_QUICK_START_STATE,
		activeStep: "connect",
		completedSteps: { plan: true, stack: true },
		stack: { ...DEFAULT_QUICK_START_STATE.stack, platforms },
	},
})

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	model.state === null
		? h.empty
		: h.div(
				[],
				[
					connectStep(h, model, model.state),
					drawerView(h, model.drawer, "UTC", (message) => Message.GotDrawerMessage({ message })),
				],
			)

/** The sheet portals and traps focus on mount; the agent prompt's tabs measure their indicator. */
const dialogMounted = () => Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog())
const tabsMeasured = () =>
	Mount.resolve<string, Tabs.Message>(
		Tabs.MeasureTabIndicator,
		Tabs.Message.MeasuredIndicator({
			rect: { left: 0, right: 96, top: 0, bottom: 32, width: 96, height: 32 },
		}),
	)

/** A flow message as the open sheet sends it: from its view, or a Command sent for that flow. */
const toFlow = (message: FlowMessage, instance: number | null = 1) =>
	Message.GotDrawerMessage({ message: DrawerMessage.GotFlowMessage({ instance, message }) })

const created = Schema.decodeUnknownSync(V2SourceWithSecret)({
	id: encodePublicId(PublicIdPrefixes.source, "0199a0e1-0000-7000-8000-000000000011"),
	object: "source",
	name: "Kubernetes",
	description: null,
	platform: "kubernetes",
	kind: "token",
	is_default: false,
	key_prefix: "maple_src_K8sQa",
	integration_id: null,
	status: "active",
	allowed_signals: null,
	rate_limit_rps: null,
	resource_attributes: [],
	expires_at: null,
	paused_at: null,
	paused_until: null,
	last_used_at: null,
	rolled_at: "2026-10-01T00:00:00.000Z",
	created_at: "2026-10-01T00:00:00.000Z",
	updated_at: "2026-10-01T00:00:00.000Z",
	health: { status: "pending", last_data_at: null, problem: null, resources: null },
	secret: "maple_src_K8sQa8Kt7pQ2wR5vN0sL3dJ6hM4gY9dW1",
})

/** The user closes the sheet (its X, Escape or the backdrop). */
const closedByUser = (model: Model): Model =>
	update(
		model,
		Message.GotDrawerMessage({
			message: DrawerMessage.GotDialogMessage({ message: Dialog.Message.ClickedClose() }),
		}),
	).model

describe("onboarding connect drawer", () => {
	test("Set up opens the platform's connect flow over the step, without leaving onboarding", () => {
		scene(
			{ update, view },
			given(atConnect(["railway"])),
			tabsMeasured(),
			expectView(role("button", { name: "Set up Railway" })).toExist(),
		)
		const opened = update(atConnect(["railway"]), Message.ClickedSetUp({ platform: "railway" }))
		expect(opened.model.drawer?.flow.integration).toBe("railway")
		// The flow reads what it would on `/sources/new`: the integration's status and the list.
		expect(names(opened.commands)).toEqual(
			expect.arrayContaining(["LoadIntegrationsRailwayStatus", "FetchSourcesList"]),
		)
		scene(
			{ update, view },
			given(opened.model),
			tabsMeasured(),
			dialogMounted(),
			// The sheet is named by its title alone, not the trail under it.
			expectView(role("dialog", { name: "Connect Railway" })).toExist(),
			expectView(role("listitem", { current: "step", name: "Connect" })).toExist(),
		)
	})

	test("Kubernetes and Docker open the push flow: name the source, then its token", () => {
		const opened = update(
			atConnect(["kubernetes"]),
			Message.ClickedSetUp({ platform: "kubernetes" }),
		).model
		expect(opened.drawer?.flow.platform).toBe("kubernetes")
		expect(opened.drawer?.flow.integration).toBeNull()
		scene(
			{ update, view },
			given(opened),
			tabsMeasured(),
			dialogMounted(),
			expectView(role("heading", { name: "Connect Kubernetes" })).toExist(),
			expectView(text("Name the source")).toExist(),
		)
	})

	test("Back on the first step closes the drawer and re-reads the providers", () => {
		const opened = update(atConnect(["railway"]), Message.ClickedSetUp({ platform: "railway" })).model
		const back = update(opened, toFlow(FlowMessage.ClickedStepBack()))
		expect(back.model.drawer?.dialog.isOpen).toBe(false)
		expect(back.outMessage).toBeUndefined()
		expect(names(back.commands)).toContain("LoadOnboardingConnectedProviders")
		// A provider not yet connected stays unticked.
		expect(back.model.connect.connected["railway"]).toBeUndefined()
	})

	test("a source made in the drawer reads Connected on its row once Done closes it", () => {
		const opened = update(
			atConnect(["kubernetes"]),
			Message.ClickedSetUp({ platform: "kubernetes" }),
		).model
		const saving = update(opened, toFlow(FlowMessage.SubmittedForm())).model
		const made = update(
			saving,
			toFlow(FlowMessage.CompletedCreate({ result: Result.succeed(created) })),
		).model
		scene(
			{ update, view },
			given(made),
			tabsMeasured(),
			dialogMounted(),
			expectView(text("Copy the token")).toExist(),
			// The page's links away to the source are Done here.
			expectView(role("link", { name: "Skip for now" })).not.toExist(),
			expectView(role("button", { name: "Done" })).toExist(),
		)
		const done = update(made, toFlow(FlowMessage.ClickedDone()))
		expect(done.model.drawer?.dialog.isOpen).toBe(false)
		expect(done.model.connect.connected["kubernetes"]).toBe(true)
		// A sources read that started before the create cannot untick it.
		const stale = update(
			done.model,
			Message.GotConnectMessage({
				message: ConnectMessage.LoadedConnected({ connected: { kubernetes: false } }),
			}),
		)
		expect(stale.model.connect.connected["kubernetes"]).toBe(true)
		scene(
			{ update, view },
			given({ ...done.model, drawer: null }),
			tabsMeasured(),
			expectView(role("button", { name: "Set up Kubernetes" })).not.toExist(),
			expectView(text("Connected")).toExist(),
		)
	})

	test("a failed create toasts through the root, and the drawer stays open", () => {
		const opened = update(atConnect(["docker"]), Message.ClickedSetUp({ platform: "docker" })).model
		const saving = update(opened, toFlow(FlowMessage.SubmittedForm())).model
		const failed = update(
			saving,
			toFlow(FlowMessage.CompletedCreate({ result: Result.fail(toLoadFailure(new Error("quota"))) })),
		)
		expect(failed.outMessage).toMatchObject({
			_tag: "RequestedConnectFlowOut",
			out: { _tag: "RequestedToast", type: "error", title: "Couldn't create source" },
		})
		expect(failed.model.drawer?.dialog.isOpen).toBe(true)
	})

	test("an OAuth return waiting in the tab opens the drawer on its provider to finish it", () => {
		const step = update(atConnect([]), Message.FoundOAuthReturn({ platform: "cloudflare" }))
		expect(step.model.drawer?.flow.integration).toBe("cloudflare")
		// The integrations module takes the return as it enters.
		expect(names(step.commands)).toContain("CompleteIntegrationsOAuthReturn")
		expect(names(init("maple-onboarding-v6-org_parity").commands)).toContain("PeekOnboardingOAuthReturn")
	})

	test("a second Set up waits for the open sheet", () => {
		const opened = update(
			atConnect(["railway", "aws"]),
			Message.ClickedSetUp({ platform: "railway" }),
		).model
		expect(update(opened, Message.ClickedSetUp({ platform: "aws" })).model.drawer?.platform).toBe(
			"railway",
		)
	})

	test("a create that answers after the sheet closed still lands: the row reads Connected, reopening shows the token", () => {
		const opened = update(
			atConnect(["kubernetes"]),
			Message.ClickedSetUp({ platform: "kubernetes" }),
		).model
		const shut = closedByUser(update(opened, toFlow(FlowMessage.SubmittedForm())).model)
		const late = update(
			shut,
			toFlow(FlowMessage.CompletedCreate({ result: Result.succeed(created) })),
		).model
		expect(late.connect.connected["kubernetes"]).toBe(true)
		// The row reads Connected, and Show token reopens the dismissed sheet on it.
		scene(
			{ update, view },
			given(late),
			tabsMeasured(),
			// Still mounted while it animates out.
			dialogMounted(),
			expectView(role("button", { name: "Show the Kubernetes token" })).toExist(),
		)
		const reopened = update(late, Message.ClickedSetUp({ platform: "kubernetes" }))
		expect(reopened.model.drawer?.dialog.isOpen).toBe(true)
		expect(reopened.model.drawer?.flow.created?.secret).toBe(created.secret)
		// Resuming starts no new flow, so nothing is read or created again.
		expect(names(reopened.commands)).not.toContain("FetchSourcesList")
	})

	test("a closed flow's late result does not land in the next platform's sheet", () => {
		const opened = update(
			atConnect(["kubernetes", "docker"]),
			Message.ClickedSetUp({ platform: "kubernetes" }),
		).model
		const shut = closedByUser(update(opened, toFlow(FlowMessage.SubmittedForm())).model)
		const docker = update(shut, Message.ClickedSetUp({ platform: "docker" })).model
		expect(docker.drawer?.flow.platform).toBe("docker")
		const stale = update(
			docker,
			toFlow(FlowMessage.CompletedCreate({ result: Result.succeed(created) }), 1),
		)
		expect(stale.model.drawer?.flow.created).toBeNull()
		expect(stale.model.connect.connected["docker"]).toBeUndefined()
		// The open sheet's own Subscriptions and Commands still reach it.
		const own = update(docker, toFlow(FlowMessage.ChangedName({ value: "Edge hosts" }), null))
		expect(own.model.drawer?.flow.name).toBe("Edge hosts")
	})

	test("Done ends a push source's flow: the next Set up starts another source", () => {
		const opened = update(
			atConnect(["kubernetes"]),
			Message.ClickedSetUp({ platform: "kubernetes" }),
		).model
		const saving = update(opened, toFlow(FlowMessage.SubmittedForm())).model
		const made = update(
			saving,
			toFlow(FlowMessage.CompletedCreate({ result: Result.succeed(created) })),
		).model
		const done = update(made, toFlow(FlowMessage.ClickedDone())).model
		expect(isDrawerListening(done.drawer)).toBe(false)
		const again = update(done, Message.ClickedSetUp({ platform: "kubernetes" })).model
		expect(again.drawer?.flow.created).toBeNull()
		expect(again.drawer?.instance).toBe(2)
	})

	test("a dismissed integration keeps listening for its popup, and reopening reads it afresh", () => {
		const opened = update(atConnect(["railway"]), Message.ClickedSetUp({ platform: "railway" })).model
		const dismissed = closedByUser(opened)
		expect(dismissed.drawer?.dialog.isOpen).toBe(false)
		expect(isDrawerListening(dismissed.drawer)).toBe(true)
		const reopened = update(dismissed, Message.ClickedSetUp({ platform: "railway" }))
		expect(reopened.model.drawer?.instance).toBe(2)
		expect(names(reopened.commands)).toEqual(expect.arrayContaining(["LoadIntegrationsRailwayStatus"]))
	})

	test("without the org's context the drawer stays shut", () => {
		const step = updateWith(
			atConnect(["railway"]),
			Message.ClickedSetUp({ platform: "railway" }),
			true,
			null,
		)
		expect(step.model.drawer).toBeNull()
	})
})
