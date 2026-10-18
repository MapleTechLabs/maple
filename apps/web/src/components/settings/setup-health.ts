import { decodePublicId, PublicIdPrefixes, type V2SetupAuditCheck } from "@maple/domain/http/v2"

import { docsUrl } from "@/lib/docs"

type Check = Pick<V2SetupAuditCheck, "id" | "affected">

/** An in-app destination, one shape per route so TanStack Router can type its search. */
export type SetupHealthLink =
	| { readonly to: "/alerts"; readonly search: { readonly tab: "rules" | "routing" } }
	| { readonly to: "/alerts/create"; readonly search: { readonly ruleId?: string } }
	| { readonly to: "/anomalies" }
	| { readonly to: "/dashboards/templates" }
	| { readonly to: "/integrations"; readonly search: { readonly integration?: string } }
	| {
			readonly to: "/settings"
			readonly search: { readonly tab: "ingestion" | "data-platform" }
			readonly hash?: string
	  }

/** The one thing to do about a finding: open the place that fixes it, or read the guide. */
export type SetupHealthAction =
	| { readonly kind: "link"; readonly label: string; readonly link: SetupHealthLink }
	| { readonly kind: "docs"; readonly label: string; readonly href: string }

const conventions = (anchor: string) => docsUrl("otelConventions", anchor)

/** Telemetry checks are fixed in the customer's code; each gets the guide section that explains it. */
const GUIDES = new Map<string, { readonly label: string; readonly href: string }>([
	["RES-01", { label: "Read service identity guide", href: conventions("service-identity") }],
	["ING-01", { label: "Read service identity guide", href: conventions("service-identity") }],
	["LOG-01", { label: "Read logs guide", href: conventions("logs") }],
	["LOG-02", { label: "Read trace correlation guide", href: conventions("trace-correlation") }],
	["LOG-03", { label: "Read logs guide", href: conventions("logs") }],
	["LOG-04", { label: "Read severity levels guide", href: conventions("severity-levels") }],
	["RES-06", { label: "Read service identity guide", href: conventions("service-identity") }],
	["RES-02", { label: "Read version guide", href: conventions("deployment-and-version-tracking") }],
	["RES-03", { label: "Read environment guide", href: conventions("deployment-and-version-tracking") }],
	["RES-04", { label: "Read source linking guide", href: conventions("deployment-and-version-tracking") }],
	["RES-05", { label: "Read version guide", href: conventions("deployment-and-version-tracking") }],
	["NAME-02", { label: "Read span naming guide", href: conventions("http-attributes") }],
	["NAME-03", { label: "Read reserved namespace guide", href: conventions("reserved-namespace") }],
	["PII-01", { label: "Read attribute conventions", href: docsUrl("otelConventions") }],
	["MET-01", { label: "Read metrics guide", href: conventions("metrics") }],
	["STAT-01", { label: "Read span status guide", href: conventions("span-status-codes") }],
	["STAT-02", { label: "Read errors guide", href: conventions("errors-and-exceptions") }],
	["STAT-04", { label: "Read span kinds guide", href: conventions("span-kinds") }],
	["MAP-02", { label: "Read database guide", href: conventions("2-database-nodes") }],
	["MAP-03", { label: "Read service map guide", href: conventions("4-pick-canonical-names") }],
	["TRC-01", { label: "Read service map guide", href: conventions("1-service-to-service-edges") }],
	["TRC-02", { label: "Read service map guide", href: conventions("service-map") }],
	["TRC-03", { label: "Read sampling guide", href: docsUrl("samplingThroughput") }],
])

const INTEGRATION_FOR_CHECK = new Map<string, string>([
	["CFG-INTEG-02", "cloudflare"],
	["CFG-INTEG-03", "github"],
	["CFG-INTEG-04", "railway"],
	["CFG-INTEG-05", "planetscale"],
	["CFG-INTEG-06", "cloudflare"],
	["CFG-SCRAPE-01", "prometheus"],
])

/** The first affected alert rule's internal id, for the rule editor's `ruleId`. */
function firstAffectedRuleId(check: Check): string | null {
	const ruleIds = check.affected.flatMap((entity) =>
		entity.kind === "alert_rule" && entity.id !== null
			? [decodePublicId(PublicIdPrefixes.alertRule, entity.id)]
			: [],
	)
	return ruleIds.find((ruleId) => ruleId !== null) ?? null
}

