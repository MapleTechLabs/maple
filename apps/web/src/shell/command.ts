import { writeLocalStorage } from "@maple/ui/lib/local-storage"
import { Array as Arr, Effect, Option, Schema } from "effect"
import { Command } from "foldkit"
import { load } from "foldkit/navigation"
import { clearSessionToken } from "../platform/auth-api"
import { Message, Theme } from "./message"

/** `maple.global-namespace.<orgId>`. */
export const NAMESPACE_STORAGE_PREFIX = "maple.global-namespace."
/** `maple.infra-surfaces.<orgId>`: the org's last settled infra surfaces, JSON. */
export const INFRA_SURFACES_STORAGE_PREFIX = "maple.infra-surfaces."
/** The theme key the app and the pre-paint script in index.html share. */
export const THEME_STORAGE_KEY = "maple-theme"

/** localStorage threw: disabled, full, or blocked by the browser. */
export class ShellStorageError extends Schema.TaggedError<ShellStorageError>()(
	"@maple/web/ShellStorageError",
	{
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {}

const encodeSurfaces = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)))

/** Base UI moves DOM focus to the open popup and to the hovered or arrowed item. */
export const FocusElement = Command.define("FocusElement", {
	args: { id: Schema.String },
	messages: [Message.CompletedFocusElement],
	execute: ({ id }) =>
		Effect.sync(() => {
			const element = document.getElementById(id)
			if (element instanceof HTMLElement) element.focus({ preventScroll: true })
			return Message.CompletedFocusElement()
		}),
})

/** Arrow keys walk the open menu's items in DOM order, wrapping like Base UI's `loop`. */
export const FocusSiblingMenuItem = Command.define("FocusSiblingMenuItem", {
	args: { popupId: Schema.String, step: Schema.Number },
	messages: [Message.CompletedFocusElement],
	execute: ({ popupId, step }) =>
		Effect.sync(() => {
			const popup = document.getElementById(popupId)
			const items = popup === null ? [] : [...popup.querySelectorAll<HTMLElement>('[role="menuitem"]')]
			const next = Option.match(
				Arr.findFirstIndex(items, (item) => item === document.activeElement),
				{
					onNone: () => (step > 0 ? 0 : items.length - 1),
					onSome: (current) => (current + step + items.length) % items.length,
				},
			)
			items[next]?.focus({ preventScroll: true })
			return Message.CompletedFocusElement()
		}),
})

/** `setTheme`: persist, then the `light`/`dark` class and `color-scheme` on `<html>`. */
export const SaveTheme = Command.define("SaveTheme", {
	args: { theme: Theme },
	messages: [Message.CompletedSaveTheme],
	execute: ({ theme }) =>
		Effect.sync(() => {
			writeLocalStorage(THEME_STORAGE_KEY, theme)
			const root = document.documentElement
			root.classList.remove("light", "dark")
			root.classList.add(theme)
			root.style.colorScheme = theme
			return Message.CompletedSaveTheme()
		}),
})

/** `setGlobalNamespace`: "All namespaces" removes the key. */
export const SaveNamespace = Command.define("SaveNamespace", {
	args: { orgId: Schema.String, maybeNamespace: Schema.Option(Schema.String) },
	messages: [Message.CompletedSaveNamespace],
	execute: ({ orgId, maybeNamespace }) => {
		const key = `${NAMESPACE_STORAGE_PREFIX}${orgId}`
		return Option.match(maybeNamespace, {
			onNone: () =>
				Effect.ignore(
					Effect.try({
						try: () => localStorage.removeItem(key),
						catch: (cause) =>
							new ShellStorageError({ message: "Could not clear the namespace", cause }),
					}),
				),
			onSome: (namespace) => Effect.sync(() => writeLocalStorage(key, namespace)),
		}).pipe(Effect.as(Message.CompletedSaveNamespace()))
	},
})

/** Remembers the org's settled surfaces, so the next boot lays the sidebar out from them. */
export const SaveInfraSurfaces = Command.define("SaveInfraSurfaces", {
	args: { orgId: Schema.String, surfaces: Schema.Array(Schema.String) },
	messages: [Message.CompletedSaveInfraSurfaces],
	execute: ({ orgId, surfaces }) =>
		Effect.sync(() => {
			writeLocalStorage(`${INFRA_SURFACES_STORAGE_PREFIX}${orgId}`, encodeSurfaces(surfaces))
			return Message.CompletedSaveInfraSurfaces()
		}),
})

/** `SidebarProvider.setOpen`: the `sidebar_state` cookie (7 days). Never read back. */
export const SaveSidebarState = Command.define("SaveSidebarState", {
	args: { isOpen: Schema.Boolean },
	messages: [Message.CompletedSaveSidebarState],
	execute: ({ isOpen }) =>
		Effect.sync(() => {
			document.cookie = `sidebar_state=${String(isOpen)}; path=/; max-age=${60 * 60 * 24 * 7}`
			return Message.CompletedSaveSidebarState()
		}),
})
// SESSION

/** `GuestMenu`'s log out: drop the self-hosted token and reload into `/sign-in`. */
export const LogOut = Command.define("LogOut", {
	messages: [Message.CompletedLogOut],
	execute: clearSessionToken.pipe(Effect.andThen(load("/sign-in")), Effect.as(Message.CompletedLogOut())),
})

/**
 * `focusSearch`: a page tags its primary search with `data-shortcut-focus="search"`. A field is
 * focused and selected; anything else (the traces Advanced Filter trigger) is clicked.
 */
export const FocusShortcutSearch = Command.define("FocusShortcutSearch", {
	messages: [Message.CompletedFocusShortcutSearch],
	execute: Effect.sync(() => {
		const target = document.querySelector('[data-shortcut-focus="search"]')
		if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
			target.focus()
			target.select()
		} else if (target instanceof HTMLElement) target.click()
		return Message.CompletedFocusShortcutSearch()
	}),
})
