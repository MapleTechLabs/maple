/**
 * "<Vendor> alternatives" roundups, rendered by `pages/alternatives/[slug].astro`.
 *
 * English only, literal strings, like `best-observability-tools.ts`. Each
 * roundup is written by hand for its vendor: who leaves it, why, and which
 * tools answer those reasons. Do not stamp out a page per competitor by
 * swapping the name; near-identical pages at scale are what search engines
 * treat as spam. Add a vendor only when it has search demand and its own story.
 *
 * Every vendor fact here repeats a cell from the matching `/compare/<slug>`
 * page, so it is backed by a dated source in `competitors.ts`. Change a price
 * there and here together.
 */
import { competitorBySlug, type Source } from "./competitors"

export interface Alternative {
	/** Anchor id on the page. */
	id: string
	name: string
	url: string
	/** The one-line answer to "should I look at this one?". */
	pickIf: string
	pricing: string
	openSource: string
	promql: "Yes" | "No"
	summary: string
	pros: string[]
	cons: string[]
	/** Slug of the `/compare/<slug>` page with the full breakdown. */
	compareSlug?: string
	/** Set on Maple's own entry, so the page can label it. */
	ours?: true
}

export interface AlternativesPage {
	slug: string
	vendor: string
	vendorUrl: string
	seoTitle: string
	seoDescription: string
	title: string
	lede: string
	/** ISO date the page was last reviewed against the sources. */
	updated: string
	disclosure: string
	/** How the facts were gathered, including what we did not do. */
	method: string
	/** The vendor itself as the table's first, reference row. */
	baseline: Pick<Alternative, "name" | "pricing" | "openSource" | "promql">
	/** What the vendor does well: the reasons not to switch. */
	stayIf: string[]
	alternatives: Alternative[]
	faqs: { question: string; answer: string }[]
	/** The vendor's own source pages first, then one per alternative. */
	sources: Source[]
}

/** Every vendor pricing page cited here was re-read on this month. */
const PRICES_CHECKED = "2026-11"

/** The pricing page is the first source on every competitor entry. */
const pricingSource = (slug: string): Source[] => {
	const source = competitorBySlug(slug)?.sources[0]
	return source ? [{ ...source, checked: PRICES_CHECKED }] : []
}

