import type { GithubInstallationSelection } from "@maple/domain/http"
import type { Effect } from "effect"
import type { Command } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type * as Keyed from "@maple/views/data/keyed"
import type { LoadFailure } from "@maple/views/data/load-failure"
import type { Resources } from "../../platform/resources"
import type { PageContext } from "../contract"
import type { IntegrationId } from "./catalog"
import type { FlowContext, FlowSpec, FlowStage } from "./flow"
import type { Message } from "./message"
import type { Model, Statuses } from "./model"
import type { CardStatus, IntegrationOverview } from "./overview"

// One provider's part of `/integrations` and `/sources/new` as a self-contained module: it owns a
// sub-model and sub-message, and the hub mounts it (`provider-modules.ts`) and delegates to it.

/** What a provider sees of the hub when it updates: its status read, the clock, the shown card. */
export type ProviderEnv<S> = Readonly<{
	status: Keyed.Keyed<S, LoadFailure>
	nowMs: number
	/** The page shows this provider's card or flow. */
	isShown: boolean
	/** The viewer holds `integrations:manage`; false until the session's grants are read. */
	canManage: boolean
	/** The integration the page shows, if any. */
	integration: IntegrationId | null
	/** A connect popup attempt is out, for any provider. */
	isConnecting: boolean
	context: PageContext
}>

/** What only the hub can do, asked for by a provider's update. */
export type HubRequest =
	| Readonly<{ _tag: "ReadStatus"; mode: Keyed.ReadMode; name: keyof Statuses | null }>
	| Readonly<{ _tag: "Toast"; type: "success" | "error"; title: string; description: string }>
	| Readonly<{ _tag: "ReadClock" }>
	| Readonly<{ _tag: "SetClock"; nowMs: number }>
	| Readonly<{ _tag: "OpenDisconnect" }>
	| Readonly<{ _tag: "CloseDisconnect" }>
	| Readonly<{ _tag: "TrackDisconnected"; provider: string }>
	| Readonly<{ _tag: "TrackConnected"; provider: string }>
	| Readonly<{ _tag: "Navigate"; url: string }>

export const HubRequest = {
	/** Re-reads the provider's own status. */
	readStatus: (mode: Keyed.ReadMode): HubRequest => ({ _tag: "ReadStatus", mode, name: null }),
	/** Re-reads another of the hub's status reads the provider shows (PlanetScale's databases). */
	readStatusOf: (name: keyof Statuses, mode: Keyed.ReadMode): HubRequest => ({
		_tag: "ReadStatus",
		mode,
		name,
	}),
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
	/** Opens the page's shared disconnect dialog. */
	openDisconnect: (): HubRequest => ({ _tag: "OpenDisconnect" }),
	closeDisconnect: (): HubRequest => ({ _tag: "CloseDisconnect" }),
	/** `trackProduct("integration_disconnected")` for `provider`. */
	trackDisconnected: (provider: string): HubRequest => ({ _tag: "TrackDisconnected", provider }),
	/** `trackProduct("integration_connected")` for `provider`. */
	trackConnected: (provider: string): HubRequest => ({ _tag: "TrackConnected", provider }),
	/** Leaves for another page (Google Cloud's logs and infrastructure links). */
	navigate: (url: string): HubRequest => ({ _tag: "Navigate", url }),
}

/** A provider update: its sub-model, its own Commands, and the hub requests that run first. */
export type ProviderReturn<M, Msg> = Readonly<{
	model: M
	commands?: ReadonlyArray<Command.Command<Msg, never, Resources>>
	requests?: ReadonlyArray<HubRequest>
}>

/** A message's update, which may also rewrite the status in place before its re-read (an answered write). */
export type ProviderUpdate<M, Msg, S> = ProviderReturn<M, Msg> & Readonly<{ status?: (status: S) => S }>

/** The status read that answered: `isCurrent` when it answers the read in flight. */
export type StatusAnswer<S> = Readonly<{ isCurrent: boolean; previous: Keyed.Keyed<S, LoadFailure> }>

/** What a header badge or catalog row reads besides its status: the row's id, the clock, every read. */
export type StatusContext = Readonly<{ id: IntegrationId; nowMs: number; statuses: Statuses }>

/** A provider step outside its own messages (a hub event). */
export type ProviderHook<S, M, Msg> = (model: M, env: ProviderEnv<S>) => ProviderReturn<M, Msg>

