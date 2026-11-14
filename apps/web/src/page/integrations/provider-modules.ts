import { Array as Arr, Function as Fn, Option } from "effect"
import { Command as FoldkitCommand } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type * as Keyed from "@maple/views/data/keyed"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { type PageContext, PageOutMessage, type PageReturn } from "../contract"
import { RAILWAY } from "../infra-integrations/railway/integration/railway-provider"
import { SUPABASE } from "../infra-integrations/supabase/integration/supabase-provider"
import * as Dialog from "@maple/views/ui/dialog"
import { type IntegrationId, integrationOfSearch } from "./catalog"
import { SEARCH_CONSOLE } from "./search-console-provider"
import { LINEAR } from "./linear-provider"
import { VERCEL } from "../infra-integrations/vercel/integration/vercel-provider"
import { PLANETSCALE } from "../infra-integrations/planetscale/integration/planetscale-provider"
import { CHAT } from "./chat-provider"
import { ReadClock, TrackDisconnected } from "./command"
import type { FlowSpec, FlowStage } from "./flow"
import { Message } from "./message"
import type { Model, Statuses } from "./model"
import type { CardStatus, IntegrationOverview } from "./overview"
import type {
	HubRequest,
	ProviderEnv,
	ProviderModule,
	ProviderReturn,
	StatusAnswer,
	StatusContext,
} from "./provider"
import { chain, requestStatus } from "./update-status"

// The provider modules the hub delegates to, each mounted on its Model slot and Message wrapper.

type Return = PageReturn<Model, Message>

type Mount<K extends keyof Statuses, S, M, Msg> = Readonly<{
	module: ProviderModule<S, M, Msg>
	/** The module's status read: its slot in `Statuses`. */
	statusName: K
	/** That same slot; typed so a slot other than `statusName`'s does not compile. */
	slot: (statuses: Statuses) => Statuses[K] & Keyed.Keyed<S, LoadFailure>
	get: (model: Model) => M
	set: (model: Model, sub: M) => Model
	toHub: (message: Msg) => Message
}>

/** A mounted module as the hub sees it: its types closed over, so every provider fits one list. */
export type MountedProvider = Readonly<{
	id: string
	owns: (id: IntegrationId) => boolean
	onEnter: (model: Model, context: PageContext) => Return
	onClock: (model: Model, context: PageContext) => Return
	onConnected: (model: Model, context: PageContext) => Return
	onRelayedConnect: (model: Model, context: PageContext) => Return
	/** `null`: the hub's own disconnect runs. */
	onConfirmDisconnect: ((model: Model, context: PageContext) => Return) | null
	isDisconnecting: (model: Model) => boolean
	ticker: Readonly<{
		everyMs: number
		fast: Readonly<{ everyMs: number; ticks: number }> | null
		isActive: (model: Model) => boolean
		tick: Message
	}> | null
	card: (
		h: HtmlBuilder<Message>,
		model: Model,
		timeZone: string,
		focusId: string | null,
	) => ReadonlyArray<Html>
	headerActions: ((h: HtmlBuilder<Message>, model: Model) => ReadonlyArray<Html>) | null
	headerStatus: ((h: HtmlBuilder<Message>, model: Model, timeZone: string) => Html | undefined) | null
	/** `null`: the generic flow. */
	flow: ((model: Model) => FlowSpec) | null
	flowView: ((h: HtmlBuilder<Message>, model: Model, stage: FlowStage, timeZone: string) => Html) | null
	cardStatus: (statuses: Statuses, context: Omit<StatusContext, "statuses">) => CardStatus | null
	overview: (statuses: Statuses, context: Omit<StatusContext, "statuses">) => IntegrationOverview
}>

const ownsOf =
	<S, M, Msg>(module: ProviderModule<S, M, Msg>) =>
	(id: IntegrationId | null): boolean =>
		id !== null && (module.owns === undefined ? id === module.id : module.owns(id))

const isShownIn = <S, M, Msg>(model: Model, module: ProviderModule<S, M, Msg>): boolean =>
	ownsOf(module)(integrationOfSearch(model.search.integration))

