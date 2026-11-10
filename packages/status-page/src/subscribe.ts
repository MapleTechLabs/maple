import type { StatusPageSnapshot } from "@maple/domain/status-page"
import { escapeHtml } from "@maple/strings"
import { Array as Arr } from "effect"
import { pageHref, type RenderOptions, renderDocument, renderHeader } from "./document"
import { manageStyles } from "./styles"

/** Form field names, shared with the Worker that parses the POSTs. */
export const SUBSCRIBE_FIELDS = {
	email: "email",
	/** `all`, or `some` with the chosen `componentIds`. */
	scope: "scope",
	componentIds: "componentIds",
	token: "token",
} as const

export const SUBSCRIBE_SCOPE_ALL = "all"
export const SUBSCRIBE_SCOPE_SOME = "some"

/** The paths the Worker answers under the page's base. */
export const SUBSCRIBE_PATHS = {
	subscribe: "/subscribe",
	confirm: "/subscribe/confirm",
	unsubscribe: "/unsubscribe",
} as const

const emailPane = (snapshot: StatusPageSnapshot, options: RenderOptions): string => {
	const f = SUBSCRIBE_FIELDS
	const scope =
		snapshot.components.length === 0
			? ""
			: `<fieldset><legend>Notify me about</legend><label class="check"><input type="radio" name="${f.scope}" value="${SUBSCRIBE_SCOPE_ALL}" checked>All components</label><label class="check"><input type="radio" name="${f.scope}" value="${SUBSCRIBE_SCOPE_SOME}">Only the components I pick</label><div class="sub-components">${Arr.join(
					Arr.map(
						snapshot.components,
						(component) =>
							`<label class="check"><input type="checkbox" name="${f.componentIds}" value="${escapeHtml(component.id)}">${escapeHtml(component.name)}</label>`,
					),
					"",
				)}</div></fieldset>`
	return `<form method="post" action="${pageHref(options, SUBSCRIBE_PATHS.subscribe)}"><label>Email address<input type="email" name="${f.email}" autocomplete="email" maxlength="254" required></label>${scope}<button type="submit">Subscribe</button><p class="meta">We email you a link to confirm. Every update carries an unsubscribe link.</p></form>`
}

/** Email, RSS and Slack, as tabs that work without script (radio inputs and CSS). */
export const renderSubscribePanel = (snapshot: StatusPageSnapshot, options: RenderOptions): string => {
	const rss = pageHref(options, "/feed.rss")
	const atom = pageHref(options, "/feed.atom")
	const command = `/feed subscribe ${options.origin ?? ""}${options.basePath ?? ""}/feed.rss`
	const tab = (id: string, label: string, checked = false) =>
		`<input type="radio" name="sub-via" id="sub-${id}" class="sr"${checked ? " checked" : ""}><label for="sub-${id}">${label}</label>`
	return `<section class="panel subscribe" id="subscribe" aria-labelledby="h-subscribe"><div class="panel-head"><h2 id="h-subscribe">Get updates</h2></div><div class="tabs">${tab("email", "Email", true)}${tab("rss", "RSS", false)}${tab("slack", "Slack", false)}<div class="pane pane-email">${emailPane(snapshot, options)}</div><div class="pane pane-rss"><p>Follow incidents and maintenance in any feed reader.</p><p><a href="${rss}">RSS feed</a> · <a href="${atom}">Atom feed</a></p></div><div class="pane pane-slack"><p>Run this in the Slack channel that should get updates:</p><div class="copy"><code>${escapeHtml(command)}</code><button type="button" data-copy="${escapeHtml(command)}" hidden>Copy</button></div><p class="meta">Uses Slack's RSS app, which must be installed in your workspace.</p></div></div></section>`
}

export interface SubscriptionView {
	readonly title: string
	readonly text: string
	readonly tone: "ok" | "error"
	/**
	 * A button that POSTs the link's token. Links in emails only show it: mail scanners fetch
	 * every link, and a GET must not confirm or unsubscribe anyone.
	 */
	readonly action?: { readonly path: string; readonly token: string; readonly label: string }
}

/** The page a visitor lands on from the subscribe form or an emailed link. */
export const renderSubscriptionPage = (
	snapshot: StatusPageSnapshot,
	view: SubscriptionView,
	options: RenderOptions = {},
): string => {
	const action =
		view.action === undefined
			? ""
			: `<form method="post" action="${pageHref(options, view.action.path)}"><input type="hidden" name="${SUBSCRIBE_FIELDS.token}" value="${escapeHtml(view.action.token)}"><button type="submit">${escapeHtml(view.action.label)}</button></form>`
	const body = Arr.join(
		[
			renderHeader(snapshot, options),
			`<section><h2>${escapeHtml(view.title)}</h2><div class="notice${view.tone === "ok" ? " ok" : ""}" role="status">${escapeHtml(view.text)}</div>${action}</section>`,
			`<footer><a href="${pageHref(options, "/")}">Back to the status page</a></footer>`,
		],
		"",
	)
	return renderDocument({
		snapshot,
		options,
		title: `${view.title}: ${snapshot.page.name}`,
		styles: manageStyles,
		body,
		head: `<meta name="robots" content="noindex">`,
	})
}