export type ProviderModule<S, M, Msg> = Readonly<{
	/** Names the module; `MODULE_OF` (`provider-modules.ts`) routes page ids to it. */
	id: string
	/** The status read the hub keeps for the provider (`Statuses`), shared with the sidebar and headers. */
	statusRead: Readonly<{
		/** The read's Command name. */
		name: string
		read: (refresh: boolean) => Effect.Effect<S, unknown, Resources>
	}>
	init: () => M
	update: (model: M, message: Msg, env: ProviderEnv<S>) => ProviderUpdate<M, Msg, S>
	/** The card mounted: the reads it shows. */
	onEnter?: ProviderHook<S, M, Msg>
	/** The session's grants were read: the reads only a manager may make. */
	onSession?: ProviderHook<S, M, Msg>
	/** The page's clock was read. */
	onClock?: ProviderHook<S, M, Msg>
	/** The status read answered (`env.status` already holds the answer). */
	onStatus?: (model: M, env: ProviderEnv<S>, answer: StatusAnswer<S>) => ProviderReturn<M, Msg>
	/** A new OAuth connect attempt starts. */
	onConnectStart?: ProviderHook<S, M, Msg>
	/** A step in flight that a new connect attempt, of any provider, would race. */
	blocksConnect?: (model: M) => boolean
	/** The connect start succeeded and its popup is out. */
	onConnectOpened?: ProviderHook<S, M, Msg>
	/** A successful OAuth return carried accounts to choose from (GitHub's installations). */
	onConnectPayload?: (
		model: M,
		payload: GithubInstallationSelection,
		env: ProviderEnv<S>,
	) => ProviderReturn<M, Msg>
	/** An OAuth connect came back successful. */
	onConnected?: ProviderHook<S, M, Msg>
	/** `onConnected` and `onRelayedConnect` re-read the status themselves, in place of the hub. */
	replacesConnectedRead?: boolean
	/** The connect popup closed; replaces the hub's status re-read. */
	onPopupClosed?: ProviderHook<S, M, Msg>
	/** The hub's disconnect of this provider succeeded. */
	onDisconnected?: ProviderHook<S, M, Msg>
	/** Another tab finished a successful connect (`RELAY_CHANNEL`); its side effects already ran there. */
	onRelayedConnect?: ProviderHook<S, M, Msg>
	/** The shared disconnect dialog's confirm, when the module runs its own removal. */
	onConfirmDisconnect?: ProviderHook<S, M, Msg>
	/** The module's own removal is in flight: the shared dialog ignores its messages. */
	isDisconnecting?: (model: M) => boolean
	/** Each a tick every `everyMs` while `isActive`, answered by `tick`; `fast` ticks come first. */
	subscriptions?: ReadonlyArray<
		Readonly<{
			everyMs: number
			fast?: Readonly<{ everyMs: number; ticks: number }>
			isActive: (model: M, env: Omit<ProviderEnv<S>, "context">) => boolean
			/** The ticks start over when this changes while active (the selected scrape target). */
			restartKey?: (model: M) => string
			tick: Msg
		}>
	>
	/** One-shot: `afterMs` after `versionOf` turns to a version, once the tab is back, `fire` sends. */
	delayed?: Readonly<{
		afterMs: number
		versionOf: (model: M) => number | null
		fire: (version: number) => ReadonlyArray<Msg>
	}>
	/** The source page's card, under the integration's header; `focusId`: the one source shown. */
	card: (
		h: HtmlBuilder<Message>,
		model: Model,
		timeZone: string,
		focusId: string | null,
		/** The page's id, for a module that `owns` several. */
		integration: IntegrationId,
	) => ReadonlyArray<Html>
	/** The connected header's actions. */
	headerActions?: (h: HtmlBuilder<Message>, model: Model) => ReadonlyArray<Html>
	/** The connected header's line under the title, in place of the overview's. */
	headerStatus?: (h: HtmlBuilder<Message>, model: Model, timeZone: string) => Html | undefined
	/** Where the provider stands in `/sources/new`'s flow, and the step's view; the generic flow without. */
	flow?: (model: Model, integration: IntegrationId, context: FlowContext) => FlowSpec
	flowView?: (
		h: HtmlBuilder<Message>,
		model: Model,
		stage: FlowStage,
		timeZone: string,
		integration: IntegrationId,
	) => Html
	/** The header badge; `null` while loading. */
	cardStatus: (status: Keyed.Keyed<S, LoadFailure>, context: StatusContext) => CardStatus | null
	/** The catalog row's overview. */
	overview: (status: Keyed.Keyed<S, LoadFailure>, context: StatusContext) => IntegrationOverview
}>
