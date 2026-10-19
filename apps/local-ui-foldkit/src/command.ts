import { writeLocalStorage } from "@maple/ui/lib/local-storage"
import { Clock, Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { load, pushUrl, replaceUrl } from "foldkit/navigation"
import { fetchSignalPresence, PRESENCE_STALE_MS } from "./data/signal-presence"
import { RANGE_STORAGE_KEY, Theme } from "./env"
import { Message } from "./message"
import { probeServer } from "./server/probe"

/** `navigate(path, query, { replace })`: page moves push, in-place filter tweaks replace. */
export const Navigate = Command.define("NavigateLocal", {
	args: { hash: Schema.String, isReplace: Schema.Boolean },
	messages: [Message.CompletedNavigate],
	execute: ({ hash, isReplace }) =>
		(isReplace ? replaceUrl(hash) : pushUrl(hash)).pipe(Effect.as(Message.CompletedNavigate())),
})

/** A link to another origin (docs) is a full navigation. */
export const LoadExternal = Command.define("LoadLocalExternal", {
	args: { href: Schema.String },
	messages: [Message.CompletedNavigate],
	execute: ({ href }) => load(href).pipe(Effect.as(Message.CompletedNavigate())),
})

/** `goBack`: history back within the app. */
export const GoBack = Command.define("GoBackLocal", {
	messages: [Message.CompletedNavigate],
	execute: Effect.sync(() => {
		history.back()
		return Message.CompletedNavigate()
	}),
})

export const RememberRange = Command.define("RememberLocalRange", {
	args: { range: Schema.String },
	messages: [Message.CompletedRememberRange],
	execute: ({ range }) =>
		Effect.sync(() => {
			writeLocalStorage(RANGE_STORAGE_KEY, range)
			return Message.CompletedRememberRange()
		}),
})

export const ProbeServer = Command.define("ProbeLocalServer", {
	args: { apiBase: Schema.String },
	messages: [Message.CompletedProbeServer],
	execute: ({ apiBase }) =>
		Effect.gen(function* () {
			const outcome = yield* probeServer(apiBase)
			const checkedAtMs = yield* Clock.currentTimeMillis
			return Message.CompletedProbeServer({ outcome, checkedAtMs })
		}),
})

/** `useSignalPresence`: a read younger than `staleTime` is reused, else the store is asked again. */
export const FetchSignalPresence = Command.define("FetchLocalSignalPresence", {
	args: { apiBase: Schema.String, lastReadAtMs: Schema.NullOr(Schema.Number) },
	messages: [Message.SucceededFetchSignalPresence, Message.FailedFetchSignalPresence, Message.ReusedSignalPresence],
	execute: ({ apiBase, lastReadAtMs }) =>
		Effect.gen(function* () {
			const nowMs = yield* Clock.currentTimeMillis
			if (lastReadAtMs !== null && nowMs - lastReadAtMs < PRESENCE_STALE_MS) return Message.ReusedSignalPresence()
			return yield* fetchSignalPresence(apiBase).pipe(
				Effect.map((result) => Message.SucceededFetchSignalPresence({ result })),
				Effect.catch((failure) => Effect.succeed(Message.FailedFetchSignalPresence({ failure }))),
			)
		}),
})

/** Apply the OS theme the way `setTheme(theme, { persist: false })` does. */
export const ApplyTheme = Command.define("ApplyLocalTheme", {
	args: { theme: Theme },
	messages: [Message.CompletedApplyTheme],
	execute: ({ theme }) =>
		Effect.sync(() => {
			const root = document.documentElement
			root.classList.remove("light", "dark")
			root.classList.add(theme)
			root.style.colorScheme = theme
			return Message.CompletedApplyTheme()
		}),
})

/** `SidebarProvider` keeps the open state in a cookie for a week. */
export const SaveSidebarState = Command.define("SaveLocalSidebarState", {
	args: { isOpen: Schema.Boolean },
	messages: [Message.CompletedSaveSidebarState],
	execute: ({ isOpen }) =>
		Effect.sync(() => {
			document.cookie = `sidebar_state=${String(isOpen)}; path=/; max-age=${60 * 60 * 24 * 7}`
			return Message.CompletedSaveSidebarState()
		}),
})

export const WaitBeforeProbe =Command.define("WaitBeforeLocalProbe", {
	args: { version: Schema.Number, delayMs: Schema.Number },
	messages: [Message.ElapsedProbeDelay],
	execute: ({ version, delayMs }) =>
		Effect.as(Effect.sleep(Duration.millis(delayMs)), Message.ElapsedProbeDelay({ version })),
})
