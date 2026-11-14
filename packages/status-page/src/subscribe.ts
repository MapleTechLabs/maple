import { escapeHtml } from "@maple/strings"
import { Array as Arr } from "effect"
import type { RenderOptions } from "./document"

/** The dialog's id: `#subscribe` opens it, with or without script. */
const DIALOG_ID = "subscribe"

/** A 16px line icon in the text colour. */
const icon = (paths: string): string =>
	`<svg class="i" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">${paths}</svg>`

const ICON = {
	rss: icon(
		`<path d="M3 7.5A5.5 5.5 0 0 1 8.5 13M3 3a10 10 0 0 1 10 10"/><circle cx="3.75" cy="12.25" r=".75"/>`,
	),
	slack: icon(`<path d="M6 2.5v11M10 2.5v11M2.5 6h11M2.5 10h11"/>`),
	close: icon(`<path d="M12 4 4 12M4 4l8 8"/>`),
	copy: icon(
		`<rect x="3.5" y="2.75" width="9" height="11.5" rx="1.5"/><path d="M6 2.75v-1h4v1M6 7h4M6 10h4"/>`,
	),
	copied: icon(`<path d="m3.5 8.5 3 3 6-7"/>`),
}

/** A read-only value with a Copy button the page's script reveals; without script it is selected by hand. */
const copyField = (label: string, value: string): string =>
	`<div class="copy"><input type="text" readonly value="${escapeHtml(value)}" aria-label="${escapeHtml(label)}"><button type="button" class="copy-btn" data-copy title="Copy" aria-label="Copy" hidden>${ICON.copy}${ICON.copied}</button></div>`

/** The header's "Subscribe to updates" link, which opens the dialog. */
export const SUBSCRIBE_LINK = `<a class="sub-open" href="#${DIALOG_ID}">Subscribe to updates</a>`

/**
 * The "Subscribe to updates" dialog: RSS and Slack tabs. Without script it opens as the
 * `#subscribe` target and its tabs are radio inputs; the page's script adds the dialog behaviour.
 */
export const renderSubscribeDialog = (options: RenderOptions): string => {
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
		tab("rss", "RSS", ICON.rss, true),
		...(command === undefined ? [] : [tab("slack", "Slack", ICON.slack)]),
	]
	const panes = Arr.join(
		[
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
	)}</div>${panes}</div></div></div>`
}
