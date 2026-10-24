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
	flow: SourcesFlow.Model,
	dialog: Dialog.Model,
})
export type ConnectDrawer = typeof ConnectDrawer.Type

export const DrawerMessage = defineMessageUnion({
	GotFlowMessage: { message: SourcesFlow.Message },
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

/** The drawer closed: whether its source exists, so the row reads Connected. */
export type DrawerClosed = Readonly<{ _tag: "ClosedDrawer"; platform: StackPlatform; isDone: boolean }>
export type DrawerOut = DrawerClosed | PageOutMessage

export type DrawerStep = Readonly<{
	drawer: ConnectDrawer
	commands: ReadonlyArray<Command.Command<DrawerMessage, never, Resources>>
	outMessage?: DrawerOut
}>

const toFlow = (message: SourcesFlow.Message) => DrawerMessage.GotFlowMessage({ message })
const toDialog = (message: Dialog.Message) => DrawerMessage.GotDialogMessage({ message })

type FlowOut = SourcesFlow.FlowReturn["outMessage"]

const withFlow = (drawer: ConnectDrawer, step: SourcesFlow.FlowReturn): DrawerStep => {
	const next = { ...drawer, flow: step.model }
	const commands = Command.mapMessages(step.commands ?? [], toFlow)
	const out: FlowOut = step.outMessage
	if (out === undefined) return { drawer: next, commands }
	if (out._tag !== "ExitedConnectFlow") return { drawer: next, commands, outMessage: out }
	return closeDrawer(next, commands)
}

const closeDrawer = (drawer: ConnectDrawer, commands: DrawerStep["commands"] = []): DrawerStep => {
	const closed = Dialog.close(drawer.dialog)
	return withDialog(drawer, closed, commands)
}

const withDialog = (
	drawer: ConnectDrawer,
	step: ReturnType<typeof Dialog.update>,
	commands: DrawerStep["commands"] = [],
): DrawerStep => {
	const next = { ...drawer, dialog: step.model }
	const all = [...commands, ...Command.mapMessages(step.commands ?? [], toDialog)]
	return step.outMessage?._tag === "Closed"
		? {
				drawer: next,
				commands: all,
				outMessage: {
					_tag: "ClosedDrawer",
					platform: drawer.platform,
					isDone: SourcesFlow.isFlowDone(drawer.flow),
				},
			}
		: { drawer: next, commands: all }
}

/** A fresh flow for the platform each time, opened with the sheet's enter transition. */
export const openDrawer = (platform: StackPlatform, context: PageContext): DrawerStep => {
	const flow = SourcesFlow.initFlow(TARGETS[platform], context)
	const opened = Dialog.open(Dialog.init(DRAWER_ID, "sheet"))
	const drawer: ConnectDrawer = { platform, flow: flow.model, dialog: opened.model }
	const step = withFlow(drawer, flow)
	return { ...step, commands: [...step.commands, ...Command.mapMessages(opened.commands ?? [], toDialog)] }
}

export const updateDrawer = (
	drawer: ConnectDrawer,
	message: DrawerMessage,
	context: PageContext,
): DrawerStep =>
	DrawerMessage.match<DrawerStep>(message, {
		// A poll that lands after the drawer closed is dropped; the next open starts a new flow.
		GotFlowMessage: ({ message: child }) =>
			drawer.dialog.isOpen
				? withFlow(drawer, SourcesFlow.updateFlow(drawer.flow, child, context))
				: { drawer, commands: [] },
		GotDialogMessage: ({ message: child }) => withDialog(drawer, Dialog.update(drawer.dialog, child)),
	})

/** The providers whose OAuth returns land here: the drawer opens on them to finish the connect. */
const PLATFORM_OF_FLOW = {
	cloudflare: "cloudflare",
	planetscale: "planetscale",
	supabase: "supabase",
	github: null,
	hazel: null,
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
