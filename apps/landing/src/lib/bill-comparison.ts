/**
 * The list-price comparison: what each vendor charges, line by line. `BillComparison` prints it
 * with a column per vendor (the compare hub); the home page prints a row per vendor and fewer
 * lines. One source, so the two cannot disagree.
 *
 * Messages are called inside the functions, never at module scope (see `pricing-offer.ts`).
 * Competitor cells are literal: they quote each vendor's own price sheet.
 */
import * as m from "../paraglide/messages.js"

export const BILL_ROW_KEYS = [
	"base",
	"free",
	"perHost",
	"perSeat",
	"ingest",
	"retention",
	"otel",
	"license",
	"selfHost",
] as const
export type BillRowKey = (typeof BILL_ROW_KEYS)[number]

export interface BillVendor {
	id: string
	name: string
	/** The vendor's comparison page and its link label; Maple has neither. */
	href?: string
	link?: string
	cells: Record<BillRowKey, string>
}

export const billRowLabels = (): Record<BillRowKey, string> => ({
	base: m.bill_row_base(),
	free: m.bill_row_free(),
	perHost: m.bill_row_per_host(),
	perSeat: m.bill_row_per_seat(),
	ingest: m.bill_row_ingest(),
	retention: m.bill_row_retention(),
	otel: m.bill_row_otel(),
	license: m.bill_row_oss(),
	selfHost: m.bill_row_selfhost(),
})

export const billVendors = (): ReadonlyArray<BillVendor> => [
	{
		id: "maple",
		name: "Maple",
		cells: {
			base: m.bill_v_base_maple(),
			free: m.bill_v_free_maple(),
			perHost: m.bill_v_none(),
			perSeat: m.bill_v_none(),
			ingest: m.bill_v_usage(),
			retention: "30d logs/traces · 90d metrics",
			otel: m.bill_v_native(),
			license: m.bill_v_apache(),
			selfHost: m.bill_v_selfhost_maple(),
		},
	},
	{
		id: "datadog",
		name: "Datadog",
		href: "/compare/datadog",
		link: m.bill_link_vs_dd(),
		cells: {
			base: m.bill_v_none(),
			free: "5 hosts, 1-day metrics",
			perHost: "$15+ / host / mo",
			perSeat: m.bill_v_none(),
			ingest: "$0.10 / GB + $1.70 / M indexed",
			retention: "15d indexed logs",
			otel: m.bill_v_yes(),
			license: m.bill_v_proprietary(),
			selfHost: m.bill_v_no(),
		},
	},
	{
		id: "new-relic",
		name: "New Relic",
		href: "/compare/new-relic",
		link: m.bill_link_vs_nr(),
		cells: {
			base: m.bill_v_none(),
			free: "100 GB / mo, 1 full user",
			perHost: m.bill_v_none(),
			perSeat: "$10 first, then $99–349 / full-platform user / mo",
			ingest: "$0.40 / GB",
			retention: "30d logs · 8d traces",
			otel: m.bill_v_yes(),
			license: m.bill_v_proprietary(),
			selfHost: m.bill_v_no(),
		},
	},
	{
		id: "grafana",
		name: "Grafana Cloud",
		href: "/compare/grafana",
		link: m.bill_link_vs_gf(),
		cells: {
			base: "$19 / mo",
			free: "50 GB logs/traces, 10k series",
			perHost: m.bill_v_none(),
			perSeat: "$8+ / active-user / mo",
			ingest: "$0.55 / GB",
			retention: "30d logs/traces · 13mo metrics",
			otel: m.bill_v_yes(),
			license: "AGPL components",
			selfHost: m.bill_v_oss_only(),
		},
	},
	{
		id: "dash0",
		name: "Dash0",
		href: "/compare/dash0",
		link: m.bill_link_vs_dash0(),
		cells: {
			base: m.bill_v_none(),
			free: "No · 14-day trial",
			perHost: m.bill_v_none(),
			perSeat: m.bill_v_none(),
			ingest: "$0.60 / M spans or logs · $0.20 / M metric points",
			retention: "30d spans/logs · 13mo metrics",
			otel: m.bill_v_native(),
			license: m.bill_v_proprietary(),
			selfHost: m.bill_v_no(),
		},
	},
	{
		id: "signoz",
		name: "SigNoz",
		href: "/compare/signoz",
		link: m.bill_link_vs_signoz(),
		cells: {
			base: "$49 / mo, incl. $49 usage",
			free: m.bill_v_no(),
			perHost: m.bill_v_none(),
			perSeat: m.bill_v_none(),
			ingest: "$0.30 / GB · $0.10 / M samples",
			retention: "15d logs/traces · 1mo metrics",
			otel: m.bill_v_native(),
			license: "MIT + commercial ee/",
			selfHost: m.bill_v_supported(),
		},
	},
	{
		id: "axiom",
		name: "Axiom",
		href: "/compare/axiom",
		link: m.bill_link_vs_axiom(),
		cells: {
			base: "$25 / mo",
			free: "500 GB / mo, 25 GB stored",
			perHost: m.bill_v_none(),
			perSeat: m.bill_v_none(),
			ingest: "$0.12 / GB + $0.20 / GB-hr",
			retention: "Configurable · from $0.03 / GB stored",
			otel: m.bill_v_native(),
			license: m.bill_v_proprietary(),
			selfHost: m.bill_v_no(),
		},
	},
	{
		id: "better-stack",
		name: "Better Stack",
		href: "/compare/better-stack",
		link: m.bill_link_vs_better_stack(),
		cells: {
			base: "None · bundles from $30",
			free: "3 GB logs, 3 GB traces",
			perHost: m.bill_v_none(),
			perSeat: "$29–34 / on-call responder / mo",
			ingest: "$0.10 / GB + $0.05 / GB-mo stored (EU)",
			retention: "30d in bundles · billed per GB-mo stored",
			otel: m.bill_v_native(),
			license: m.bill_v_proprietary(),
			selfHost: m.bill_v_no(),
		},
	},
	{
		id: "honeycomb",
		name: "Honeycomb",
		href: "/compare/honeycomb",
		link: m.bill_link_vs_honeycomb(),
		cells: {
			base: "$150 / mo (Pro)",
			free: "20M events / mo",
			perHost: m.bill_v_none(),
			perSeat: m.bill_v_none(),
			ingest: "$3.00 / M events (spans, logs)",
			retention: "60d events and metrics",
			otel: m.bill_v_native(),
			license: m.bill_v_proprietary(),
			selfHost: "Enterprise, own AWS account",
		},
	},
]