/** A step of the page's shared disconnect dialog. */
export const withDisconnectDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, disconnect: { ...model.disconnect, dialog: step.model } },
	commands: FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
		Message.GotDisconnectDialogMessage({ message }),
	),
})

const applyRequest =
	(statusName: keyof Statuses, context: PageContext, request: HubRequest) =>
	(model: Model): Return => {
		switch (request._tag) {
			case "ReadStatus":
				return requestStatus(model, context, request.name ?? statusName, request.mode)
			case "Toast":
				return {
					model,
					outMessage: PageOutMessage.RequestedToast({
						type: request.type,
						title: request.title,
						description: request.description,
					}),
				}
			case "ReadClock":
				return { model, commands: [ReadClock()] }
			case "SetClock":
				return { model: { ...model, nowMs: request.nowMs } }
			case "OpenDisconnect":
				return withDisconnectDialog(model, Dialog.open(model.disconnect.dialog))
			case "CloseDisconnect":
				return withDisconnectDialog(model, Dialog.close(model.disconnect.dialog))
			case "TrackDisconnected":
				return { model, commands: [TrackDisconnected({ provider: request.provider })] }
		}
	}

/** Runs one module step on its slot: its hub requests first, in order, then its own Commands. */
const run = <K extends keyof Statuses, S, M, Msg>(
	mount: Mount<K, S, M, Msg>,
	model: Model,
	context: PageContext,
	step: (sub: M, env: ProviderEnv<S>) => ProviderReturn<M, Msg>,
): Return => {
	const env: ProviderEnv<S> = {
		status: mount.slot(model.statuses),
		nowMs: model.nowMs,
		isShown: isShownIn(model, mount.module),
		integration: integrationOfSearch(model.search.integration),
		context,
	}
	const result = step(mount.get(model), env)
	const requested = chain(
		// An unchanged sub-model keeps the Model, as a no-op update did before.
		result.model === mount.get(model) ? model : mount.set(model, result.model),
		Arr.map(result.requests ?? [], (request) => applyRequest(mount.statusName, context, request)),
	)
	return {
		...requested,
		commands: [
			...(requested.commands ?? []),
			...FoldkitCommand.mapMessages(result.commands ?? [], mount.toHub),
		],
	}
}

const mount = <K extends keyof Statuses, S, M, Msg>(
	spec: Mount<K, S, M, Msg>,
): MountedProvider & {
	/** The module's sub-model at entry. */
	readonly initial: () => M
	readonly update: (model: Model, message: Msg, context: PageContext) => Return
	/** The hub accepted the module's status read into its slot. */
	readonly onStatus: (model: Model, context: PageContext, answer: StatusAnswer<S>) => Return
} => {
	const { module } = spec
	const hook =
		(step: ((sub: M, env: ProviderEnv<S>) => ProviderReturn<M, Msg>) | undefined) =>
		(model: Model, context: PageContext): Return =>
			step === undefined ? { model } : run(spec, model, context, step)
	const subscription = module.subscription
	const isDisconnecting = module.isDisconnecting
	return {
		id: module.id,
		owns: ownsOf(module),
		initial: module.init,
		update: (model, message, context) =>
			run(spec, model, context, (sub, env) => module.update(sub, message, env)),
		onEnter: hook(module.onEnter),
		onClock: hook(module.onClock),
		onConnected: hook(module.onConnected),
		onRelayedConnect: hook(module.onRelayedConnect),
		onConfirmDisconnect:
			module.onConfirmDisconnect === undefined ? null : hook(module.onConfirmDisconnect),
		isDisconnecting: (model) => isDisconnecting !== undefined && isDisconnecting(spec.get(model)),
		onStatus: (model, context, answer) => {
			const onStatus = module.onStatus
			return onStatus === undefined
				? { model }
				: run(spec, model, context, (sub, env) => onStatus(sub, env, answer))
		},
		ticker:
			subscription === undefined
				? null
				: {
						everyMs: subscription.everyMs,
						fast: subscription.fast ?? null,
						isActive: (model) =>
							subscription.isActive(spec.get(model), {
								status: spec.slot(model.statuses),
								nowMs: model.nowMs,
								isShown: isShownIn(model, module),
								integration: integrationOfSearch(model.search.integration),
							}),
						tick: spec.toHub(subscription.tick),
					},
		card: module.card,
		headerActions: module.headerActions ?? null,
		headerStatus: module.headerStatus ?? null,
		flow: module.flow ?? null,
		flowView: module.flowView ?? null,
		cardStatus: (statuses, context) => module.cardStatus(spec.slot(statuses), { ...context, statuses }),
		overview: (statuses, context) => module.overview(spec.slot(statuses), { ...context, statuses }),
	}
}