const dash0: AlternativesPage = {
	slug: "dash0",
	vendor: "Dash0",
	vendorUrl: "https://www.dash0.com",
	seoTitle: "Dash0 Alternatives (2026): 8 OpenTelemetry Tools Compared",
	seoDescription:
		"Eight Dash0 alternatives compared on pricing, open source, self-hosting and PromQL, plus when to stay on Dash0. Written by the Maple team, with sources.",
	title: "Dash0 alternatives",
	lede: "Dash0 is an OpenTelemetry-native, usage-priced SaaS with PromQL and Perses dashboards. Teams look elsewhere when they need to self-host, want the source, or price their data differently. These are the eight tools worth comparing, and what each one is good for.",
	updated: "2026-11-08",
	disclosure:
		"We build Maple and list it first because this is our site: that placement is our bias, not a ranking. The other entries are ordered by how close they are to Dash0: OpenTelemetry-native, usage-priced tools first, per-host and per-user platforms last. Every price comes from the vendor's own pricing page, linked at the bottom with the month we checked it.",
	method: "How we compared: we read each vendor's pricing page and documentation, re-checked every price in November 2026, and reused the sourced rows from our side-by-side comparison pages. We did not benchmark the tools against each other; treat this as a map of trade-offs, not a test result.",
	baseline: {
		name: "Dash0 (for reference)",
		pricing: "$0.60 per million spans or log records, $0.20 per million metric data points",
		openSource: "Closed; SaaS only (its filtering collector can run in your cluster)",
		promql: "Yes",
	},
	stayIf: [
		"Your alerts and dashboards are written in PromQL, or kept as Perses dashboards-as-code. Leaving means rewriting them; of the tools above, only SigNoz, Grafana and Better Stack take PromQL.",
		"You want 13 months of metric retention included in the storage rate. By default Maple keeps metrics 90 days, Honeycomb 60 and SigNoz one month.",
		"You use Dash0's Kubernetes operator and OpenTelemetry distribution, or its synthetic API checks at $0.20 per thousand runs.",
		"Per-data-point pricing suits your data. Dash0 charges per span, log record and metric data point, not per byte, so wide spans and verbose log lines cost the same as small ones.",
	],
	alternatives: [
		{
			id: "maple",
			name: "Maple",
			url: "https://maple.dev",
			ours: true,
			pickIf: "You want Dash0's model, source-available and self-hostable, with uptime, on-call, replay and error tracking in one app.",
			pricing: "$39/mo with 100 GB each of logs, traces and metrics, then $0.30 per GB",
			openSource:
				"Source-available (FSL-1.1, Apache 2.0 after two years); self-hosts for one team, without alerting yet",
			promql: "No",
			summary:
				"Maple starts from the same place as Dash0: OpenTelemetry in, usage-based pricing, no per-seat fee, an MCP server for agents. The source is on GitHub and it self-hosts as one container. Around traces, logs and metrics it puts the rest of the on-call loop in the same app: uptime checks and cron heartbeats, on-call schedules with escalation, SLOs with burn-rate alerts, errors grouped into issues, and browser session replay linked to the trace behind each click.",
			pros: [
				"Source on GitHub; self-hosts as one container, and “maple start” runs it on a laptop",
				"Uptime checks, cron heartbeats and on-call schedules with escalation (email, Slack, Discord)",
				"SLOs with burn-rate alerts, and errors grouped into issues with an owner and a state",
				"Session replay linked to traces, plus a hosted MCP server and alert investigations",
			],
			cons: [
				"No PromQL: a visual query builder and SQL instead",
				"30 days for traces and logs, 90 for metrics, against Dash0's 13 months for metrics",
				"The self-hosted version has no alerting or team accounts yet",
				"No phone or SMS paging or scripted browser checks yet",
				"Younger, with a smaller ecosystem, and no free plan on Maple Cloud",
			],
			compareSlug: "dash0",
		},
		{
			id: "signoz",
			name: "SigNoz",
			url: "https://signoz.io",
			pickIf: "You want an open-source, self-hosted platform and need to keep PromQL.",
			pricing: "$49/mo including $49 of usage, then $0.30 per GB of logs and traces",
			openSource: "MIT core, SSO and RBAC under a commercial license; self-hostable",
			promql: "Yes",
			summary:
				"SigNoz is the closest open-source match for a Dash0 user. It is OpenTelemetry-native, stores everything in ClickHouse, and queries metrics with PromQL as well as its own builder and SQL. Self-hosting is mature, with Docker, Helm and per-platform guides, and the Community edition is multi-user with roles.",
			pros: [
				"PromQL in dashboards, and Prometheus rules carry over",
				"The most polished self-hosting path on this list",
				"Metric samples billed per million ($0.10), which suits many small series",
			],
			cons: [
				"15 days for logs and traces by default, and longer retention raises the rate",
				"SAML, OIDC and fine-grained RBAC sit in the commercially licensed ee/ directory",
				"Metrics kept one month by default, against Dash0's 13 months",
			],
			compareSlug: "signoz",
		},
		{
			id: "grafana",
			name: "Grafana Cloud / LGTM",
			url: "https://grafana.com",
			pickIf: "PromQL and dashboards-as-code are how your team works.",
			pricing: "Free tier, then $19/mo + $8 per user, $0.55 per GB of logs and traces",
			openSource: "AGPL-3.0 (Grafana, Loki, Tempo, Mimir); Cloud is proprietary",
			promql: "Yes",
			summary:
				"Grafana is where most PromQL users end up. Existing dashboards and recording rules carry over unchanged, the plugin catalog connects almost any data source, and the whole stack can be self-hosted with mature Helm charts. The cost is operational: Loki, Tempo and Mimir are separate services, each with its own query language.",
			pros: [
				"PromQL, LogQL and TraceQL; dashboards-as-code",
				"Hundreds of plugins and community dashboards",
				"Self-hostable under AGPL, or fully managed on Grafana Cloud",
			],
			cons: [
				"Self-hosting means running four services",
				"Cloud adds $8 per active user beyond three, and $6.50 per thousand active metric series",
				"A query language per signal: PromQL, LogQL and TraceQL",
			],
			compareSlug: "grafana",
		},
		{
			id: "honeycomb",
			name: "Honeycomb",
			url: "https://www.honeycomb.io",
			pickIf: "You debug by slicing high-cardinality traces and want BubbleUp.",
			pricing: "Free up to 20M events/mo; Pro $3.00 per million events, from $150",
			openSource: "No (Refinery is Apache 2.0); Private Cloud on Enterprise",
			promql: "No",
			summary:
				"Honeycomb is a query engine for wide events. BubbleUp ranks every attribute of a slow or failing slice of requests against the baseline, and it is the main reason teams pick it. Like Dash0 it bills per item, not per byte, and it keeps 60 days of events and metrics on every plan, including the free one.",
			pros: [
				"BubbleUp outlier analysis, heatmaps and SLOs with burn-rate alerts",
				"A real free plan: 20M events and 100M metric data points a month",
				"60 days of retention on every plan",
			],
			cons: [
				"Closed source; single-tenant hosting only on Enterprise",
				"Frontend observability is an Enterprise add-on",
				"No PromQL",
			],
			compareSlug: "honeycomb",
		},
		{
			id: "better-stack",
			name: "Better Stack",
			url: "https://betterstack.com",
			pickIf: "You need phone and SMS paging or Playwright browser checks.",
			pricing: "Bundles from $30/mo; logs and traces $0.10/GB + $0.05/GB-month stored (EU)",
			openSource: "No; SaaS, custom VPC on Enterprise",
			promql: "Yes",
			summary:
				"Better Stack is an incident platform with telemetry attached: uptime checks, on-call schedules and a Slack incident bot, fed by logs, traces, errors and replays. It ingests OTLP and also takes PromQL, and its per-GB rate for logs and traces is lower than most on this list.",
			pros: [
				"Uptime, Playwright checks, and on-call with phone and SMS",
				"Low log and trace rates with storage billed separately",
				"PromQL and SQL",
			],
			cons: [
				"Closed source, with no self-hosting",
				"Metrics billed on stored size, from $0.50 per GB-month",
				"Anyone on call needs a $34/mo Responder license",
			],
			compareSlug: "better-stack",
		},
		{
			id: "axiom",
			name: "Axiom",
			url: "https://axiom.co",
			pickIf: "You ship a lot of event data and want the lowest ingest rate at volume.",
			pricing: "$25/mo, then $0.12/GB loaded, $0.20 per GB-hour of queries, $0.03/GB stored",
			openSource: "No; SaaS only",
			promql: "No",
			summary:
				"Axiom is an event store first: everything lands in a dataset, you query it in APL, and monitors run those queries on a schedule. Its ingest rate falls with volume without negotiation, and cheap storage makes long retention affordable. You get less product on top of the data.",
			pros: [
				"Ingest rates that fall with volume, and cheap long retention",
				"Hard spend caps that pause ingestion instead of billing overage",
				"MCP server and agent skills, with per-token query cost limits",
			],
			cons: [
				"Closed source, with no self-hosting",
				"APL and MPL to learn; no PromQL",
				"Less product on top of the data: alerts are scheduled queries, and errors stay raw events",
			],
			compareSlug: "axiom",
		},
		{
			id: "datadog",
			name: "Datadog",
			url: "https://www.datadoghq.com",
			pickIf: "You need breadth: security, network monitoring, browser tests and 800+ integrations.",
			pricing: "Per host: infrastructure from $15, APM from $31, plus per-product meters",
			openSource: "No (the Agent is open source); SaaS only",
			promql: "No",
			summary:
				"Datadog is the incumbent with a product for each layer: APM, logs, RUM, synthetics, network monitoring, security and CI visibility. It accepts OTLP, but some features need the Datadog Agent. Moving here from Dash0 trades usage pricing for per-host and per-product meters.",
			pros: [
				"More than 800 vendor-maintained integrations",
				"Full RUM, mobile RUM and browser synthetics",
				"SOC 2, ISO 27001, HIPAA and FedRAMP",
			],
			cons: [
				"Per-host pricing plus a separate meter for each product",
				"Some features need the Datadog Agent, not just OpenTelemetry",
				"Closed source and SaaS only",
			],
			compareSlug: "datadog",
		},
		{
			id: "new-relic",
			name: "New Relic",
			url: "https://newrelic.com",
			pickIf: "A few people use it, you want 100 GB free, and NRQL suits you.",
			pricing: "100 GB free, then $0.40 per GB, plus per-user fees",
			openSource: "No (the agents are open source); SaaS only",
			promql: "No",
			summary:
				"New Relic gives every account 100 GB of ingest free and charges per GB after that, which is closer to Dash0's model than Datadog's. The catch is users: full-platform seats cost $99 each on Standard, capped at five, and $349 on Pro. It accepts OTLP, with some features only through its own agents.",
			pros: [
				"100 GB of ingest free every month",
				"NRQL, a SQL-like language across every data type",
				"Scripted browser and API checks included",
			],
			cons: [
				"Per-user fees that grow with the team",
				"Eight days of trace retention by default",
				"Some features need New Relic's agents",
			],
			compareSlug: "new-relic",
		},
	],
	faqs: [
		{
			question: "What is the best Dash0 alternative?",
			answer: "It depends on why you are leaving. To keep Dash0's model (OpenTelemetry-native, usage-priced, no per-seat fee) and gain the source and self-hosting, look at Maple or SigNoz. If PromQL and dashboards-as-code matter most, Grafana is the natural home. For high-cardinality debugging, Honeycomb. Maple also covers uptime checks, on-call and SLOs; if you need phone and SMS paging, Better Stack. We build Maple, so weigh our view accordingly.",
		},
		{
			question: "Is there an open-source alternative to Dash0?",
			answer: "Yes, several. Maple is source-available under FSL-1.1 and becomes Apache 2.0 two years after each release. SigNoz has an MIT core with SSO and RBAC under a commercial license. Grafana, Loki, Tempo and Mimir are AGPL-3.0. Dash0 itself open-sources its OpenTelemetry distribution and Kubernetes operator, but not the platform.",
		},
		{
			question: "Which Dash0 alternatives support PromQL?",
			answer: "SigNoz, Grafana and Better Stack. Maple, Honeycomb, Axiom, Datadog and New Relic use their own builders or query languages. If your alerting and dashboards are written in PromQL, start with those three.",
		},
		{
			question: "How hard is it to move off Dash0?",
			answer: "The pipeline is the easy part. Dash0 ingests standard OTLP, so with any OpenTelemetry-native backend you add a second exporter to the Collector, send to both while you check the new tool, then remove the Dash0 exporter. Dashboards, saved views and alert rules do not travel over OTLP, so plan to rebuild the ones you use.",
		},
		{
			question: "Is a Dash0 alternative cheaper?",
			answer: "Not automatically. Dash0 bills per span, log record and metric data point; Maple, SigNoz, Grafana, Better Stack and Axiom bill per GB; Honeycomb bills per event; Datadog per host; New Relic per GB plus per user. Small, numerous items favor per-GB pricing; wide spans and long log lines favor per-item pricing. The Maple vs Dash0 page prices one month on both and has a calculator for your own numbers.",
		},
	],
	sources: [
		...(competitorBySlug("dash0")?.sources ?? []).map((source, i) =>
			i === 0 ? { ...source, checked: PRICES_CHECKED } : source,
		),
		...pricingSource("signoz"),
		...pricingSource("grafana"),
		...pricingSource("honeycomb"),
		...pricingSource("better-stack"),
		...pricingSource("axiom"),
		...pricingSource("datadog"),
		...pricingSource("new-relic"),
	],
}

export const alternativesPages: AlternativesPage[] = [dash0]

export const alternativesBySlug = (slug: string) => alternativesPages.find((page) => page.slug === slug)

export const alternativesPath = (slug: string) => `/alternatives/${slug}`
