import type { StatusPageSnapshot } from "@maple/domain/status-page"
import { escapeXml } from "./escape"
import { INCIDENT_STATUS_LABEL } from "./format"
import { latestActivityAt } from "./select"

const iso = (ms: number): string => new Date(ms).toISOString()

/** Atom feed with one entry per incident update, newest first. `pageUrl` is the page's absolute URL. */
export const renderAtomFeed = (snapshot: StatusPageSnapshot, pageUrl: string): string => {
	const base = pageUrl.replace(/\/+$/u, "")
	const entries = snapshot.incidents
		.flatMap((incident) => incident.updates.map((update) => ({ incident, update })))
		.sort((a, b) => b.update.at - a.update.at)
		.map(
			({ incident, update }) =>
				`<entry><id>urn:maple:status:${escapeXml(snapshot.pageId)}:${escapeXml(incident.id)}:${escapeXml(update.id)}</id><title>${escapeXml(`${incident.title}: ${INCIDENT_STATUS_LABEL[update.status]}`)}</title><updated>${iso(update.at)}</updated><published>${iso(update.at)}</published><link rel="alternate" href="${escapeXml(`${base}/#incident-${incident.id}`)}"/><content type="text">${escapeXml(update.body)}</content></entry>`,
		)
		.join("")
	return `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><id>urn:maple:status:${escapeXml(snapshot.pageId)}</id><title>${escapeXml(`${snapshot.page.name} status`)}</title><updated>${iso(latestActivityAt(snapshot))}</updated><link rel="alternate" href="${escapeXml(`${base}/`)}"/><link rel="self" href="${escapeXml(`${base}/feed.atom`)}"/><author><name>${escapeXml(snapshot.page.name)}</name></author>${entries}</feed>`
}
