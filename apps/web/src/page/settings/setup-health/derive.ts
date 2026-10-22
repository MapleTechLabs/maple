import { decodePublicId, PublicIdPrefixes, type V2SetupAuditCheck } from "@maple/domain/http/v2"
import { docsUrl } from "../../../lib/docs"
import { AppRoute, hrefOf } from "../../../route"

// Setup health checks; in-app links are built as hrefs.

type Check = Pick<V2SetupAuditCheck, "id" | "affected">

export type SetupHealthAction =
	| { readonly kind: "link"; readonly label: string; readonly href: string }
	| { readonly kind: "docs"; readonly label: string; readonly href: string }

const conventions = (anchor: string) => docsUrl("otelConventions", anchor)

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
	["TRC-02", { label: "Read root span guide", href: docsUrl("missingRootSpans") }],
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

const link = (label: string, href: string): SetupHealthAction => ({ kind: "link", label, href })
const settingsTab = (tab: "ingestion" | "data-platform") => hrefOf(AppRoute.Settings({ search: { tab } }))
const alertsTab = (tab: "rules" | "routing") => hrefOf(AppRoute.Alerts({ search: { tab } }))
const integrations = (integration?: string) =>
	hrefOf(AppRoute.Integrations({ search: integration === undefined ? {} : { integration } }))

const firstAffectedRuleId = (check: Check): string | null => {
	const ruleIds = check.affected.flatMap((entity) =>
		entity.kind === "alert_rule" && entity.id !== null
			? [decodePublicId(PublicIdPrefixes.alertRule, entity.id)]
			: [],
	)
	return ruleIds.find((ruleId) => ruleId !== null) ?? null
}

const ruleAction = (check: Check, label: string): SetupHealthAction => {
	const ruleId = firstAffectedRuleId(check)
	return ruleId === null
		? link("Open alert rules", alertsTab("rules"))
		: link(label, hrefOf(AppRoute.AlertsCreate({ search: { ruleId } })))
}

/** The single, specific action for a check; null for a check id this build does not know. */
export const setupHealthAction = (check: Check): SetupHealthAction | null => {
	const guide = GUIDES.get(check.id)
	if (guide !== undefined) return { kind: "docs", ...guide }
	switch (check.id) {
		case "CFG-ALERT-01":
		case "CFG-ALERT-04":
		case "CFG-NOTIF-01":
			return link("Open destinations", alertsTab("routing"))
		case "CFG-ALERT-02":
			return link("Create alert rule", hrefOf(AppRoute.AlertsCreate({ search: {} })))
		case "CFG-ALERT-03":
			return ruleAction(check, "Add a destination")
		case "CFG-ALERT-05":
			return ruleAction(check, "Open rule")
		case "CFG-ANOM-01":
			return link("Open anomalies", hrefOf(AppRoute.Anomalies({ search: {} })))
		case "CFG-DASH-01":
			return link("Browse templates", hrefOf(AppRoute.DashboardsTemplates({ search: {} })))
		case "CFG-SAMP-01":
			return { kind: "docs", label: "Read sampling guide", href: docsUrl("samplingThroughput") }
		case "CFG-ATTR-01":
		case "CFG-MAP-01":
		case "CFG-MAP-02":
			return link("Open ingestion", settingsTab("ingestion"))
		case "CFG-BYOC-01":
		case "CFG-BYOC-02":
			return link("Open data platform", settingsTab("data-platform"))
		case "CFG-INTEG-01":
			return link(
				"Reconnect",
				integrations(check.affected.find((entity) => entity.kind === "integration")?.name),
			)
		default: {
			const integration = INTEGRATION_FOR_CHECK.get(check.id)
			return integration === undefined ? null : link("Open integration", integrations(integration))
		}
	}
}

const SEVERITY_RANK = { critical: 0, warn: 1, info: 2 } as const

/** Failing checks, most severe first; the report's own order breaks ties. */
export const orderFindings = <C extends Pick<V2SetupAuditCheck, "status" | "severity">>(
	checks: ReadonlyArray<C>,
): ReadonlyArray<C> =>
	checks
		.filter((check) => check.status === "fail")
		.toSorted((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])

export type HealthSegment = "critical" | "warn" | "info" | "pass" | "skip"
const SEGMENT_ORDER: ReadonlyArray<HealthSegment> = ["critical", "warn", "info", "pass", "skip"]

/** The summary bar's segments in display order, empty ones dropped. */
export const healthSegments = (summary: { readonly [Segment in HealthSegment]: number }): ReadonlyArray<{
	readonly segment: HealthSegment
	readonly count: number
}> => SEGMENT_ORDER.map((segment) => ({ segment, count: summary[segment] })).filter(({ count }) => count > 0)

/** Checks that did not fail, with a header that counts passed and skipped apart like the summary. */
export const resolvedChecks = <C extends Pick<V2SetupAuditCheck, "status">>(
	checks: ReadonlyArray<C>,
): { readonly checks: ReadonlyArray<C>; readonly label: string } => {
	const resolved = checks.filter((check) => check.status !== "fail")
	const skipped = resolved.filter((check) => check.status === "skip").length
	const passed = resolved.length - skipped
	if (skipped === 0) return { checks: resolved, label: `Passing (${passed})` }
	if (passed === 0) return { checks: resolved, label: `Skipped (${skipped})` }
	return { checks: resolved, label: `Passing (${passed}) and skipped (${skipped})` }
}