export const RAILWAY_PROVIDER = mount({
	module: RAILWAY,
	statusName: "railway",
	slot: (statuses) => statuses.railway,
	get: (model) => model.railwayCard,
	set: (model, railwayCard) => ({ ...model, railwayCard }),
	toHub: (message) => Message.GotRailwayMessage({ message }),
})

export const SUPABASE_PROVIDER = mount({
	module: SUPABASE,
	statusName: "supabase",
	slot: (statuses) => statuses.supabase,
	get: (model) => model.supabaseCard,
	set: (model, supabaseCard) => ({ ...model, supabaseCard }),
	toHub: (message) => Message.GotSupabaseMessage({ message }),
})

export const SEARCH_CONSOLE_PROVIDER = mount({
	module: SEARCH_CONSOLE,
	statusName: "searchConsole",
	slot: (statuses) => statuses.searchConsole,
	get: (model) => model.searchConsoleCard,
	set: (model, searchConsoleCard) => ({ ...model, searchConsoleCard }),
	toHub: (message) => Message.GotSearchConsoleMessage({ message }),
})

export const LINEAR_PROVIDER = mount({
	module: LINEAR,
	statusName: "linear",
	slot: (statuses) => statuses.linear,
	get: () => null,
	set: (model) => model,
	toHub: Fn.absurd,
})

export const CHAT_PROVIDER = mount({
	module: CHAT,
	statusName: "chat",
	slot: (statuses) => statuses.chat,
	get: (model) => model.chatCard,
	set: (model, chatCard) => ({ ...model, chatCard }),
	toHub: (message) => Message.GotChatMessage({ message }),
})

export const VERCEL_PROVIDER = mount({
	module: VERCEL,
	statusName: "vercel",
	slot: (statuses) => statuses.vercel,
	get: (model) => model.vercelCard,
	set: (model, vercelCard) => ({ ...model, vercelCard }),
	toHub: (message) => Message.GotVercelMessage({ message }),
})

export const PLANETSCALE_PROVIDER = mount({
	module: PLANETSCALE,
	statusName: "planetscale",
	slot: (statuses) => statuses.planetscale,
	get: (model) => model.planetscaleCard,
	set: (model, planetscaleCard) => ({ ...model, planetscaleCard }),
	toHub: (message) => Message.GotPlanetscaleMessage({ message }),
})

/** The providers built as modules; the rest still live in the hub's own Model, Message and update. */
export const PROVIDER_MODULES: ReadonlyArray<MountedProvider> = [
	RAILWAY_PROVIDER,
	SUPABASE_PROVIDER,
	SEARCH_CONSOLE_PROVIDER,
	LINEAR_PROVIDER,
	CHAT_PROVIDER,
	VERCEL_PROVIDER,
	PLANETSCALE_PROVIDER,
]

export const providerModuleOf = (id: IntegrationId | null): MountedProvider | undefined =>
	id === null
		? undefined
		: Option.getOrUndefined(Arr.findFirst(PROVIDER_MODULES, (provider) => provider.owns(id)))

/** Runs one hook on every module, in order. */
export const everyProvider = (
	model: Model,
	step: (provider: MountedProvider) => (model: Model) => Return,
): Return => chain(model, Arr.map(PROVIDER_MODULES, step))