function ruleAction(check: Check, label: string): SetupHealthAction {
	const ruleId = firstAffectedRuleId(check)
	return ruleId === null
		? { kind: "link", label: "Open alert rules", link: { to: "/alerts", search: { tab: "rules" } } }
		: { kind: "link", label, link: { to: "/alerts/create", search: { ruleId } } }
}

const link = (label: string, target: SetupHealthLink): SetupHealthAction => ({
	kind: "link",
	label,
	link: target,
})

/** The single, specific action for a check; null for a check id this build does not know. */
export function setupHealthAction(check: Check): SetupHealthAction | null {
	const guide = GUIDES.get(check.id)
	if (guide !== undefined) return { kind: "docs", ...guide }
	switch (check.id) {
		case "CFG-ALERT-01":
		case "CFG-ALERT-04":
			return link("Open destinations", { to: "/alerts", search: { tab: "routing" } })
		case "CFG-ALERT-02":
			return link("Create alert rule", { to: "/alerts/create", search: {} })
		case "CFG-ALERT-03":
			return ruleAction(check, "Add a destination")
		case "CFG-ALERT-05":
			return ruleAction(check, "Open rule")
		// No error notification or anomaly settings UI yet: the Alerts routing redesign will own them.
		case "CFG-NOTIF-01":
			return link("Open destinations", { to: "/alerts", search: { tab: "routing" } })
		case "CFG-ANOM-01":
			return link("Open anomalies", { to: "/anomalies" })
		case "CFG-DASH-01":
			return link("Browse templates", { to: "/dashboards/templates" })
		case "CFG-SAMP-01":
			return { kind: "docs", label: "Read sampling guide", href: docsUrl("samplingThroughput") }
		case "CFG-ATTR-01":
		case "CFG-MAP-01":
		case "CFG-MAP-02":
			return link("Open ingestion", { to: "/settings", search: { tab: "ingestion" } })
		case "CFG-BYOC-01":
		case "CFG-BYOC-02":
			return link("Open data platform", { to: "/settings", search: { tab: "data-platform" } })
		case "CFG-INTEG-01": {
			// Revoked grants name their provider; one link per finding goes to the first.
			const provider = check.affected.find((entity) => entity.kind === "integration")?.name
			return link("Reconnect", {
				to: "/integrations",
				search: provider === undefined ? {} : { integration: provider },
			})
		}
		default: {
			const integration = INTEGRATION_FOR_CHECK.get(check.id)
			return integration === undefined
				? null
				: link("Open integration", { to: "/integrations", search: { integration } })
		}
	}
}

type Severity = V2SetupAuditCheck["severity"]
const SEVERITY_RANK = { critical: 0, warn: 1, info: 2 } satisfies Record<Severity, number>

/** Failing checks, most severe first; the report's own order breaks ties. */
export function orderFindings<C extends Pick<V2SetupAuditCheck, "status" | "severity">>(
	checks: ReadonlyArray<C>,
): ReadonlyArray<C> {
	return checks
		.filter((check) => check.status === "fail")
		.toSorted((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
}

export type HealthSegment = "critical" | "warn" | "info" | "pass" | "skip"

const SEGMENT_ORDER: ReadonlyArray<HealthSegment> = ["critical", "warn", "info", "pass", "skip"]

/** The summary bar's segments in display order, empty ones dropped. */
export function healthSegments(
	summary: Record<HealthSegment, number>,
): ReadonlyArray<{ readonly segment: HealthSegment; readonly count: number }> {
	return SEGMENT_ORDER.map((segment) => ({ segment, count: summary[segment] })).filter(
		({ count }) => count > 0,
	)
}

/** Checks that did not fail, with a header that counts passed and skipped apart like the summary. */
export function resolvedChecks<C extends Pick<V2SetupAuditCheck, "status">>(
	checks: ReadonlyArray<C>,
): { readonly checks: ReadonlyArray<C>; readonly label: string } {
	const resolved = checks.filter((check) => check.status !== "fail")
	const skipped = resolved.filter((check) => check.status === "skip").length
	const passed = resolved.length - skipped
	if (skipped === 0) return { checks: resolved, label: `Passing (${passed})` }
	if (passed === 0) return { checks: resolved, label: `Skipped (${skipped})` }
	return { checks: resolved, label: `Passing (${passed}) and skipped (${skipped})` }
}
