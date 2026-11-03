import type { StatusPageComponentStatus } from "@maple/domain/primitives"
import { overallStatus, type StatusPageFreshness, type StatusPageSnapshot } from "@maple/domain/status-page"
import { escapeXml } from "./escape"

const BADGE = {
	operational: { text: "operational", color: "#16a34a" },
	maintenance: { text: "maintenance", color: "#2563eb" },
	degraded: { text: "degraded", color: "#d97706" },
	partial_outage: { text: "partial outage", color: "#ea580c" },
	major_outage: { text: "major outage", color: "#dc2626" },
} as const satisfies Record<StatusPageComponentStatus, { text: string; color: string }>

/** Grey, because a stale badge should not vouch for a state nobody confirmed. */
const DELAYED = { text: "delayed", color: "#737373" } as const

/** Rough 11px Verdana advance; shields.io sizes its badges the same way. */
const textWidth = (text: string): number => Math.round(text.length * 6.6 + 12)

/** A shields-style `status | operational` badge. */
export const renderBadgeSvg = (snapshot: StatusPageSnapshot, freshness: StatusPageFreshness): string => {
	const label = "status"
	const value = freshness._tag === "delayed" ? DELAYED : BADGE[overallStatus(snapshot)]
	const left = textWidth(label)
	const right = textWidth(value.text)
	const width = left + right
	const title = `${snapshot.page.name}: ${value.text}`
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${escapeXml(title)}"><title>${escapeXml(title)}</title><clipPath id="r"><rect width="${width}" height="20" rx="3"/></clipPath><g clip-path="url(#r)"><rect width="${left}" height="20" fill="#555"/><rect x="${left}" width="${right}" height="20" fill="${value.color}"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="${left / 2}" y="14">${label}</text><text x="${left + right / 2}" y="14">${value.text}</text></g></svg>`
}
