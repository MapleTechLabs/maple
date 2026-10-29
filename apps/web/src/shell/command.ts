import { writeLocalStorage } from "@maple/ui/lib/local-storage"
import { Effect, Option, Schema } from "effect"
import { load } from "foldkit/navigation"
import { ReadCache } from "../data/read-cache"
import { requestKey } from "../data/request-key"
import { openGlobalChat } from "../page/chat/sheet/subscription"
import { clearSessionToken } from "../platform/auth-api"
import { ShellDefinition } from "./definition"
import { Message, Theme } from "./message"
import { SERVICES_INPUT, SERVICES_OPERATION } from "./palette/command"

/** `maple.global-namespace.<orgId>`. */
export const NAMESPACE_STORAGE_PREFIX = "maple.global-namespace."
/** `maple.infra-surfaces.<orgId>`: the org's last settled infra surfaces, JSON. */
export const INFRA_SURFACES_STORAGE_PREFIX = "maple.infra-surfaces."
/** The theme key the app and the pre-paint script in index.html share. */
export const THEME_STORAGE_KEY = "maple-theme"

/** Base UI moves DOM focus to the open popup and to the hovered or arrowed item. */
export const FocusElement = ShellDefinition.makeCommand("FocusElement", {
	args: { id: Schema.String },
	messages: [Message.CompletedFocusElement],
	handler: function* () {
		return ({ id }) =>
			Effect.sync(() => {
				const element = document.getElementById(id)
				if (element instanceof HTMLElement) element.focus({ preventScroll: true })
				return Message.CompletedFocusElement()
			})
	},
})

/** Arrow keys walk the open menu's items in DOM order, wrapping like Base UI's `loop`. */
export const FocusSiblingMenuItem = ShellDefinition.makeCommand("FocusSiblingMenuItem", {
	args: { popupId: Schema.String, step: Schema.Number },
	messages: [Message.CompletedFocusElement],
	handler: function* () {
		return ({ popupId, step }) =>
			Effect.sync(() => {
				const popup = document.getElementById(popupId)
				const items =
					popup === null ? [] : [...popup.querySelectorAll<HTMLElement>('[role="menuitem"]')]
				const current = items.findIndex((item) => item === document.activeElement)
				const next =
					current === -1
						? step > 0
							? 0
							: items.length - 1
						: (current + step + items.length) % items.length
				items[next]?.focus({ preventScroll: true })
				return Message.CompletedFocusElement()
			})
	},
})

/** `setTheme`: persist, then the `light`/`dark` class and `color-scheme` on `<html>`. */
export const SaveTheme = ShellDefinition.makeCommand("SaveTheme", {
	args: { theme: Theme },
	messages: [Message.CompletedSaveTheme],
	handler: function* () {
		return ({ theme }) =>
			Effect.sync(() => {
				writeLocalStorage(THEME_STORAGE_KEY, theme)
				const root = document.documentElement
				root.classList.remove("light", "dark")
				root.classList.add(theme)
				root.style.colorScheme = theme
				return Message.CompletedSaveTheme()
			})
	},
})

/** `setGlobalNamespace`: "All namespaces" removes the key. */
export const SaveNamespace = ShellDefinition.makeCommand("SaveNamespace", {
	args: { orgId: Schema.String, maybeNamespace: Schema.Option(Schema.String) },
	messages: [Message.CompletedSaveNamespace],
	handler: function* () {
		return ({ orgId, maybeNamespace }) => {
			const key = `${NAMESPACE_STORAGE_PREFIX}${orgId}`
			return Option.match(maybeNamespace, {
				onNone: () => Effect.ignore(Effect.try(() => localStorage.removeItem(key))),
				onSome: (namespace) => Effect.sync(() => writeLocalStorage(key, namespace)),
			}).pipe(Effect.as(Message.CompletedSaveNamespace()))
		}
	},
})

/** Remembers the org's settled surfaces, so the next boot lays the sidebar out from them. */
export const SaveInfraSurfaces = ShellDefinition.makeCommand("SaveInfraSurfaces", {
	args: { orgId: Schema.String, surfaces: Schema.Array(Schema.String) },
	messages: [Message.CompletedSaveInfraSurfaces],
	handler: function* () {
		return ({ orgId, surfaces }) =>
			Effect.sync(() => {
				writeLocalStorage(`${INFRA_SURFACES_STORAGE_PREFIX}${orgId}`, JSON.stringify(surfaces))
				return Message.CompletedSaveInfraSurfaces()
			})
	},
})

/** `SidebarProvider.setOpen`: the `sidebar_state` cookie (7 days). Never read back. */
export const SaveSidebarState = ShellDefinition.makeCommand("SaveSidebarState", {
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
// SESSION

/** `GuestMenu`'s log out: drop the self-hosted token and reload into `/sign-in`. */
export const LogOut = ShellDefinition.makeCommand("LogOut", {
	messages: [Message.CompletedLogOut],
	handler: function* () {
		return () =>
			clearSessionToken.pipe(Effect.andThen(load("/sign-in")), Effect.as(Message.CompletedLogOut()))
	},
})

/**
 * `focusSearch`: a page tags its primary search with `data-shortcut-focus="search"`. A field is
 * focused and selected; anything else (the traces Advanced Filter trigger) is clicked.
 */
export const FocusShortcutSearch = ShellDefinition.makeCommand("FocusShortcutSearch", {
	messages: [Message.CompletedFocusShortcutSearch],
	handler: function* () {
		return () =>
			Effect.sync(() => {
				const target = document.querySelector('[data-shortcut-focus="search"]')
				if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
					target.focus()
					target.select()
				} else if (target instanceof HTMLElement) target.click()
				return Message.CompletedFocusShortcutSearch()
			})
	},
})

/** `openGlobalChat()`: the root's chat sheet (`page/chat/sheet`) listens for its document event. */
export const OpenGlobalChat = ShellDefinition.makeCommand("OpenGlobalChat", {
	args: { isFocusVisible: Schema.Boolean },
	messages: [Message.CompletedOpenGlobalChat],
	handler: function* () {
		return ({ isFocusVisible }) =>
			Effect.sync(() => {
				openGlobalChat({ isFocusVisible })
				return Message.CompletedOpenGlobalChat()
			})
	},
})

/** The palette unmounted: its services read's idle TTL starts now. */
export const ReleasePaletteServices = ShellDefinition.makeCommand("ReleasePaletteServices", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedReleasePaletteServices],
	handler: function* () {
		return ({ orgId }) =>
			Effect.flatMap(ReadCache, (cache) =>
				cache.release([requestKey(orgId, SERVICES_OPERATION, SERVICES_INPUT)]),
			).pipe(Effect.as(Message.CompletedReleasePaletteServices()))
	},
})
