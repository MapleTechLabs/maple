import type { StatusPageSnapshot } from "@maple/domain/status-page"
import { escapeHtml } from "@maple/strings"
import { Array as Arr } from "effect"
import { pageHref, type RenderOptions, renderBrand, renderDocument } from "./document"
import { safeUrl } from "./escape"
import { statusIcon } from "./icons"
import { groupComponents } from "./select"
import { subscriptionStyles } from "./styles"

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

/** The dialog's id: `#subscribe` opens it, with or without script. */
const DIALOG_ID = "subscribe"

/** A 16px line icon in the text colour. */
const icon = (paths: string): string =>
	`<svg class="i" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">${paths}</svg>`

const ICON = {
	mail: icon(
		`<rect x="1.75" y="3" width="12.5" height="10" rx="2"/><path d="m2.5 4.5 5.5 4.25 5.5-4.25"/>`,
	),
	rss: icon(
		`<path d="M3 7.5A5.5 5.5 0 0 1 8.5 13M3 3a10 10 0 0 1 10 10"/><circle cx="3.75" cy="12.25" r=".75"/>`,
	),
	slack: icon(`<path d="M6 2.5v11M10 2.5v11M2.5 6h11M2.5 10h11"/>`),
	close: icon(`<path d="M12 4 4 12M4 4l8 8"/>`),
	note: icon(
		`<path d="M2.5 6.25v3.5h2.25L10 13V3L4.75 6.25zM12.25 6a2.75 2.75 0 0 1 0 4M4.75 9.75 5.75 14"/>`,
	),
	copy: icon(
		`<rect x="3.5" y="2.75" width="9" height="11.5" rx="1.5"/><path d="M6 2.75v-1h4v1M6 7h4M6 10h4"/>`,
	),
	copied: icon(`<path d="m3.5 8.5 3 3 6-7"/>`),
	bellOff: icon(
		`<path d="M6.25 13.25a1.75 1.75 0 0 0 3.5 0M3.5 11.5h7.5M12.25 9V6.75A4.25 4.25 0 0 0 5.4 3.4M3.75 6.5v5M2 2l12 12"/>`,
	),
	alert: `<svg class="i alert" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d="M8 1.5 15 14H1z"/><path class="glyph" d="M8 6v3.5M8 11.5v.25"/></svg>`,
}

/** A read-only value with a Copy button the page's script reveals; without script it is selected by hand. */
const copyField = (label: string, value: string): string =>
	`<div class="copy"><input type="text" readonly value="${escapeHtml(value)}" aria-label="${escapeHtml(label)}"><button type="button" class="copy-btn" data-copy title="Copy" aria-label="Copy" hidden>${ICON.copy}${ICON.copied}</button></div>`

/** The components to pick from, by group in page order. */
const componentPicks = (snapshot: StatusPageSnapshot): string =>
	Arr.join(
		Arr.map(groupComponents(snapshot.components), (group) => {
			const boxes = Arr.join(
				Arr.map(
					group.components,
					(component) =>
						`<label class="check"><input type="checkbox" name="${SUBSCRIBE_FIELDS.componentIds}" value="${escapeHtml(component.id)}"><span>${escapeHtml(component.name)}</span></label>`,
				),
				"",
			)
			return group.name === null
				? boxes
				: `<div class="pick-group" role="group" aria-label="${escapeHtml(group.name)}"><span class="pick-group-name" aria-hidden="true">${escapeHtml(group.name)}</span><div class="pick-group-items">${boxes}</div></div>`
		}),
		"",
	)

/** "By subscribing, you agree to our Terms of service and Privacy policy." with whichever the page links. */
const agreement = (snapshot: StatusPageSnapshot): string => {
	const links = Arr.filter(
		[
			[safeUrl(snapshot.page.termsUrl, ["https:"]), "Terms of service"] as const,
			[safeUrl(snapshot.page.privacyUrl, ["https:"]), "Privacy policy"] as const,
		],
		([url]) => url !== null,
	)
	return links.length === 0
		? "We email you a link to confirm your address first."
		: `By subscribing, you agree to our ${Arr.join(
				Arr.map(
					links,
					([url, label]) => `<a href="${escapeHtml(url ?? "")}" rel="noopener">${label}</a>`,
				),
				" and ",
			)}.`
}

const emailPane = (snapshot: StatusPageSnapshot, options: RenderOptions): string => {
	const f = SUBSCRIBE_FIELDS
	const count = snapshot.components.length
	const scope =
		count === 0
			? ""
			: `<fieldset class="scope"><legend>Which updates do you want?</legend><label class="choice"><input type="radio" name="${f.scope}" value="${SUBSCRIBE_SCOPE_ALL}" checked><span>All components</span></label><div class="choice choice-some"><label><input type="radio" name="${f.scope}" value="${SUBSCRIBE_SCOPE_SOME}"><span>Specific components</span></label><div class="picks"><div class="picks-head" hidden><span data-sub-count>0 of ${count} selected</span><span><button type="button" data-sub-pick="all">Select all</button><button type="button" data-sub-pick="none">Clear</button></span></div>${componentPicks(snapshot)}<p class="field-error" data-sub-error="components" hidden>Select at least one component, or choose All components.</p></div></div></fieldset>`
	const reach =
		count === 0
			? `<span>You'll receive emails for new incidents, as well as updates to existing incidents.</span>`
			: `<span class="for-all">You'll receive emails for new incidents, as well as updates to existing incidents.</span><span class="for-some">You'll receive emails for incidents affecting your selected components.</span>`
	return `<form class="sub-form" method="post" action="${pageHref(options, SUBSCRIBE_PATHS.subscribe)}"><div class="sub-body"><div class="field"><label for="sub-address">Enter your email address</label><input id="sub-address" type="email" name="${f.email}" autocomplete="email" maxlength="254" placeholder="e.g. hello@example.com" required><p class="field-error" data-sub-error="email" hidden></p></div>${scope}<div class="sub-note">${ICON.note}<p>${reach}<span class="fine">${agreement(snapshot)}</span></p></div><p class="sub-alert" role="alert" hidden></p></div><div class="sub-foot"><button type="submit" class="btn">Subscribe</button></div></form>`
}

