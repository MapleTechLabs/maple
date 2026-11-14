import type { StatusPagePublicSnapshot } from "@maple/domain/status-page"
import { escapeHtml } from "@maple/strings"
import { escapeXml } from "./escape"
import { INCIDENT_STATUS_LABEL } from "./format"
import { latestActivityAt } from "./select"
import { Array as Arr, String as Str } from "effect"

const iso = (ms: number): string => new Date(ms).toISOString()

/** Callers pass an origin plus base path; one trailing slash at most, trimmed without a regex. */
const trimBase = (pageUrl: string): string =>
	Str.endsWith("/")(pageUrl) ? Str.slice(0, -1)(pageUrl) : pageUrl

interface FeedItem {
	readonly id: string
	readonly title: string
	readonly at: number
	readonly link: string
	readonly body: string
}

/** One item per incident update, newest first, with raw (unescaped) text. */
const feedItems = (snapshot: StatusPagePublicSnapshot, base: string): ReadonlyArray<FeedItem> =>
	Arr.map(
		Arr.flatMap(snapshot.incidents, (incident) =>
			Arr.map(incident.updates, (update) => ({ incident, update })),
		).sort((a, b) => b.update.at - a.update.at),
		({ incident, update }) => ({
			id: `urn:maple:status:${snapshot.pageId}:${incident.id}:${update.id}`,
			title: `${incident.title}: ${INCIDENT_STATUS_LABEL[update.status]}`,
			at: update.at,
			link: `${base}/#incident-${incident.id}`,
			body: update.body,
		}),
	)

/** Atom feed with one entry per incident update, newest first. `pageUrl` is the page's absolute URL. */
export const renderAtomFeed = (snapshot: StatusPagePublicSnapshot, pageUrl: string): string => {
	const base = trimBase(pageUrl)
	const entries = Arr.join(
		Arr.map(
			feedItems(snapshot, base),
			(item) =>
				`<entry><id>${escapeXml(item.id)}</id><title>${escapeXml(item.title)}</title><updated>${iso(item.at)}</updated><published>${iso(item.at)}</published><link rel="alternate" href="${escapeXml(item.link)}"/><content type="text">${escapeXml(item.body)}</content></entry>`,
		),
		"",
	)
	return `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><id>urn:maple:status:${escapeXml(snapshot.pageId)}</id><title>${escapeXml(`${snapshot.page.name} status`)}</title><updated>${iso(latestActivityAt(snapshot))}</updated><link rel="alternate" href="${escapeXml(`${base}/`)}"/><link rel="self" href="${escapeXml(`${base}/feed.atom`)}"/><author><name>${escapeXml(snapshot.page.name)}</name></author>${entries}</feed>`
}

/** RFC 822 date, as RSS 2.0 requires. */
const rfc822 = (ms: number): string => new Date(ms).toUTCString()

/** RSS 2.0 feed with the same items as the Atom feed. `pageUrl` is the page's absolute URL. */
export const renderRssFeed = (snapshot: StatusPagePublicSnapshot, pageUrl: string): string => {
	const base = trimBase(pageUrl)
	const items = Arr.join(
		Arr.map(
			feedItems(snapshot, base),
			(item) =>
				`<item><title>${escapeXml(item.title)}</title><link>${escapeXml(item.link)}</link><description>${escapeXml(escapeHtml(item.body))}</description><pubDate>${rfc822(item.at)}</pubDate><guid isPermaLink="false">${escapeXml(item.id)}</guid></item>`,
		),
		"",
	)
	const title = escapeXml(`${snapshot.page.name} status`)
	return `<?xml version="1.0" encoding="utf-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>${title}</title><link>${escapeXml(`${base}/`)}</link><description>${title}</description><lastBuildDate>${rfc822(latestActivityAt(snapshot))}</lastBuildDate><atom:link href="${escapeXml(`${base}/feed.rss`)}" rel="self" type="application/rss+xml"/>${items}</channel></rss>`
}
