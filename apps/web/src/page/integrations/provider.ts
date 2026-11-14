import type { Effect } from "effect"
import type { Command } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type * as Keyed from "@maple/views/data/keyed"
import type { LoadFailure } from "@maple/views/data/load-failure"
import type { Resources } from "../../platform/resources"
import type { PageContext } from "../contract"
import type { IntegrationId } from "./catalog"
import type { FlowSpec, FlowStage } from "./flow"
import type { Message } from "./message"
import type { Model } from "./model"
import type { CardStatus, IntegrationOverview } from "./overview"

// One provider's part of `/integrations` and `/sources/new` as a self-contained module: it owns a
// sub-model and sub-message, and the hub mounts it (`provider-modules.ts`) and delegates to it.

/** What a provider sees of the hub when it updates: its status read, the clock, the shown card. */
export type ProviderEnv<S> = Readonly<{
	status: Keyed.Keyed<S, LoadFailure>
	nowMs: number
	/** The page shows this provider's card or flow. */
	isShown: boolean
	context: PageContext
}>

/** What only the hub can do, asked for by a provider's update. */
export type HubRequest =
	| Readonly<{ _tag: "ReadStatus"; mode: Keyed.ReadMode }>
	| Readonly<{ _tag: "Toast"; type: "success" | "error"; title: string; description: string }>
	| Readonly<{ _tag: "ReadClock" }>
	| Readonly<{ _tag: "SetClock"; nowMs: number }>

export const HubRequest = {
	/** Re-reads the provider's own status. */
	readStatus: (mode: Keyed.ReadMode): HubRequest => ({ _tag: "ReadStatus", mode }),
	toast: (type: "success" | "error", title: string, description = ""): HubRequest => ({
		_tag: "Toast",
		type,
		title,
		description,
	}),
	/** Reads the page's clock, which every provider's `onClock` then answers. */
	readClock: (): HubRequest => ({ _tag: "ReadClock" }),
	/** Sets the page's clock to a reading the provider took itself. */
	setClock: (nowMs: number): HubRequest => ({ _tag: "SetClock", nowMs }),
}

/** A provider update: its sub-model, its own Commands, and the hub requests that run first. */
export type ProviderReturn<M, Msg> = Readonly<{
	model: M
	commands?: ReadonlyArray<Command.Command<Msg, never, Resources>>
	requests?: ReadonlyArray<HubRequest>
}>

/** A provider step outside its own messages (a hub event). */
export type ProviderHook<S, M, Msg> = (model: M, env: ProviderEnv<S>) => ProviderReturn<M, Msg>

export type ProviderModule<S, M, Msg> = Readonly<{
	id: IntegrationId
	/** The status read the hub keeps for the provider (`Statuses`), shared with the sidebar and headers. */
	statusRead: Readonly<{
		/** The read's Command name. */
		name: string
		read: (refresh: boolean) => Effect.Effect<S, unknown, Resources>
	}>
	init: () => M
	update: (model: M, message: Msg, env: ProviderEnv<S>) => ProviderReturn<M, Msg>
	/** The card mounted: the reads it shows. */
	onEnter?: ProviderHook<S, M, Msg>
	/** The page's clock was read. */
	onClock?: ProviderHook<S, M, Msg>
	/** The status read answered; `isCurrent`: it answers the read in flight. */
	onStatus?: (model: M, env: ProviderEnv<S>, isCurrent: boolean) => ProviderReturn<M, Msg>
	/** An OAuth connect came back successful. */
	onConnected?: ProviderHook<S, M, Msg>
	/** A tick every `everyMs` while `isActive`, answered by `tick`. */
	subscription?: Readonly<{
		everyMs: number
		isActive: (model: M, env: Omit<ProviderEnv<S>, "context">) => boolean
		tick: Msg
	}>
	/** The source page's card, under the integration's header. */
	card: (h: HtmlBuilder<Message>, model: Model, timeZone: string) => Html
	/** Where the provider stands in `/sources/new`'s flow, and the step's view. */
	flow: (model: Model) => FlowSpec
	flowView: (h: HtmlBuilder<Message>, model: Model, stage: FlowStage, timeZone: string) => Html
	/** The header badge; `null` while loading. */
	cardStatus: (status: Keyed.Keyed<S, LoadFailure>) => CardStatus | null
	/** The catalog row's overview. */
	overview: (status: Keyed.Keyed<S, LoadFailure>) => IntegrationOverview
}>
