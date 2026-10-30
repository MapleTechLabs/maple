import { writeLocalStorage } from "@maple/ui/lib/local-storage"
import { Clock, Duration, Effect, Layer, Schema } from "effect"
import { HttpClient } from "effect/http"
import { load, pushUrl, replaceUrl } from "foldkit/navigation"
import { fetchSignalPresence, PRESENCE_STALE_MS } from "./data/signal-presence"
import { RANGE_STORAGE_KEY, Theme } from "./env"
import { Message } from "./message"
import { ApplicationDefinition } from "./page/application-definition"
import { probeServer } from "./server/probe"

/** `navigate(path, query, { replace })`: page moves push, in-place filter tweaks replace. */
export const Navigate = ApplicationDefinition.makeCommand("NavigateLocal", {
	args: { hash: Schema.String, isReplace: Schema.Boolean },
	messages: [Message.CompletedNavigate],
	handler: function* () {
		return ({ hash, isReplace }) =>
			(isReplace ? replaceUrl(hash) : pushUrl(hash)).pipe(Effect.as(Message.CompletedNavigate()))
	},
})

/** A link to another origin (docs) is a full navigation. */
export const LoadExternal = ApplicationDefinition.makeCommand("LoadLocalExternal", {
	args: { href: Schema.String },
	messages: [Message.CompletedNavigate],
	handler: function* () {
		return ({ href }) => load(href).pipe(Effect.as(Message.CompletedNavigate()))
	},
})

/** `goBack`: history back within the app. */
export const GoBack = ApplicationDefinition.makeCommand("GoBackLocal", {
	messages: [Message.CompletedNavigate],
	handler: function* () {
		return () =>
			Effect.sync(() => {
				history.back()
				return Message.CompletedNavigate()
			})
	},
})

export const RememberRange = ApplicationDefinition.makeCommand("RememberLocalRange", {
	args: { range: Schema.String },
	messages: [Message.CompletedRememberRange],
	handler: function* () {
		return ({ range }) =>
			Effect.sync(() => {
				writeLocalStorage(RANGE_STORAGE_KEY, range)
				return Message.CompletedRememberRange()
			})
	},
})

export const ProbeServer = ApplicationDefinition.makeCommand("ProbeLocalServer", {
	args: { apiBase: Schema.String },
	messages: [Message.CompletedProbeServer],
	handler: function* () {
		const client = yield* HttpClient.HttpClient
		return ({ apiBase }) =>
			Effect.gen(function* () {
				const outcome = yield* probeServer(apiBase)
				const checkedAtMs = yield* Clock.currentTimeMillis
				return Message.CompletedProbeServer({ outcome, checkedAtMs })
			}).pipe(Effect.provideService(HttpClient.HttpClient, client))
	},
})

/** `useSignalPresence`: a read younger than `staleTime` is reused, else the store is asked again. */
export const FetchSignalPresence = ApplicationDefinition.makeCommand("FetchLocalSignalPresence", {
	args: { apiBase: Schema.String, lastReadAtMs: Schema.NullOr(Schema.Number) },
	messages: [Message.SucceededFetchSignalPresence, Message.FailedFetchSignalPresence, Message.ReusedSignalPresence],
	handler: function* () {
		const client = yield* HttpClient.HttpClient
		return ({ apiBase, lastReadAtMs }) =>
			Effect.gen(function* () {
				const nowMs = yield* Clock.currentTimeMillis
				if (lastReadAtMs !== null && nowMs - lastReadAtMs < PRESENCE_STALE_MS) return Message.ReusedSignalPresence()
				return yield* fetchSignalPresence(apiBase).pipe(
					Effect.map((result) => Message.SucceededFetchSignalPresence({ result })),
					Effect.catch((failure) => Effect.succeed(Message.FailedFetchSignalPresence({ failure }))),
				)
			}).pipe(Effect.provideService(HttpClient.HttpClient, client))
	},
})

/** Apply the OS theme the way `setTheme(theme, { persist: false })` does. */
export const ApplyTheme = ApplicationDefinition.makeCommand("ApplyLocalTheme", {
	args: { theme: Theme },
	messages: [Message.CompletedApplyTheme],
	handler: function* () {
		return ({ theme }) =>
			Effect.sync(() => {
				const root = document.documentElement
				root.classList.remove("light", "dark")
				root.classList.add(theme)
				root.style.colorScheme = theme
				return Message.CompletedApplyTheme()
			})
	},
})

/** `SidebarProvider` keeps the open state in a cookie for a week. */
export const SaveSidebarState = ApplicationDefinition.makeCommand("SaveLocalSidebarState", {
	args: { isOpen: Schema.Boolean },
	messages: [Message.CompletedSaveSidebarState],
	handler: function* () {
		return ({ isOpen }) =>
			Effect.sync(() => {
				document.cookie = `sidebar_state=${String(isOpen)}; path=/; max-age=${60 * 60 * 24 * 7}`
				return Message.CompletedSaveSidebarState()
			})
	},
})

export const WaitBeforeProbe = ApplicationDefinition.makeCommand("WaitBeforeLocalProbe", {
	args: { version: Schema.Number, delayMs: Schema.Number },
	messages: [Message.ElapsedProbeDelay],
	handler: function* () {
		return ({ version, delayMs }) =>
			Effect.as(Effect.sleep(Duration.millis(delayMs)), Message.ElapsedProbeDelay({ version }))
	},
})

/** The root's own Command handlers; the page and shell Blocks bring theirs through their Bindings. */
export const CommandsLayer = Layer.mergeAll(
	Navigate.layer,
	LoadExternal.layer,
	GoBack.layer,
	RememberRange.layer,
	ProbeServer.layer,
	FetchSignalPresence.layer,
	ApplyTheme.layer,
	SaveSidebarState.layer,
	WaitBeforeProbe.layer,
)
