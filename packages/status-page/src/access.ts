import type { StatusPageSnapshot } from "@maple/domain/status-page"
import { escapeHtml } from "@maple/strings"
import { Array as Arr } from "effect"
import { pageHref, type RenderOptions, renderDocument, renderHeader } from "./document"
import { manageStyles } from "./styles"

/** Where the password form posts, under the page's base path. */
export const ACCESS_PATH = "/_access"

/** The password field's name, shared with the Worker that reads the POST. */
export const ACCESS_FIELD = "password"

/**
 * The password form of a password-protected page: its name, logo and theme, and nothing it shows
 * once unlocked. `message` says why the last attempt failed.
 */
export const renderAccessPage = (
	snapshot: StatusPageSnapshot,
	message: string | undefined,
	options: RenderOptions = {},
): string => {
	const notice =
		message === undefined ? "" : `<div class="notice" role="alert">${escapeHtml(message)}</div>`
	const body = Arr.join(
		[
			renderHeader(snapshot, options),
			`<section><h2>This status page is password-protected</h2><p class="meta">Enter the password ${escapeHtml(snapshot.page.name)} gave you to see it.</p>`,
			notice,
			`<form method="post" action="${pageHref(options, ACCESS_PATH)}" class="card">`,
			`<label>Password<input type="password" name="${ACCESS_FIELD}" autocomplete="current-password" required autofocus></label>`,
			`<button type="submit">View status</button></form></section>`,
		],
		"",
	)
	return renderDocument({
		snapshot,
		options,
		title: `${snapshot.page.name} status`,
		styles: manageStyles,
		body,
		head: `<meta name="robots" content="noindex">`,
	})
}
