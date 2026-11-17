import type { CloudFindingSeverity } from "@maple/domain/cloud-security"
import type { Html, HtmlBuilder } from "foldkit/html"
import { securitySeverityBadge } from "../kit/parts"

// Small pieces both Cloud screens draw.

const AS_SECURITY_SEVERITY = {
	critical: "critical",
	high: "high",
	medium: "medium",
	low: "low",
	info: "informational",
} as const satisfies Record<CloudFindingSeverity, string>

/** A cloud finding's severity in the Security hub's badge. */
export const cloudSeverityBadge = <M>(h: HtmlBuilder<M>, severity: CloudFindingSeverity): Html =>
	securitySeverityBadge(h, AS_SECURITY_SEVERITY[severity])

export const externalLinkAttributes = <M>(h: HtmlBuilder<M>) => [
	h.Target("_blank"),
	h.Rel("noopener noreferrer"),
]
