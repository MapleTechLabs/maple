import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "@maple/views/ui/icon"
import { hstack } from "@maple/views/ui/stack"
import { textLink } from "@maple/views/ui/text-link"

// The compliance footnote under the plan pickers (DPA available, SOC 2 and ISO 27001 in progress).
// Mirrors the landing's `lib/compliance.ts`, which web cannot import. Only the DPA may read as held.
export const COMPLIANCE_LINE = "DPA available · SOC 2 Type II and ISO 27001 in progress"
export const DPA_REQUEST_URL = "mailto:privacy@maple.dev?subject=DPA%20request"

/** `ComplianceLine`: one quiet footnote under a plan picker (onboarding and billing compare). */
export const compliance = <M>(h: HtmlBuilder<M>): Html =>
	hstack(h, { gap: "1.5", justify: "center", wrap: true, className: "text-xs text-muted-foreground" }, [
		icon(h, "ShieldCheckIcon", { className: "size-3.5" }),
		h.span([], [COMPLIANCE_LINE]),
		h.span([h.AriaHidden(true)], ["·"]),
		textLink(h, { href: DPA_REQUEST_URL }, ["Request the DPA"]),
	])
