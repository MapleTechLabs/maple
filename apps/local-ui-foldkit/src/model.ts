import * as Popover from "@maple/web-foldkit/ui/popover"
import * as Tabs from "@maple/web-foldkit/ui/tabs"
import * as Toast from "@maple/web-foldkit/ui/toast"
import { Schema } from "effect"
import { AsyncData } from "foldkit"
import { LoadFailure } from "./data/local-query"
import { PresenceResult } from "./data/signal-presence"
import { Copies } from "./page/kit/copies"
import { LocalEnv, Theme } from "./env"
import { TimeFormat } from "./page/kit/local-time"
import { PageModel } from "./page/registry"
import { AppRoute, Location } from "./route"
import { ServerState } from "./server/state"

/** The server-status poll: the probe in flight, and a version that retires superseded timers. */
export const Probe = Schema.Struct({ isInFlight: Schema.Boolean, version: Schema.Number })
export type Probe = typeof Probe.Type

export const Model = Schema.Struct({
	location: Location,
	route: AppRoute,
	/**
	 * Hashes seen in this document (lib/router.ts `visited`), so a detail page's Back returns to
	 * where it was opened from. A reload starts it over.
	 */
	visited: Schema.Array(Schema.String),
	/** The next URL change replaces the last entry (a filter tweak) instead of adding one. */
	isReplacing: Schema.Boolean,
	env: LocalEnv,
	/** `useRange`'s remembered range for pages opened without one. */
	rememberedRange: Schema.String,
	theme: Theme,
	/** The locale and zone timestamps render in (Flags). */
	timeFormat: TimeFormat,
	isSidebarOpen: Schema.Boolean,
	isSidebarOpenMobile: Schema.Boolean,
	maybeServer: Schema.Option(ServerState),
	probe: Probe,
	/** `ConnectButton`'s latch: loud until the first telemetry lands, quiet after. */
	hasIngested: Schema.Boolean,
	connect: Popover.Model,
	/** `InstallCommands` on the disconnected screen. */
	installTabs: Tabs.Model,
	/** `useSignalPresence`'s shared query (`["local", "signal-presence"]`). */
	presence: AsyncData.Schema(PresenceResult, LoadFailure).schema,
	/** A refresh invalidated the presence read: the next request fetches even inside `staleTime`. */
	isPresenceStale: Schema.Boolean,
	/** The connect popover's copy buttons. */
	copies: Copies,
	toasts: Toast.Model,
	page: PageModel,
})
export type Model = typeof Model.Type