/** The header's "Subscribe to updates" link, which opens the dialog. */
export const SUBSCRIBE_LINK = `<a class="sub-open" href="#${DIALOG_ID}">Subscribe to updates</a>`

/**
 * The "Subscribe to updates" dialog: Email, RSS and Slack tabs. Without script it opens as the
 * `#subscribe` target, its tabs are radio inputs, and the email form posts to the Worker; the
 * page's script adds the dialog behaviour, validation, and posts the form in place.
 */
export const renderSubscribeDialog = (snapshot: StatusPageSnapshot, options: RenderOptions): string => {
	const feed = (path: string) =>
		options.publicUrl === undefined ? `${options.basePath ?? ""}${path}` : `${options.publicUrl}${path}`
	// Slack fetches the feed itself, so the command needs an absolute URL; without one there is no Slack tab.
	const command =
		options.publicUrl === undefined ? undefined : `/feed subscribe ${options.publicUrl}/feed.rss`
	const tab = (id: string, label: string, glyph: string, checked = false) => ({
		input: `<input type="radio" name="sub-via" id="sub-${id}" class="sr"${checked ? " checked" : ""}>`,
		label: `<label for="sub-${id}">${glyph}${label}</label>`,
	})
	const tabs = [
		tab("email", "Email", ICON.mail, true),
		tab("rss", "RSS", ICON.rss),
		...(command === undefined ? [] : [tab("slack", "Slack", ICON.slack)]),
	]
	const panes = Arr.join(
		[
			`<div class="pane pane-email">${emailPane(snapshot, options)}</div>`,
			`<div class="pane pane-rss"><div class="sub-body"><div class="field"><span>Get the RSS feed</span>${copyField("RSS feed URL", feed("/feed.rss"))}</div><div class="field"><span>Get the Atom feed</span>${copyField("Atom feed URL", feed("/feed.atom"))}</div></div></div>`,
			command === undefined
				? ""
				: `<div class="pane pane-slack"><div class="sub-body"><p>To receive live status updates in Slack, copy and paste the text below into the Slack channel of your choice.</p>${copyField("Slack command", command)}<p class="fine">Uses Slack's RSS app, which must be installed in your workspace.</p></div></div>`,
		],
		"",
	)
	const close = `<a class="modal-close" href="#" title="Close" aria-label="Close" data-sub-close>${ICON.close}</a>`
	return `<div class="modal" id="${DIALOG_ID}" role="dialog" aria-modal="true" aria-labelledby="sub-title"><a class="modal-shade" href="#" tabindex="-1" aria-hidden="true" data-sub-close></a><div class="modal-box" tabindex="-1"><div class="modal-head"><h2 id="sub-title">Subscribe to updates</h2>${close}</div><div class="sub-tabs">${Arr.join(
		Arr.map(tabs, (t) => t.input),
		"",
	)}<div class="tablist">${Arr.join(
		Arr.map(tabs, (t) => t.label),
		"",
	)}</div>${panes}</div><div class="sub-done sub-body" role="status" hidden><p>We've sent an email to <strong data-sub-address></strong> with a confirmation link.</p><p>Your subscription becomes active once you confirm your address with the link in that email.</p><p>If you're already subscribed, you won't get another email.</p></div></div></div>`
}

export interface SubscriptionView {
	readonly title: string
	readonly text: string
	/** A quieter second paragraph. */
	readonly detail?: string
	readonly icon: "check" | "alert" | "bell-off"
	/**
	 * A button that POSTs the link's token. Links in emails only show it: mail scanners fetch
	 * every link, and a GET must not confirm or unsubscribe anyone.
	 */
	readonly action?: { readonly path: string; readonly token: string; readonly label: string }
}

const VIEW_ICON = {
	check: statusIcon("operational"),
	alert: ICON.alert,
	"bell-off": ICON.bellOff,
} as const satisfies Record<SubscriptionView["icon"], string>

/** The page a visitor lands on from the subscribe form or an emailed link: one centred card. */
export const renderSubscriptionPage = (
	snapshot: StatusPageSnapshot,
	view: SubscriptionView,
	options: RenderOptions = {},
): string => {
	const home = pageHref(options, "/")
	const action =
		view.action === undefined
			? `<a class="btn quiet" href="${home}">View status page</a>`
			: `<form method="post" action="${pageHref(options, view.action.path)}"><input type="hidden" name="${SUBSCRIBE_FIELDS.token}" value="${escapeHtml(view.action.token)}"><button type="submit" class="btn">${escapeHtml(view.action.label)}</button></form><a class="home" href="${home}">View status page</a>`
	const detail = view.detail === undefined ? "" : `<p class="fine">${escapeHtml(view.detail)}</p>`
	const body = Arr.join(
		[
			`<header class="solo">${renderBrand(snapshot, options)}</header>`,
			`<section class="result" role="status">${VIEW_ICON[view.icon]}<h1>${escapeHtml(view.title)}</h1><p>${escapeHtml(view.text)}</p>${detail}${action}</section>`,
		],
		"",
	)
	return renderDocument({
		snapshot,
		options,
		title: `${view.title}: ${snapshot.page.name}`,
		styles: subscriptionStyles,
		body,
		head: `<meta name="robots" content="noindex">`,
	})
}
