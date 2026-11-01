import type { OAuthReturnFlow } from "@maple/domain/http"
import { Clock, Effect, Option, Schema } from "effect"
import { Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { STACK_PLATFORM_IDS, type StackPlatform } from "../../lib/onboarding-stack"
import { browserStorage, peekOAuthReturn } from "../../platform/oauth-return-stash"
import type { Resources } from "../../platform/resources"
import * as Dialog from "../../ui/dialog"
import type { PageContext, PageOutMessage } from "../contract"
import * as SourcesFlow from "../sources/new/embed"

// The connect step's drawer: a picked platform's `/sources/new` flow, without leaving onboarding.

export const DRAWER_ID = "onboarding-connect-drawer"

export const ConnectDrawer = Schema.Struct({
	platform: Schema.Literals(STACK_PLATFORM_IDS),
	/** Bumped for each new flow: a result from a replaced one is dropped, like a page instance's. */
	instance: Schema.Number,
	/** Left by Done or Back: the flow is over, and a closed sheet that was only dismissed keeps listening. */
	isExited: Schema.Boolean,
	flow: SourcesFlow.Model,
	dialog: Dialog.Model,
})
export type ConnectDrawer = typeof ConnectDrawer.Type

export const DrawerMessage = defineMessageUnion({
	/** `instance` is the flow a Command was sent for; null from its Subscriptions, which run for the open one. */
	GotFlowMessage: { instance: Schema.NullOr(Schema.Number), message: SourcesFlow.Message },
	GotDialogMessage: { message: Dialog.Message },
})
export type DrawerMessage = typeof DrawerMessage.Type

/** Kubernetes and Docker push with a source token; the rest are data integrations Maple connects to. */
const TARGETS = {
	cloudflare: { _tag: "Integration", integration: "cloudflare" },
	supabase: { _tag: "Integration", integration: "supabase" },
	railway: { _tag: "Integration", integration: "railway" },
	aws: { _tag: "Integration", integration: "aws" },
	gcp: { _tag: "Integration", integration: "gcp" },
	planetscale: { _tag: "Integration", integration: "planetscale" },
	prometheus: { _tag: "Integration", integration: "prometheus" },
	kubernetes: { _tag: "Push", platform: "kubernetes" },
	docker: { _tag: "Push", platform: "docker" },
} as const satisfies Record<StackPlatform, SourcesFlow.FlowTarget>

/** The sheet closed: the step re-reads the providers. */
type DrawerOut = Readonly<{ _tag: "ClosedDrawer" }> | PageOutMessage

export type DrawerStep = Readonly<{
	drawer: ConnectDrawer
	commands: ReadonlyArray<Command.Command<DrawerMessage, never, Resources>>
	outMessage?: DrawerOut
}>

const toDialog = (message: Dialog.Message) => DrawerMessage.GotDialogMessage({ message })

const withFlow = (drawer: ConnectDrawer, step: SourcesFlow.FlowReturn): DrawerStep => {
	const next = { ...drawer, flow: step.model }
	const commands = Command.mapMessages(step.commands ?? [], (message) =>
		DrawerMessage.GotFlowMessage({ instance: drawer.instance, message }),
	)
	const out = step.outMessage
	if (out === undefined) return { drawer: next, commands }
	if (out._tag !== "ExitedConnectFlow") return { drawer: next, commands, outMessage: out }
	return withDialog({ ...next, isExited: true }, Dialog.close(next.dialog), commands)
}

const withDialog = (
	drawer: ConnectDrawer,
	step: ReturnType<typeof Dialog.update>,
	commands: DrawerStep["commands"] = [],
): DrawerStep => {
	const next = { ...drawer, dialog: step.model }
	const all = [...commands, ...Command.mapMessages(step.commands ?? [], toDialog)]
	return step.outMessage?._tag === "Closed"
		? { drawer: next, commands: all, outMessage: { _tag: "ClosedDrawer" } }
		: { drawer: next, commands: all }
}

/** A push source dismissed mid-way for this platform: Set up (or Show token) reopens it as it was. */
export const isResumable = (drawer: ConnectDrawer | null, platform: StackPlatform): boolean =>
	drawer !== null && drawer.platform === platform && !drawer.isExited && drawer.flow.integration === null

/**
 * Opens the sheet on the platform. A push source dismissed mid-way resumes (its create, its one-time
 * token); anything else starts a new flow, which re-reads the integration. The dialog is reused.
 */
export const openDrawer = (
	previous: ConnectDrawer | null,
	platform: StackPlatform,
	context: PageContext,
): DrawerStep => {
	const dialog = previous?.dialog ?? Dialog.init(DRAWER_ID, "sheet")
	const opened = Dialog.open(dialog)
	const dialogCommands = Command.mapMessages(opened.commands ?? [], toDialog)
	if (previous !== null && isResumable(previous, platform))
		return { drawer: { ...previous, dialog: opened.model }, commands: dialogCommands }
	const flow = SourcesFlow.initFlow(TARGETS[platform], context)
	const instance = (previous?.instance ?? 0) + 1
	const step = withFlow(
		{ platform, instance, isExited: false, flow: flow.model, dialog: opened.model },
		flow,
	)
	return { ...step, commands: [...step.commands, ...dialogCommands] }
}

/** The flow's Subscriptions (an OAuth popup, polls) run until it is left or replaced, open or not. */
export const isDrawerListening = (drawer: ConnectDrawer | null): drawer is ConnectDrawer =>
	drawer !== null && !drawer.isExited

export const updateDrawer = (
	drawer: ConnectDrawer,
	message: DrawerMessage,
	context: PageContext,
): DrawerStep =>
	DrawerMessage.match<DrawerStep>(message, {
		// A closed sheet still takes its own flow's results; a replaced flow's are dropped.
		GotFlowMessage: ({ instance, message: child }) =>
			instance !== null && instance !== drawer.instance
				? { drawer, commands: [] }
				: withFlow(drawer, SourcesFlow.updateFlow(drawer.flow, child, context)),
		GotDialogMessage: ({ message: child }) => withDialog(drawer, Dialog.update(drawer.dialog, child)),
	})

/** The source exists: its row reads Connected for the visit, open sheet or not. */
export const isDrawerDone = (drawer: ConnectDrawer): boolean => SourcesFlow.isFlowDone(drawer.flow)

/** The providers whose OAuth returns land here: the drawer opens on them to finish the connect. */
const PLATFORM_OF_FLOW = {
	cloudflare: "cloudflare",
	planetscale: "planetscale",
	supabase: "supabase",
	github: null,
	linear: null,
	chat_install: null,
	chat_identity: null,
} satisfies { readonly [K in OAuthReturnFlow]: StackPlatform | null }

/**
 * A provider's OAuth return waiting in this tab (a connect popup, or a redirect that came back
 * here): its platform, so the drawer opens and its integrations module finishes the return.
 */
export const pendingOAuthPlatform: Effect.Effect<Option.Option<StackPlatform>> = Effect.gen(function* () {
	const now = yield* Clock.currentTimeMillis
	const stashed = yield* peekOAuthReturn(browserStorage, now)
	return Option.flatMap(stashed, (request) => Option.fromNullishOr(PLATFORM_OF_FLOW[request.flow]))
})
