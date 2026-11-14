import { Array as Arr, Option } from "effect"
import { Command as FoldkitCommand } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type * as Keyed from "@maple/views/data/keyed"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { type PageContext, PageOutMessage, type PageReturn } from "../contract"
import { RAILWAY } from "../infra-integrations/railway/integration/railway-provider"
import { SUPABASE } from "../infra-integrations/supabase/integration/supabase-provider"
import { type IntegrationId, integrationOfSearch } from "./catalog"
import { ReadClock } from "./command"
import type { FlowSpec, FlowStage } from "./flow"
import { Message } from "./message"
import type { Model, Statuses } from "./model"
import type { CardStatus, IntegrationOverview } from "./overview"
import type { HubRequest, ProviderEnv, ProviderModule, ProviderReturn } from "./provider"
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
	id: IntegrationId
	onEnter: (model: Model, context: PageContext) => Return
	onClock: (model: Model, context: PageContext) => Return
	onStatus: (model: Model, context: PageContext, isCurrent: boolean) => Return
	onConnected: (model: Model, context: PageContext) => Return
	ticker: Readonly<{ everyMs: number; isActive: (model: Model) => boolean; tick: Message }> | null
	card: (h: HtmlBuilder<Message>, model: Model, timeZone: string) => Html
	flow: (model: Model) => FlowSpec
	flowView: (h: HtmlBuilder<Message>, model: Model, stage: FlowStage, timeZone: string) => Html
	cardStatus: (statuses: Statuses) => CardStatus | null
	overview: (statuses: Statuses) => IntegrationOverview
}>

const isShownIn = (model: Model, id: IntegrationId): boolean =>
	integrationOfSearch(model.search.integration) === id

const applyRequest =
	(statusName: keyof Statuses, context: PageContext, request: HubRequest) =>
	(model: Model): Return => {
		switch (request._tag) {
			case "ReadStatus":
				return requestStatus(model, context, statusName, request.mode)
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
		isShown: isShownIn(model, mount.module.id),
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
} => {
	const { module } = spec
	const hook =
		(step: ((sub: M, env: ProviderEnv<S>) => ProviderReturn<M, Msg>) | undefined) =>
		(model: Model, context: PageContext): Return =>
			step === undefined ? { model } : run(spec, model, context, step)
	const subscription = module.subscription
	return {
		id: module.id,
		initial: module.init,
		update: (model, message, context) =>
			run(spec, model, context, (sub, env) => module.update(sub, message, env)),
		onEnter: hook(module.onEnter),
		onClock: hook(module.onClock),
		onConnected: hook(module.onConnected),
		onStatus: (model, context, isCurrent) => {
			const onStatus = module.onStatus
			return onStatus === undefined
				? { model }
				: run(spec, model, context, (sub, env) => onStatus(sub, env, isCurrent))
		},
		ticker:
			subscription === undefined
				? null
				: {
						everyMs: subscription.everyMs,
						isActive: (model) =>
							subscription.isActive(spec.get(model), {
								status: spec.slot(model.statuses),
								nowMs: model.nowMs,
								isShown: isShownIn(model, module.id),
							}),
						tick: spec.toHub(subscription.tick),
					},
		card: module.card,
		flow: module.flow,
		flowView: module.flowView,
		cardStatus: (statuses) => module.cardStatus(spec.slot(statuses)),
		overview: (statuses) => module.overview(spec.slot(statuses)),
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

/** The providers built as modules; the rest still live in the hub's own Model, Message and update. */
export const PROVIDER_MODULES: ReadonlyArray<MountedProvider> = [RAILWAY_PROVIDER, SUPABASE_PROVIDER]

export const providerModuleOf = (id: string | null): MountedProvider | undefined =>
	Option.getOrUndefined(Arr.findFirst(PROVIDER_MODULES, (provider) => provider.id === id))

/** Runs one hook on every module, in order. */
export const everyProvider = (
	model: Model,
	step: (provider: MountedProvider) => (model: Model) => Return,
): Return => chain(model, Arr.map(PROVIDER_MODULES, step))
