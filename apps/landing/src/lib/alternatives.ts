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
 * page, so it is backed by a dated source in `competitors.ts`, or cites a
 * dated source listed on the page itself (tools with no compare page). Change
 * a price there and here together.
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
	/** The page's key column (`AlternativesPage.keyColumn`), the one fact this vendor's leavers check first. */
	keyFact: string
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
	/** One line for the lists that link here: the compare hub, the guides index and llms.txt. */
	blurb: string
	/** ISO date the page was last reviewed against the sources. */
	updated: string
	disclosure: string
	/** How the facts were gathered, including what we did not do. */
	method: string
	/** Header of the table's last column, which differs per vendor. */
	keyColumn: string
	/** The vendor itself as the table's first, reference row. */
	baseline: Pick<Alternative, "name" | "pricing" | "openSource" | "keyFact">
	/** The short answer, one line per kind of team, before the table. */
	quickAnswer: { team: string; pick: string; why: string }[]
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

/** A vendor page with no `/compare` entry behind it, cited on the roundup itself. */
const checkedNow = (label: string, url: string): Source => ({ label, url, checked: PRICES_CHECKED })

/** Maple's own prices and retention, held to the same citation rule as everyone else's. */
const MAPLE_SOURCE = checkedNow("Maple pricing and retention", "https://maple.dev/pricing")

const dash0: AlternativesPage = {
	slug: "dash0",
	vendor: "Dash0",
	vendorUrl: "https://www.dash0.com",
	seoTitle: "Dash0 Alternatives (2026): 8 OpenTelemetry Tools Compared",
	seoDescription:
		"Eight Dash0 alternatives compared on pricing, open source, self-hosting and PromQL, plus when to stay on Dash0. Written by the Maple team, with sources.",
	title: "Dash0 alternatives",
	blurb: "Eight OpenTelemetry tools compared on pricing, self-hosting and PromQL, and when to stay on Dash0.",
	lede: "Dash0 is an OpenTelemetry-native, usage-priced SaaS with PromQL and Perses dashboards. Teams look elsewhere when they want the source and the option to self-host, want uptime and on-call in the same app as their traces, or price their data differently. These are the eight tools worth comparing, and what each one is good for.",
	updated: "2026-11-08",
	disclosure:
		"We build Maple and list it first because this is our site: that placement is our bias, not a ranking. The other entries are ordered by how close they are to Dash0: OpenTelemetry-native, usage-priced tools first, per-host and per-user platforms last. Every price comes from the vendor's own pricing page, linked at the bottom with the month we checked it.",
	method: "How we compared: we read each vendor's pricing page and documentation, re-checked every price in November 2026, and reused the sourced rows from our side-by-side comparison pages. We did not benchmark the tools against each other; treat this as a map of trade-offs, not a test result.",
	keyColumn: "PromQL",
	baseline: {
		name: "Dash0 (for reference)",
		pricing: "$0.60 per million spans or log records, $0.20 per million metric data points",
		openSource: "Closed; SaaS only (its filtering collector can run in your cluster)",
		keyFact: "Yes",
	},
	quickAnswer: [
		{
			team: "Small or mid-size team already on OpenTelemetry",
			pick: "Maple",
			why: "Same usage-based, no-seat model, with uptime checks, on-call, error tracking and session replay in the same app, which can replace separate uptime and error tools.",
		},
		{
			team: "Must self-host and keep PromQL",
			pick: "SigNoz or Grafana",
			why: "Both take PromQL and have mature self-hosted installs (Docker and Helm). Maple runs PromQL on Maple Cloud only; its self-hosted version has no dashboards or PromQL yet.",
		},
		{
			team: "Need phone and SMS paging",
			pick: "Better Stack",
			why: "On-call with phone and SMS alerts next to your logs and traces.",
		},
		{
			team: "Debugging high-cardinality traces",
			pick: "Honeycomb",
			why: "BubbleUp ranks what is different about the slow or failing requests.",
		},
		{
			team: "Large company needing HIPAA, FedRAMP and security products",
			pick: "Datadog",
			why: "The broadest platform here, with SOC 2, ISO 27001, HIPAA and FedRAMP.",
		},
	],
	stayIf: [
		"Your alerts are PromQL rules, or your dashboards live as Perses dashboards-as-code. Leaving means rewriting the alerts: of the tools above, SigNoz, Grafana and Better Stack take PromQL alerts, while Maple runs PromQL queries and dashboards but keeps its own alert rules. Perses dashboards import into Maple with their PromQL panels as placeholders to rebuild.",
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
				"Source-available (FSL-1.1, Apache 2.0 after two years); self-hosts for one team, without alerting, dashboards or PromQL yet",
			keyFact: "Yes",
			summary:
				"Maple starts from the same place as Dash0: OpenTelemetry in, usage-based pricing, no per-seat fee, an MCP server for agents. The source is on GitHub and it self-hosts as one container. Around traces, logs and metrics it puts the rest of the on-call loop in the same app: uptime checks and cron heartbeats, on-call schedules with escalation, SLOs with burn-rate alerts, errors grouped into issues, and browser session replay linked to the trace behind each click.",
			pros: [
				"Source on GitHub; self-hosts as one container, and “maple start” runs it on a laptop",
				"Uptime checks, cron heartbeats and on-call schedules with escalation (email, Slack, Discord)",
				"SLOs with burn-rate alerts, and errors grouped into issues with an owner and a state",
				"Session replay linked to traces, plus a hosted MCP server and alert investigations",
			],
			cons: [
				"30 days for traces and logs, 90 for metrics, against Dash0's 13 months for metrics",
				"The self-hosted version has no alerting, dashboards, PromQL or team accounts yet",
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
			keyFact: "Yes",
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
			pricing: "Free tier, then $19/mo + $8 per user beyond three, $0.55 per GB of logs and traces",
			openSource: "AGPL-3.0 (Grafana, Loki, Tempo, Mimir); Cloud is proprietary",
			keyFact: "Yes",
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
			keyFact: "No",
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
			keyFact: "Yes",
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
			keyFact: "No",
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
			keyFact: "No",
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
			keyFact: "No",
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
			answer: "SigNoz, Grafana and Better Stack take PromQL for queries and alerts. Maple runs PromQL queries. Grafana dashboards import with their PromQL panels; Perses dashboards import too, but their PromQL panels come in as placeholders to rebuild. Alert rules have to be set up again in Maple. Honeycomb, Axiom, Datadog and New Relic use their own builders or query languages.",
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
		MAPLE_SOURCE,
	],
}

const CLICKSTACK_SOURCES = [
	checkedNow(
		"ClickStack overview",
		"https://clickhouse.com/docs/use-cases/observability/clickstack/overview",
	),
	checkedNow("ClickStack on GitHub (MIT)", "https://github.com/hyperdxio/hyperdx"),
]

const OPENOBSERVE_SOURCES = [
	checkedNow("OpenObserve pricing", "https://openobserve.ai/pricing/"),
	checkedNow("OpenObserve documentation", "https://openobserve.ai/docs/"),
]

const datadog: AlternativesPage = {
	slug: "datadog",
	vendor: "Datadog",
	vendorUrl: "https://www.datadoghq.com",
	seoTitle: "Datadog Alternatives (2026): 8 Tools Without Per-Host Pricing",
	seoDescription:
		"Eight Datadog alternatives compared on pricing model, self-hosting and OpenTelemetry, plus when to stay. Written by the Maple team, with sources.",
	title: "Datadog alternatives",
	blurb: "Eight tools without per-host pricing, the self-hostable ones first, and when Datadog is still the right call.",
	lede: "Datadog bills each host for infrastructure, bills it again for APM, and meters logs, custom metrics and every add-on product on its own. Teams look elsewhere when that bill grows faster than their traffic, when they move to OpenTelemetry and no longer need the Datadog Agent, or when the data has to stay on their own servers. These are the eight tools worth comparing, and when Datadog is still the right call.",
	updated: "2026-11-21",
	disclosure:
		"We build Maple and list it first because this is our site: that placement is our bias, not a ranking. The rest are grouped by the reason people leave Datadog: the self-hostable tools first, then hosted platforms that price differently. Every price comes from the vendor's own pricing page, linked at the bottom with the month we checked it.",
	method: "How we compared: we re-read each vendor's pricing page in November 2026. Other facts repeat sourced rows from our side-by-side comparison pages, each with the month it was last checked. ClickStack and OpenObserve have no comparison page, so their facts link to their own pages below. We did not benchmark the tools against each other; treat this as a map of trade-offs, not a test result.",
	keyColumn: "Self-host",
	baseline: {
		name: "Datadog (for reference)",
		pricing:
			"Per host: infrastructure from $15, APM from $31; logs $0.10/GB plus $1.70 per million indexed events",
		openSource: "No (the Agent is open source); SaaS only",
		keyFact: "No",
	},
	quickAnswer: [
		{
			team: "Small or mid-size team moving to OpenTelemetry",
			pick: "Maple",
			why: "One per-GB plan with no host or seat fee, covering traces, logs, metrics, uptime checks, on-call and session replay; browser sessions are the one extra meter.",
		},
		{
			team: "Must self-host, and needs alerting and dashboards there",
			pick: "SigNoz or Grafana",
			why: "Both have mature self-hosted installs with Helm. Maple self-hosts too, but without alerting or dashboards yet.",
		},
		{
			team: "Already reads Prometheus metrics in Grafana",
			pick: "Grafana Cloud",
			why: "PromQL dashboards and recording rules carry over unchanged.",
		},
		{
			team: "Wants a hosted platform of the same breadth",
			pick: "New Relic",
			why: "APM, browser, mobile and scripted synthetics, billed per GB and per user instead of per host.",
		},
		{
			team: "Debugging requests you cannot reproduce",
			pick: "Honeycomb",
			why: "BubbleUp compares the slow or failing requests against the rest, attribute by attribute.",
		},
	],
	stayIf: [
		"You use Datadog's security or network products: Cloud SIEM, Cloud Security, Network Performance Monitoring or CI Visibility. None of the tools here replaces all of them.",
		"Much of what you monitor never emits OpenTelemetry. Datadog maintains more than 800 integrations, many for systems that only its Agent can read.",
		"You need HIPAA or FedRAMP. Datadog holds both, with SOC 2 and ISO 27001.",
		"You rely on full RUM with funnels and heatmaps, mobile RUM for iOS and Android, or browser tests from managed locations.",
		"You run a small number of large hosts that send a lot of data. Per-host pricing is kindest to that shape, and the switch may not save much.",
	],
	alternatives: [
		{
			id: "maple",
			name: "Maple",
			url: "https://maple.dev",
			ours: true,
			pickIf: "You are moving to OpenTelemetry and want a per-GB bill with no host or seat fee.",
			pricing: "$39/mo with 100 GB each of logs, traces and metrics, then $0.30 per GB",
			openSource: "Source-available (FSL-1.1, Apache 2.0 after two years)",
			keyFact: "Yes, as one container for one team; no alerting, dashboards or PromQL yet",
			summary:
				"Maple ingests OpenTelemetry directly, so the OpenTelemetry Collector and SDKs take the place of the Datadog Agent and tracing libraries. It bills on data volume only: a hundred containers on one host cost the same as one process on a hundred hosts, at equal volume. Traces, logs, metrics, errors grouped into issues, uptime checks, on-call schedules, SLOs and session replay share one plan. Browser sessions are the only other meter, with 5,000 a month included and $0.002 each after that.",
			pros: [
				"No per-host or per-seat fee; browser sessions are the one extra meter",
				"Source on GitHub; self-hosts as one container",
				"Session replay linked to the backend trace behind each click",
				"A hosted MCP server, and investigations that write up what broke when an alert fires",
			],
			cons: [
				"No Network Performance Monitoring, Cloud SIEM or CI Visibility",
				"Uptime checks are HTTP, TCP and DNS; no scripted browser tests",
				"An OpenTelemetry-first catalog, not 800 vendor-maintained integrations",
				"SOC 2 and ISO 27001 certification still in progress",
				"No free plan; it starts at $39 a month",
			],
			compareSlug: "datadog",
		},
		{
			id: "signoz",
			name: "SigNoz",
			url: "https://signoz.io",
			pickIf: "You want to self-host APM, logs, metrics and alerts under an MIT core.",
			pricing: "$49/mo including $49 of usage, then $0.30 per GB of logs and traces",
			openSource: "MIT core, SSO and RBAC under a commercial license",
			keyFact: "Yes: Docker, Swarm, Helm and Foundry installs",
			summary:
				"SigNoz is an OpenTelemetry-native platform with APM, logs, metrics, dashboards and alerts. Its self-hosted Community edition is multi-user with roles, and its cloud has no user-based pricing and no host count. Metrics are billed per sample, so many small series do not turn into a custom-metrics line.",
			pros: [
				"No user-based pricing on SigNoz Cloud",
				"Multi-user with roles in the free, self-hosted Community edition",
				"Metric samples billed at $0.10 per million; Prometheus rules carry over",
			],
			cons: [
				"15 days for logs and traces by default; longer retention raises the rate",
				"SAML, OIDC and fine-grained RBAC sit under the commercial license",
				"Exceptions are grouped by service, type and message, with no owner or state on a group",
			],
			compareSlug: "signoz",
		},
		{
			id: "grafana",
			name: "Grafana Cloud / LGTM",
			url: "https://grafana.com",
			pickIf: "Your metrics are already Prometheus, and you want logs and traces next to them.",
			pricing: "Free tier, then $19/mo + $8 per user beyond three, $0.55 per GB of logs and traces",
			openSource: "AGPL-3.0 (Grafana, Loki, Tempo, Mimir); Cloud is proprietary",
			keyFact: "Yes, as four services (Grafana, Loki, Tempo, Mimir)",
			summary:
				"Grafana Cloud replaces per-host billing with per-GB rates for logs and traces and a per-series rate for metrics. Teams that already scrape Prometheus keep their dashboards and recording rules as they are. Grafana IRM adds on-call schedules and escalation chains. The open-source stack self-hosts with mature Helm charts, as four services with their own scaling.",
			pros: [
				"PromQL, LogQL and TraceQL, with dashboards-as-code",
				"Hundreds of plugins, and data sources such as Postgres and CloudWatch in one panel",
				"On-call with escalation chains in Grafana IRM",
			],
			cons: [
				"$6.50 per thousand active metric series: high-cardinality metrics stay expensive",
				"$8 per active user beyond the three included",
				"A query language per signal, and four services to run when self-hosted",
			],
			compareSlug: "grafana",
		},
		{
			id: "clickstack",
			name: "ClickStack (formerly HyperDX)",
			url: "https://clickhouse.com/clickstack",
			pickIf: "You run ClickHouse already, or want an MIT-licensed stack to search logs and traces.",
			pricing: "Free to self-host; managed on ClickHouse Cloud",
			openSource: "Open source (MIT)",
			keyFact: "Yes; one all-in-one Docker image to try it",
			summary:
				"ClickStack is ClickHouse's observability stack: a UI, a preconfigured OpenTelemetry Collector and ClickHouse itself. It searches logs, traces, metrics and session replays in one place, with Lucene-style filters for search and SQL for deeper questions. The UI can also connect to a ClickHouse you already run.",
			pros: [
				"MIT license; each component scales on its own",
				"Full-text search plus SQL over the same data",
				"Session replay alongside logs and traces",
			],
			cons: [
				"No PromQL in its documentation; metrics are queried with SQL or the builder",
				"At volume you operate ClickHouse yourself, or move to ClickHouse Cloud",
			],
		},
		{
			id: "openobserve",
			name: "OpenObserve",
			url: "https://openobserve.ai",
			pickIf: "You want to self-host one platform for logs, metrics and traces, free up to 50 GB a day.",
			pricing: "Cloud $0.50 per GB ingested (annual), plus $0.01 per GB queried",
			openSource:
				"AGPL-3.0 open-source edition; Enterprise edition free to self-host up to 50 GB a day",
			keyFact: "Yes",
			summary:
				"OpenObserve covers logs, metrics, traces, RUM, session replay and error tracking, queried with SQL and PromQL. The open-source edition is AGPL-3.0, and the self-hosted Enterprise edition is free up to 50 GB of ingestion a day. Its cloud has unlimited users with no per-seat charge, and keeps metrics for 15 months and logs and traces for 30 days.",
			pros: [
				"Self-hosted Enterprise edition free up to 50 GB a day",
				"Unlimited users on every cloud plan",
				"SQL and PromQL; metrics kept 15 months on Cloud",
			],
			cons: [
				"Queries on Cloud are billed per GB scanned",
				"Above 50 GB a day, the self-hosted Enterprise edition is priced by sales",
			],
		},
		{
			id: "new-relic",
			name: "New Relic",
			url: "https://newrelic.com",
			pickIf: "You want a hosted platform as broad as Datadog, and few people need full access.",
			pricing: "100 GB free, then $0.40 per GB, plus per-user fees",
			openSource: "No (the agents are open source); SaaS only",
			keyFact: "No",
			summary:
				"New Relic is the closest like-for-like move: APM, browser and mobile monitoring, scripted synthetics and vulnerability management in one hosted platform. It drops the per-host meter for 100 GB of free ingest and $0.40 per GB after that. The bill moves to users instead: full-platform users are $99 each on Standard, capped at five, and $349 on Pro.",
			pros: [
				"No per-host fee, and 100 GB of ingest free every month",
				"Scripted browser and API checks included in the platform",
				"NRQL, one SQL-like language across every data type",
			],
			cons: [
				"Per-user fees grow with the team",
				"Eight days of trace retention by default",
				"Some features need New Relic's agents",
			],
			compareSlug: "new-relic",
		},
		{
			id: "honeycomb",
			name: "Honeycomb",
			url: "https://www.honeycomb.io",
			pickIf: "Your hardest incidents are slow or failing requests you cannot reproduce.",
			pricing: "Free up to 20M events/mo; Pro $3.00 per million events, from $150",
			openSource: "No (Refinery is Apache 2.0)",
			keyFact: "Enterprise only (Private Cloud in your AWS account)",
			summary:
				"Honeycomb is a query engine for wide events. BubbleUp ranks every attribute of a slow or failing slice of requests against the baseline. It bills per event with no host count and unlimited seats, and keeps 60 days of events and metrics on every plan.",
			pros: [
				"BubbleUp outlier analysis, heatmaps and SLOs with burn-rate alerts",
				"A free plan with 20M events a month",
				"Unlimited seats, and 60 days of retention on every plan",
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
			pickIf: "You want uptime, on-call with phone and SMS, logs and traces on one bill.",
			pricing: "Bundles from $30/mo; logs and traces $0.10/GB + $0.05/GB-month stored (EU)",
			openSource: "Closed source; SaaS, custom VPC on Enterprise",
			keyFact: "No (custom VPC on Enterprise)",
			summary:
				"Better Stack is an incident platform with telemetry attached: uptime checks, on-call schedules and incident channels, fed by logs, traces, errors and replays. It ingests OTLP, takes PromQL, and its per-GB rate for logs and traces is among the lowest here. Its error tracking accepts the Sentry SDKs.",
			pros: [
				"Low log and trace rates, with storage billed separately",
				"Uptime, Playwright checks, and on-call with phone and SMS",
				"Error tracking with 100,000 exceptions a month free",
			],
			cons: [
				"Closed source, with no self-hosting",
				"Anyone on call needs a $34/mo Responder license",
				"Metrics billed on stored size, from $0.50 per GB-month",
			],
			compareSlug: "better-stack",
		},
	],
	faqs: [
		{
			question: "What is the best Datadog alternative?",
			answer: "It depends on why you are leaving. If the bill is the reason and you are on OpenTelemetry, look at the per-GB tools: Maple, SigNoz, Grafana Cloud or Better Stack. If the data must stay on your servers, SigNoz, the Grafana stack, ClickStack and OpenObserve all self-host; Maple self-hosts too, without alerting, dashboards or PromQL yet. If you want the same breadth in a hosted platform, New Relic. We build Maple, so weigh our view accordingly.",
		},
		{
			question: "Why does a Datadog bill grow so fast?",
			answer: "Because several meters stack on the same host. Infrastructure is $15 per host and APM another $31 per host on annual billing. Logs are charged twice: $0.10 per GB ingested, then $1.70 per million events indexed at 15-day retention. Infrastructure Pro includes 100 custom metrics per host, and more are billed on their own line. RUM, synthetics and each security product add their own meters.",
		},
		{
			question: "Is there an open-source alternative to Datadog?",
			answer: "Yes. SigNoz has an MIT core with SSO and RBAC under a commercial license. Grafana, Loki, Tempo and Mimir are AGPL-3.0. ClickStack is MIT. OpenObserve's open-source edition is AGPL-3.0. Maple is source-available under FSL-1.1 and becomes Apache 2.0 two years after each release. Datadog open-sources its Agent, not the platform.",
		},
		{
			question: "How do I move off Datadog without downtime?",
			answer: "Run both for a while. Services on OpenTelemetry SDKs only need a second exporter in the Collector. Where the Datadog Agent is the only source, the OpenTelemetry Collector has receivers for host metrics, Kubernetes and file logs. Code on Datadog's tracing libraries moves to OpenTelemetry SDKs, which cover the same languages. Dashboards and monitors do not cross vendors, so rebuild the ones you use.",
		},
		{
			question: "Is a Datadog alternative cheaper?",
			answer: "Usually, when you run many small hosts or containers, because per-GB pricing ignores the host count. Not always, when you run a few large hosts that send a lot of data, because per-host pricing is kindest to that shape. The Maple vs Datadog page prices one month on both at list price and has a calculator for your own numbers.",
		},
	],
	sources: [
		MAPLE_SOURCE,
		...(competitorBySlug("datadog")?.sources ?? []).map((source, i) =>
			i === 0 ? { ...source, checked: PRICES_CHECKED } : source,
		),
		...pricingSource("signoz"),
		...pricingSource("grafana"),
		...CLICKSTACK_SOURCES,
		...OPENOBSERVE_SOURCES,
		...pricingSource("new-relic"),
		...pricingSource("honeycomb"),
		...pricingSource("better-stack"),
	],
}

const grafana: AlternativesPage = {
	slug: "grafana",
	vendor: "Grafana",
	vendorUrl: "https://grafana.com",
	seoTitle: "Grafana Alternatives (2026): 7 Tools Instead of the LGTM Stack",
	seoDescription:
		"Seven alternatives to Grafana, Loki, Tempo and Mimir, compared on PromQL, self-hosting and price. Written by the Maple team, with sources.",
	title: "Grafana alternatives",
	blurb: "Seven tools instead of running Loki, Tempo and Mimir, compared on PromQL and self-hosting.",
	lede: "Grafana is the dashboard most engineers already know. Behind it sits a stack: Loki for logs, Tempo for traces, Mimir or Prometheus for metrics, each with its own query language and scaling model. Teams look elsewhere when running four services takes more time than using them, when they want one query across signals, or when Grafana Cloud's per-user and per-series pricing stops fitting. These are the seven tools worth comparing, and when to stay.",
	updated: "2026-11-21",
	disclosure:
		"We build Maple and list it first because this is our site: that placement is our bias, not a ranking. The rest start with the self-hostable tools, which keep the most of a Grafana setup, then the hosted platforms. Every price comes from the vendor's own pricing page, linked at the bottom with the month we checked it.",
	method: "How we compared: we re-read each vendor's pricing page in November 2026. Other facts repeat sourced rows from our side-by-side comparison pages, each with the month it was last checked. OpenObserve and ClickStack have no comparison page, so their facts link to their own pages below. We did not benchmark the tools against each other; treat this as a map of trade-offs, not a test result.",
	keyColumn: "PromQL",
	baseline: {
		name: "Grafana Cloud / LGTM (for reference)",
		pricing:
			"Free tier, then $19/mo + $8 per user beyond three, $6.50 per 1k active series, $0.55 per GB of logs and traces",
		openSource: "AGPL-3.0 (Grafana, Loki, Tempo, Mimir); Cloud is proprietary",
		keyFact: "Yes",
	},
	quickAnswer: [
		{
			team: "Self-hosting LGTM and tired of running four services",
			pick: "SigNoz or OpenObserve",
			why: "One platform each in place of four services, both self-hosted with PromQL.",
		},
		{
			team: "On Grafana Cloud, paying per user and per series",
			pick: "Maple",
			why: "One store for traces, logs and metrics, PromQL for metrics, Grafana dashboard import, and no per-user or active-series meter.",
		},
		{
			team: "Log and trace search is most of the work",
			pick: "ClickStack",
			why: "Full-text search and SQL over logs and traces, under an MIT license.",
		},
		{
			team: "Debugging high-cardinality traces",
			pick: "Honeycomb",
			why: "BubbleUp ranks what is different about the slow or failing requests.",
		},
		{
			team: "Want hosted PromQL with phone and SMS paging",
			pick: "Better Stack",
			why: "PromQL, uptime checks and on-call in one hosted product.",
		},
	],
	stayIf: [
		"Your dashboards query more than telemetry: Postgres, Elasticsearch, CloudWatch and dozens of other data sources sit in one Grafana panel. None of the tools here matches the plugin catalog.",
		"Your alerting is Prometheus rules and recording rules. Grafana keeps them as they are. SigNoz and Better Stack take Prometheus queries; Maple runs PromQL queries and dashboards but has its own alert rules, so those are rebuilt.",
		"The free tier covers you: 10,000 active series, 50 GB of logs, 50 GB of traces and three users, with 14 days of retention.",
		"You must self-host dashboards and alerting under an open-source license, and your team already runs the stack well. Maple's self-hosted version has no dashboards or alerting yet.",
	],
	alternatives: [
		{
			id: "maple",
			name: "Maple",
			url: "https://maple.dev",
			ours: true,
			pickIf: "You want traces, logs and metrics in one store behind one query surface, with PromQL for metrics and a Grafana dashboard import.",
			pricing: "$39/mo with 100 GB each of logs, traces and metrics, then $0.30 per GB",
			openSource: "Source-available (FSL-1.1, Apache 2.0 after two years)",
			keyFact: "Yes, on Maple Cloud",
			summary:
				"Maple stores traces, logs and metrics in one place and correlates them by trace id, so a log line opens its trace without a second data source. Metrics take PromQL, and Grafana dashboards import: each panel keeps its first query, rows become sections, and an import report lists anything Maple cannot run yet. There is no per-user fee and no active-series meter; metrics are priced per GB like the other signals.",
			pros: [
				"One query builder for every signal, PromQL for metrics, and SQL through the API and MCP server",
				"Grafana dashboard import, with a report of what did not carry over",
				"No per-user fee and no active-series meter",
				"Uptime checks, on-call schedules, SLOs and error issues in the same app",
			],
			cons: [
				"No plugin ecosystem and no non-telemetry data sources",
				"Alert rules are Maple's own; Prometheus rules are rebuilt",
				"The self-hosted version has no dashboards, PromQL or alerting yet",
				"Younger, with a smaller community, and no free plan on Maple Cloud",
				"SOC 2 and ISO 27001 certification still in progress",
			],
			compareSlug: "grafana",
		},
		{
			id: "signoz",
			name: "SigNoz",
			url: "https://signoz.io",
			pickIf: "You self-host LGTM and want one platform to run instead of four, keeping PromQL.",
			pricing: "$49/mo including $49 of usage, then $0.30 per GB of logs and traces",
			openSource: "MIT core, SSO and RBAC under a commercial license",
			keyFact: "Yes",
			summary:
				"SigNoz keeps traces, logs and metrics together and queries them with its builder, SQL and PromQL. Prometheus rules carry over. Self-hosting is one platform with Docker, Swarm, Helm and Foundry installs, and the Community edition is multi-user with roles and Google OAuth. Its cloud has no user-based pricing.",
			pros: [
				"PromQL in dashboards, and Prometheus rules carry over",
				"One platform to deploy and upgrade",
				"No user-based pricing on SigNoz Cloud",
			],
			cons: [
				"15 days for logs and traces and one month for metrics by default",
				"SAML, OIDC and fine-grained RBAC sit under the commercial license",
			],
			compareSlug: "signoz",
		},
		{
			id: "openobserve",
			name: "OpenObserve",
			url: "https://openobserve.ai",
			pickIf: "You want one self-hosted service for logs, metrics and traces, with SQL and PromQL.",
			pricing: "Cloud $0.50 per GB ingested (annual), plus $0.01 per GB queried",
			openSource:
				"AGPL-3.0 open-source edition; Enterprise edition free to self-host up to 50 GB a day",
			keyFact: "Yes",
			summary:
				"OpenObserve puts logs, metrics and traces in one platform, with SQL for logs and traces and PromQL for metrics from any Prometheus-compatible source. It also covers RUM, session replay and error tracking. The open-source edition is AGPL-3.0, like Grafana's stack, and the self-hosted Enterprise edition is free up to 50 GB of ingestion a day.",
			pros: [
				"One service in place of Loki, Tempo and Mimir",
				"Self-hosted Enterprise edition free up to 50 GB a day",
				"Unlimited users on Cloud; metrics kept 15 months",
			],
			cons: [
				"The cloud trial lasts 14 days; there is no permanent free cloud tier",
				"Queries on Cloud are billed per GB scanned",
			],
		},
		{
			id: "clickstack",
			name: "ClickStack (formerly HyperDX)",
			url: "https://clickhouse.com/clickstack",
			pickIf: "Logs and traces are most of your volume, and you want full-text search and SQL over them.",
			pricing: "Free to self-host; managed on ClickHouse Cloud",
			openSource: "Open source (MIT)",
			keyFact: "Not in its documentation",
			summary:
				"ClickStack is ClickHouse's observability stack: a UI, a preconfigured OpenTelemetry Collector and ClickHouse. Logs, traces, metrics and session replays live in one store, searched with Lucene-style filters such as level:err or queried with SQL. That replaces LogQL and TraceQL with two query styles most engineers already know.",
			pros: [
				"MIT license; the collector, store and UI scale independently",
				"Full-text search plus SQL over one store",
				"An all-in-one Docker image to try it on a laptop",
			],
			cons: [
				"No PromQL in its documentation, so Prometheus dashboards are rebuilt",
				"At volume you operate ClickHouse yourself, or move to ClickHouse Cloud",
			],
		},
		{
			id: "honeycomb",
			name: "Honeycomb",
			url: "https://www.honeycomb.io",
			pickIf: "You would rather ask new questions of traces than maintain dashboards.",
			pricing: "Free up to 20M events/mo; Pro $3.00 per million events, from $150",
			openSource: "No (Refinery is Apache 2.0)",
			keyFact: "No",
			summary:
				"Honeycomb is a query engine for wide events, built for asking a question you did not plan a dashboard for. BubbleUp ranks what is different about a slow or failing slice of requests. It bills per event with unlimited seats, which removes Grafana Cloud's user meter.",
			pros: [
				"BubbleUp, heatmaps and SLOs with burn-rate alerts",
				"Unlimited seats and a free plan with 20M events a month",
				"60 days of retention on every plan",
			],
			cons: [
				"No PromQL; Prometheus dashboards and rules are rebuilt",
				"Closed source; single-tenant hosting only on Enterprise",
			],
			compareSlug: "honeycomb",
		},
		{
			id: "datadog",
			name: "Datadog",
			url: "https://www.datadoghq.com",
			pickIf: "You want nothing to operate, 800+ integrations and security products, and per-host pricing fits.",
			pricing: "Per host: infrastructure from $15, APM from $31, plus per-product meters",
			openSource: "No (the Agent is open source); SaaS only",
			keyFact: "No",
			summary:
				"Datadog removes the operating work: one Agent per host, more than 800 vendor-maintained integrations, and products for APM, logs, RUM, synthetics, network monitoring and security. It accepts OTLP, with some features only through the Agent. It does not take PromQL, so Prometheus dashboards and rules are rebuilt.",
			pros: [
				"More than 800 vendor-maintained integrations",
				"Full RUM, mobile RUM and browser tests",
				"SOC 2, ISO 27001, HIPAA and FedRAMP",
			],
			cons: [
				"Per-host pricing plus a meter for each product",
				"Some features need the Datadog Agent",
				"Closed source and SaaS only",
			],
			compareSlug: "datadog",
		},
		{
			id: "better-stack",
			name: "Better Stack",
			url: "https://betterstack.com",
			pickIf: "You want hosted PromQL with uptime checks and phone and SMS paging next to it.",
			pricing: "Bundles from $30/mo; logs and traces $0.10/GB + $0.05/GB-month stored (EU)",
			openSource: "Closed source; SaaS, custom VPC on Enterprise",
			keyFact: "Yes",
			summary:
				"Better Stack is an incident platform with telemetry attached. It ingests OTLP, queries with a builder, SQL and PromQL, and Prometheus queries carry over. Around the data it runs uptime checks, Playwright checks, on-call schedules and status pages. Readers are free; anyone on call needs a Responder license.",
			pros: [
				"PromQL and SQL, with low log and trace rates",
				"Uptime, Playwright checks, and on-call with phone and SMS",
				"Members who only read telemetry are free",
			],
			cons: [
				"Closed source, with no self-hosting",
				"Metrics billed on stored size, from $0.50 per GB-month",
				"$34/mo per on-call Responder license",
			],
			compareSlug: "better-stack",
		},
	],
	faqs: [
		{
			question: "What is the best Grafana alternative?",
			answer: "It depends on which part of Grafana you want to replace. To stop running Loki, Tempo and Mimir yourself, look at SigNoz or OpenObserve, which self-host as one platform with PromQL. To leave Grafana Cloud's per-user and per-series pricing while keeping PromQL dashboards, Maple. For log and trace search, ClickStack. If your dashboards mostly query business databases, stay on Grafana. We build Maple, so weigh our view accordingly.",
		},
		{
			question: "Is there an open-source alternative to the Grafana stack?",
			answer: "Grafana, Loki, Tempo and Mimir are already AGPL-3.0, so the usual question is how many services you want to run. SigNoz has an MIT core with SSO and RBAC under a commercial license. OpenObserve's open-source edition is AGPL-3.0. ClickStack is MIT. Maple is source-available under FSL-1.1 and becomes Apache 2.0 two years after each release.",
		},
		{
			question: "Which Grafana alternatives support PromQL?",
			answer: "SigNoz, OpenObserve and Better Stack take PromQL. Maple runs PromQL queries and dashboards on Maple Cloud, with its own alert rules. Honeycomb and Datadog use their own query builders and languages, and ClickStack's documentation lists Lucene-style search and SQL.",
		},
		{
			question: "Can I keep my Grafana dashboards?",
			answer: "On Maple, Grafana JSON imports: each panel keeps its first query, rows become sections, and an import report lists anything Maple cannot run yet. Log panels are read on the Logs page instead. Elsewhere, plan to rebuild the dashboards you actually use, and let the unused ones lapse.",
		},
		{
			question: "When does Grafana Cloud get expensive?",
			answer: "When users and metric series grow. Pro includes three active users, then charges $8 per user. Metrics cost $6.50 per thousand active series, so a label with many values multiplies the bill. Logs and traces cost $0.55 per GB with 30 days of retention. The Maple vs Grafana page prices one month on both at list price.",
		},
	],
	sources: [
		MAPLE_SOURCE,
		...(competitorBySlug("grafana")?.sources ?? []).map((source, i) =>
			i === 0 ? { ...source, checked: PRICES_CHECKED } : source,
		),
		...pricingSource("signoz"),
		...OPENOBSERVE_SOURCES,
		...CLICKSTACK_SOURCES,
		...pricingSource("honeycomb"),
		...pricingSource("datadog"),
		...pricingSource("better-stack"),
	],
}

const newRelic: AlternativesPage = {
	slug: "new-relic",
	vendor: "New Relic",
	vendorUrl: "https://newrelic.com",
	seoTitle: "New Relic Alternatives (2026): 7 Tools Compared on User Fees",
	seoDescription:
		"Seven New Relic alternatives compared on user fees, retention and price, plus when to stay. Written by the Maple team, with sources.",
	title: "New Relic alternatives",
	blurb: "Seven tools compared on user fees, retention and pricing; four charge no user fee at all.",
	lede: "New Relic gives every account 100 GB of ingest free and charges per GB after that. The line that grows is users: after the first, full-platform users cost $99 each on Standard, which caps at five, and $349 each on Pro. Teams look elsewhere when more engineers need full access, when eight days of trace retention is too short, or when they move to OpenTelemetry and want a backend built around it. These are the seven tools worth comparing, and when to stay.",
	updated: "2026-11-21",
	disclosure:
		"We build Maple and list it first because this is our site: that placement is our bias, not a ranking. The rest are ordered by the main reason people leave New Relic: tools with no user fee first, then tools that charge for some users, then Datadog, which charges per host. Every price comes from the vendor's own pricing page, linked at the bottom with the month we checked it.",
	method: "How we compared: we re-read each vendor's pricing page in November 2026. Other facts repeat sourced rows from our side-by-side comparison pages, each with the month it was last checked. OpenObserve has no comparison page, so its facts link to its own pages below. We did not benchmark the tools against each other; treat this as a map of trade-offs, not a test result.",
	keyColumn: "User fees",
	baseline: {
		name: "New Relic (for reference)",
		pricing: "100 GB free, then $0.40 per GB ($0.60 on Data Plus), plus user fees",
		openSource: "No (the agents are open source); SaaS only",
		keyFact: "Full-platform users $10 for the first, then $99 each on Standard (up to five); $349 on Pro",
	},
	quickAnswer: [
		{
			team: "Growing past five engineers who need full access",
			pick: "Maple",
			why: "No per-user fee, 30 days of traces by default, and errors, uptime and on-call in the same app.",
		},
		{
			team: "Must self-host",
			pick: "SigNoz or OpenObserve",
			why: "Both self-host, and neither charges per user on its cloud.",
		},
		{
			team: "Metrics are already Prometheus",
			pick: "Grafana Cloud",
			why: "Three users included, then $8 each, with PromQL dashboards that carry over.",
		},
		{
			team: "Debugging high-cardinality traces",
			pick: "Honeycomb",
			why: "Unlimited seats and 60 days of retention on every plan.",
		},
		{
			team: "Want the same breadth, priced another way",
			pick: "Datadog",
			why: "Per host instead of per user, with security and network products New Relic does not have.",
		},
	],
	stayIf: [
		"Only a few people need full-platform access. Basic users are free and core users are $49, so a team where most people read dashboards may pay little for seats.",
		"You fit the free tier: 100 GB of ingest a month and one full-platform user cost nothing.",
		"You run legacy runtimes that New Relic's agents support and OpenTelemetry does not.",
		"You use the scripted browser and API checks, or the vulnerability management and IAST that come with the platform.",
		"Your dashboards and alerts are written in NRQL. Every tool here has its own builder or query language, so they are rebuilt.",
	],
	alternatives: [
		{
			id: "maple",
			name: "Maple",
			url: "https://maple.dev",
			ours: true,
			pickIf: "More than a handful of engineers need full access, and you want to stop counting seats.",
			pricing: "$39/mo with 100 GB each of logs, traces and metrics, then $0.30 per GB",
			openSource: "Source-available (FSL-1.1, Apache 2.0 after two years)",
			keyFact: "None",
			summary:
				"Maple has no user line: the bill is data volume, so giving another engineer full access costs nothing. It ingests OpenTelemetry directly, and OpenTelemetry SDKs take the place of New Relic's language agents. Traces and logs are kept 30 days and metrics 90 by default, against New Relic's eight days for traces. One query builder works the same across signals, with SQL through the API and the MCP server.",
			pros: [
				"No per-user fee",
				"30 days for traces and logs, 90 for metrics, by default",
				"Errors grouped into issues, uptime checks, on-call schedules and session replay in one plan",
				"Source on GitHub; self-hosts as one container, without alerting or dashboards yet",
			],
			cons: [
				"No free plan; it starts at $39 a month",
				"Browser monitoring is session replay and web analytics; mobile is a Swift SDK for iOS",
				"No scripted browser tests or vulnerability management",
				"Runtimes without OpenTelemetry support have no Maple agent",
				"SOC 2 and ISO 27001 certification still in progress",
			],
			compareSlug: "new-relic",
		},
		{
			id: "signoz",
			name: "SigNoz",
			url: "https://signoz.io",
			pickIf: "You want OpenTelemetry-native APM with no user fees, hosted or self-hosted.",
			pricing: "$49/mo including $49 of usage, then $0.30 per GB of logs and traces",
			openSource: "MIT core, SSO and RBAC under a commercial license",
			keyFact: "None on SigNoz Cloud",
			summary:
				"SigNoz covers APM, logs, metrics, dashboards and alerts on OpenTelemetry. Its cloud has no user-based pricing and lets you add unlimited teammates. Its self-hosted Community edition is multi-user with roles, so a team can leave New Relic and host the replacement itself.",
			pros: [
				"No user-based pricing on Cloud",
				"Docker, Swarm, Helm and Foundry installs for self-hosting",
				"Builder, SQL and PromQL for queries",
			],
			cons: [
				"15 days for logs and traces by default: longer than New Relic's 8 for traces, shorter than its 30 for logs",
				"SAML, OIDC and fine-grained RBAC sit under the commercial license",
				"Exceptions are grouped by service, type and message, with no owner or state on a group",
			],
			compareSlug: "signoz",
		},
		{
			id: "honeycomb",
			name: "Honeycomb",
			url: "https://www.honeycomb.io",
			pickIf: "You debug by slicing traces by any attribute, and want everyone to have a seat.",
			pricing: "Free up to 20M events/mo; Pro $3.00 per million events, from $150",
			openSource: "No (Refinery is Apache 2.0)",
			keyFact: "None; unlimited seats",
			summary:
				"Honeycomb bills per event and gives every plan unlimited seats. It keeps 60 days of events and metrics on every plan, the free one included, which is more than seven times New Relic's default for traces. BubbleUp ranks what is different about the slow or failing requests.",
			pros: [
				"Unlimited seats",
				"60 days of retention on every plan",
				"BubbleUp, heatmaps and SLOs with burn-rate alerts",
			],
			cons: [
				"Closed source; single-tenant hosting only on Enterprise",
				"Frontend observability is an Enterprise add-on",
			],
			compareSlug: "honeycomb",
		},
		{
			id: "openobserve",
			name: "OpenObserve",
			url: "https://openobserve.ai",
			pickIf: "You want unlimited users, self-hosting, and metrics kept for 15 months.",
			pricing: "Cloud $0.50 per GB ingested (annual), plus $0.01 per GB queried",
			openSource:
				"AGPL-3.0 open-source edition; Enterprise edition free to self-host up to 50 GB a day",
			keyFact: "None; unlimited users",
			summary:
				"OpenObserve covers logs, metrics, traces, RUM, session replay and error tracking, queried with SQL and PromQL. Every cloud plan includes unlimited users with no per-seat charge. Metrics are kept 15 months and logs and traces 30 days. Self-hosted, the Enterprise edition is free up to 50 GB of ingestion a day.",
			pros: [
				"Unlimited users on every cloud plan",
				"RUM and session replay alongside logs, metrics and traces",
				"Self-hosted Enterprise edition free up to 50 GB a day",
			],
			cons: [
				"Queries on Cloud are billed per GB scanned",
				"The cloud trial lasts 14 days; there is no permanent free cloud tier",
			],
		},
		{
			id: "grafana",
			name: "Grafana Cloud / LGTM",
			url: "https://grafana.com",
			pickIf: "Your metrics are Prometheus, and three included users plus $8 each beats full-platform seats.",
			pricing: "Free tier, then $19/mo + $8 per user beyond three, $0.55 per GB of logs and traces",
			openSource: "AGPL-3.0 (Grafana, Loki, Tempo, Mimir); Cloud is proprietary",
			keyFact: "$8 per active user beyond three",
			summary:
				"Grafana Cloud still charges per user, at $8 per active user beyond the three included on Pro, far below New Relic's full-platform rate. Metrics are priced per active series and logs and traces per GB. PromQL dashboards and recording rules carry over, and the open-source stack self-hosts under AGPL-3.0.",
			pros: [
				"$8 per user, three included",
				"PromQL, LogQL and TraceQL, with dashboards-as-code",
				"Hundreds of plugins and data sources",
			],
			cons: [
				"$6.50 per thousand active metric series",
				"Three stores and three query languages",
				"Self-hosting means running four services",
			],
			compareSlug: "grafana",
		},
		{
			id: "better-stack",
			name: "Better Stack",
			url: "https://betterstack.com",
			pickIf: "Most of your team only reads telemetry, and a few people carry the pager.",
			pricing: "Bundles from $30/mo; logs and traces $0.10/GB + $0.05/GB-month stored (EU)",
			openSource: "Closed source; SaaS, custom VPC on Enterprise",
			keyFact: "Readers free; $34/mo per on-call Responder",
			summary:
				"Better Stack charges for the people on call. Members who only look at telemetry are free; anyone on call or working with uptime monitors needs a $34 Responder license, which includes phone and SMS alerts. Logs and traces cost $0.10 per GB plus $0.05 per GB a month stored in Europe.",
			pros: [
				"Readers are free",
				"Uptime, Playwright checks, and on-call with phone and SMS",
				"Low log and trace rates, with storage billed separately",
			],
			cons: [
				"Closed source, with no self-hosting",
				"Metrics billed on stored size, from $0.50 per GB-month",
			],
			compareSlug: "better-stack",
		},
		{
			id: "datadog",
			name: "Datadog",
			url: "https://www.datadoghq.com",
			pickIf: "You want a broader hosted platform, and your host count is small next to your headcount.",
			pricing: "Per host: infrastructure from $15, APM from $31, plus per-product meters",
			openSource: "No (the Agent is open source); SaaS only",
			keyFact: "Billed per host instead",
			summary:
				"Datadog prices the core products per host: infrastructure from $15 and APM from $31 a month on annual billing. For a large team on a small fleet that can cost less than New Relic's user fees; for a small team on a large fleet it costs more. It adds security, network monitoring and CI products New Relic does not have, each on its own meter.",
			pros: [
				"More than 800 vendor-maintained integrations",
				"Cloud SIEM, Network Performance Monitoring and CI Visibility",
				"SOC 2, ISO 27001, HIPAA and FedRAMP",
			],
			cons: [
				"Per-host pricing plus a meter for each product",
				"Logs are billed twice: per GB ingested and per million events indexed",
				"Some features need the Datadog Agent",
			],
			compareSlug: "datadog",
		},
	],
	faqs: [
		{
			question: "What is the best New Relic alternative?",
			answer: "It depends on why you are leaving. If it is the user fees, look at the tools with none: Maple, SigNoz, Honeycomb and OpenObserve. If it is the retention, Honeycomb keeps 60 days on every plan and Maple 30 days for traces. If you need to self-host, SigNoz or OpenObserve. If you want more products, Datadog. We build Maple, so weigh our view accordingly.",
		},
		{
			question: "How much do New Relic users cost?",
			answer: "On Standard, the first full-platform user is $10 and each additional one $99, up to five. On Pro, a full-platform user is $349 a month on an annual commitment or $418.80 month to month. Core users are $49 and basic users are free. The free tier includes one full-platform user and 100 GB of ingest a month.",
		},
		{
			question: "Is there an open-source alternative to New Relic?",
			answer: "Yes. SigNoz has an MIT core with SSO and RBAC under a commercial license. Grafana, Loki, Tempo and Mimir are AGPL-3.0, and so is OpenObserve's open-source edition. Maple is source-available under FSL-1.1 and becomes Apache 2.0 two years after each release. New Relic open-sources its agents, not the platform.",
		},
		{
			question: "How do I move off New Relic's agents?",
			answer: "Replace each language agent with the OpenTelemetry SDK for that language, then send OTLP to the new backend. If you already export through the OpenTelemetry Collector, add the new backend as a second exporter, run both while you check it, then remove New Relic. NRQL dashboards and alert conditions do not travel, so rebuild the ones you use.",
		},
		{
			question: "Is a New Relic alternative cheaper?",
			answer: "For one person under 100 GB a month, no: New Relic's free tier is hard to beat. Once several engineers need full access, the user fees can outgrow the data fees, and tools without them come out ahead. The Maple vs New Relic page prices one month for a ten-person team on both, where users are the largest line.",
		},
	],
	sources: [
		MAPLE_SOURCE,
		...(competitorBySlug("new-relic")?.sources ?? []).map((source, i) =>
			i === 0 ? { ...source, checked: PRICES_CHECKED } : source,
		),
		...pricingSource("signoz"),
		...pricingSource("honeycomb"),
		...OPENOBSERVE_SOURCES,
		...pricingSource("grafana"),
		...pricingSource("better-stack"),
		...pricingSource("datadog"),
	],
}

/** Sentry has no `/compare` page, so its facts and GlitchTip's and PostHog's are cited here. */
const SENTRY_SOURCES = [
	checkedNow("Sentry pricing", "https://sentry.io/pricing/"),
	checkedNow("Sentry pricing docs (per-unit rates, quotas)", "https://docs.sentry.io/pricing/"),
	checkedNow("Self-hosted Sentry", "https://develop.sentry.dev/self-hosted/"),
]

const GLITCHTIP_SOURCES = [
	checkedNow("GlitchTip", "https://glitchtip.com/"),
	checkedNow("GlitchTip pricing", "https://glitchtip.com/pricing"),
	checkedNow("GlitchTip: installation requirements", "https://glitchtip.com/documentation/install"),
	checkedNow("GlitchTip backend on GitLab (MIT)", "https://gitlab.com/glitchtip/glitchtip-backend"),
]

const POSTHOG_SOURCES = [
	checkedNow("PostHog: error tracking pricing", "https://posthog.com/docs/error-tracking/pricing"),
	checkedNow("PostHog: error tracking", "https://posthog.com/docs/error-tracking"),
	checkedNow("PostHog on GitHub (license, self-hosting)", "https://github.com/PostHog/posthog"),
]

/** The `index`-th source of a compare page, re-checked this month. */
const compareSource = (slug: string, index: number): Source[] => {
	const source = competitorBySlug(slug)?.sources[index]
	return source ? [{ ...source, checked: PRICES_CHECKED }] : []
}

const sentry: AlternativesPage = {
	slug: "sentry",
	vendor: "Sentry",
	vendorUrl: "https://sentry.io",
	seoTitle: "Sentry Alternatives (2026): 6 Error Tracking Options Compared",
	seoDescription:
		"Six Sentry alternatives, including GlitchTip and self-hosted Sentry, compared on price and SDK support. Written by the Maple team, with sources.",
	title: "Sentry alternatives",
	blurb: "Six error trackers, three of which keep the Sentry SDKs, and what self-hosted Sentry needs.",
	lede: "Sentry is where many teams start error tracking. They look elsewhere for three reasons: an error spike that runs through the monthly quota and either bills or drops events, self-hosted Sentry asking for 16 GB of RAM and its own Kafka, or wanting errors, traces and logs from OpenTelemetry in one place. These six tools answer one or more of those, and three of them keep the Sentry SDKs already in your code.",
	updated: "2026-11-21",
	disclosure:
		"We build Maple and list it first because this is our site: that placement is our bias, not a ranking. Next come the three options that keep the Sentry SDKs, then two that need a different SDK. Every price comes from the vendor's own pricing page, linked at the bottom with the month we checked it.",
	method: "How we compared: we re-read each vendor's pricing page and the documentation cited below in November 2026. Sentry, GlitchTip and PostHog have no comparison page on this site, so their facts link to their own pages below; Better Stack and SigNoz reuse sourced rows from our comparison pages, each with the month it was last checked. We did not benchmark the tools against each other; treat this as a map of trade-offs, not a test result.",
	keyColumn: "Sentry SDKs",
	baseline: {
		name: "Sentry (for reference)",
		pricing:
			"Free for one user; Team $29/mo, Business $89/mo, each with 50k errors and 5M spans, then per event",
		openSource: "FSL (Apache 2.0 after two years); self-hostable",
		keyFact: "Yes",
	},
	quickAnswer: [
		{
			team: "Keep the Sentry SDKs, lower the bill",
			pick: "Better Stack or GlitchTip",
			why: "Both accept the Sentry SDKs. Better Stack includes 100,000 exceptions a month; GlitchTip's hosted plans start at $15 for 100,000 events.",
		},
		{
			team: "Self-host on a small server",
			pick: "GlitchTip",
			why: "PostgreSQL and one service, with 512 MB of RAM recommended.",
		},
		{
			team: "Errors, traces, logs and replay from OpenTelemetry in one app",
			pick: "Maple",
			why: "Each error issue opens the trace that threw it, and exceptions are billed as part of trace volume, with no separate error quota.",
		},
		{
			team: "Keep Sentry itself, without the per-event bill",
			pick: "Self-hosted Sentry",
			why: "The same product and SDKs, if you can run a 16 GB server and support it yourself.",
		},
		{
			team: "Product team already on PostHog",
			pick: "PostHog",
			why: "Every issue comes with the user's session replay and events, and 100,000 exceptions a month are free.",
		},
	],
	stayIf: [
		"You use what Sentry adds on top of grouping: release health, Seer for AI debugging, and anomaly detection and Code Owners on Business.",
		"Your team is growing but your error volume is modest. Team includes unlimited users and 50,000 errors for $29 a month.",
		"You work alone. The Developer plan is free, with 5,000 errors, 5 million spans and a 30-day lookback.",
		"You prefer a hard cap. Past your reserved volume and pay-as-you-go budget, Sentry drops events instead of billing them.",
	],
	alternatives: [
		{
			id: "maple",
			name: "Maple",
			url: "https://maple.dev",
			ours: true,
			pickIf: "You want errors, traces, logs and session replay from OpenTelemetry in one app, priced per GB.",
			pricing:
				"$39/mo with 100 GB each of logs, traces and metrics, then $0.30 per GB; 5,000 browser sessions included",
			openSource: "Source-available (FSL-1.1, Apache 2.0 after two years)",
			keyFact: "No; OpenTelemetry SDKs",
			summary:
				"Maple builds error tracking from OpenTelemetry. Exceptions recorded on spans are grouped into issues by type, message and stack, and every issue opens the trace that threw it, with the query and status code at the time. Issues carry an owner, a severity and notes, and a resolved issue that comes back reopens. There is no per-error meter: exceptions are part of trace volume. Session replay, uptime checks, cron heartbeats and on-call are in the same plan.",
			pros: [
				"Every issue linked to the span and trace that threw it",
				"No per-error meter or error quota",
				"Session replay with the backend trace behind each click",
				"Uptime checks, cron heartbeats, on-call schedules and SLOs in one plan",
			],
			cons: [
				"No intake for the Sentry SDKs; you instrument with OpenTelemetry",
				"Mobile is a Swift SDK for iOS",
				"No free plan; it starts at $39 a month",
				"Younger, with a smaller ecosystem; SOC 2 and ISO 27001 certification still in progress",
			],
		},
		{
			id: "glitchtip",
			name: "GlitchTip",
			url: "https://glitchtip.com",
			pickIf: "You want Sentry-compatible error tracking on a small server, or a low-cost hosted plan.",
			pricing: "Free to 1,000 events/mo; $15/mo for 100k, $50 for 500k, $250 for 3M",
			openSource: "Open source (MIT)",
			keyFact: "Yes",
			summary:
				"GlitchTip is open-source error tracking that works with Sentry's client SDKs, so the SDKs already in your code can send to it. It also covers performance, uptime checks and logs. Self-hosted, it needs PostgreSQL and a single service, with 512 MB of RAM recommended and Valkey optional. Its hosted plans count each error and each performance transaction as one event, and ten uptime checks or log lines as one.",
			pros: [
				"Works with Sentry's client SDKs",
				"Self-hosts on PostgreSQL with 512 MB of RAM recommended",
				"Hosted plans from $15 a month for 100,000 events",
			],
			cons: [
				"Session replay is not on its feature list",
				"Disk grows with volume: about 30 GB for a million events a month, per its docs",
			],
		},
		{
			id: "self-hosted-sentry",
			name: "Self-hosted Sentry",
			url: "https://develop.sentry.dev/self-hosted/",
			pickIf: "You want to keep Sentry as it is, stop paying per event, and can run one large server.",
			pricing: "Free software; you pay for the server",
			openSource: "FSL (Apache 2.0 after two years)",
			keyFact: "Yes",
			summary:
				"Sentry's own self-hosted build is, in Sentry's words, the Business plan without software limits and no paid tier. It leaves out billing features, spike protection and closed-source AI features such as Seer. Every service runs on one node, Kafka included. The minimum is 4 CPU cores, 16 GB of RAM plus 16 GB of swap and 20 GB of disk, with 32 GB of RAM recommended. Sentry offers no support or scaling guidance for it.",
			pros: [
				"The same product and SDKs, with no per-event bill",
				"Business plan features without software limits",
			],
			cons: [
				"4 cores and 16 GB of RAM plus swap at minimum; 32 GB recommended",
				"Single node for every service, with no support or scaling guidance",
				"No Seer and no spike protection",
			],
		},
		{
			id: "better-stack",
			name: "Better Stack",
			url: "https://betterstack.com",
			pickIf: "You want to keep the Sentry SDKs, pay less per exception, and get uptime and on-call alongside.",
			pricing: "100,000 exceptions/mo included, then $0.05 per 1,000 (EU) or $0.075 (US)",
			openSource: "Closed source; SaaS, custom VPC on Enterprise",
			keyFact: "Yes",
			summary:
				"Better Stack's error tracking accepts the Sentry SDKs: you keep the code and change where it sends. It includes 100,000 exceptions a month with 90 days of retention, then charges $0.05 per 1,000 in Europe and $0.075 in the US. Errors can be resolved, snoozed and tracked by release, and they sit next to logs, traces, uptime checks and on-call with phone and SMS.",
			pros: [
				"Accepts the Sentry SDKs",
				"100,000 exceptions a month included, with 90 days of retention",
				"Uptime, on-call, logs and traces in the same product",
			],
			cons: ["Closed source, with no self-hosting", "Anyone on call needs a $34/mo Responder license"],
			compareSlug: "better-stack",
		},
		{
			id: "posthog",
			name: "PostHog",
			url: "https://posthog.com/error-tracking",
			pickIf: "You already use PostHog for product analytics, or want each error with the user's session replay.",
			pricing: "First 100,000 exceptions/mo free, then $0.37 per 1,000",
			openSource: "MIT, except the ee directory",
			keyFact: "No; PostHog's SDKs",
			summary:
				"PostHog added error tracking to its product analytics platform. Every issue comes with the affected user's session replay, events and properties. It takes source maps and symbol sets so minified stack traces point back to your code, and it tags exceptions with the release and commit that introduced them. The first 100,000 exceptions a month are free.",
			pros: [
				"Session replay and product events on every issue",
				"100,000 exceptions a month free",
				"Source maps, and release and commit tagging",
			],
			cons: [
				"Its own SDKs, not Sentry's",
				"Self-hosting is a hobby deploy that scales to about 100,000 events a month, without support",
			],
		},
		{
			id: "signoz",
			name: "SigNoz",
			url: "https://signoz.io",
			pickIf: "You are moving to OpenTelemetry and want exceptions next to traces, hosted or self-hosted.",
			pricing: "$49/mo including $49 of usage, then $0.30 per GB of logs and traces",
			openSource: "MIT core, SSO and RBAC under a commercial license",
			keyFact: "No; OpenTelemetry SDKs",
			summary:
				"SigNoz is an OpenTelemetry APM with logs, metrics and alerts. It lists exceptions grouped by service, type and message, each linked to its trace. A group has no state, owner or severity, so triage happens elsewhere. It suits teams whose main goal is tracing, with exceptions as one view among several.",
			pros: [
				"Every exception linked to its trace",
				"Self-hosted under an MIT core",
				"No user-based pricing on Cloud",
			],
			cons: [
				"No state, owner or severity on an exception group",
				"15 days for logs and traces by default",
			],
			compareSlug: "signoz",
		},
	],
	faqs: [
		{
			question: "What is the best Sentry alternative?",
			answer: "It depends on what you want to keep. To keep your Sentry SDKs and pay less, look at Better Stack or GlitchTip. To self-host on a small server, GlitchTip; to self-host Sentry itself, plan for a 16 GB machine. To get errors, traces, logs and replay from OpenTelemetry in one app, Maple. If your product team already lives in PostHog, its error tracking. We build Maple, so weigh our view accordingly.",
		},
		{
			question: "Is there an open-source alternative to Sentry?",
			answer: "Yes. GlitchTip is MIT and accepts the Sentry SDKs. PostHog is MIT except its ee directory. SigNoz has an MIT core with SSO and RBAC under a commercial license. Maple is source-available under FSL-1.1. Sentry itself is under the FSL too, becomes Apache 2.0 after two years, and can be self-hosted for free.",
		},
		{
			question: "Can I keep using the Sentry SDKs?",
			answer: "With GlitchTip, Better Stack and self-hosted Sentry, yes: point the SDK at the new endpoint. Maple and SigNoz take OpenTelemetry, so you swap the Sentry SDK for the OpenTelemetry SDK for your language. PostHog uses its own SDKs.",
		},
		{
			question: "What does self-hosted Sentry need?",
			answer: "At least 4 CPU cores, 16 GB of RAM plus 16 GB of swap, and 20 GB of free disk; Sentry recommends 32 GB of RAM. Every service, Kafka included, runs on one node, and Sentry gives no scaling guidance or support. It excludes spike protection and Seer. GlitchTip, for comparison, recommends 512 MB of RAM.",
		},
		{
			question: "Why does my Sentry bill spike?",
			answer: "Errors are billed per event above the 50,000 included. Pay-as-you-go starts at $0.3625 per 1,000 errors on Team and $1.1125 on Business, so a release that throws in a loop adds up fast. Once the reserved volume and budget are used, Sentry drops new events for the rest of the billing cycle. Our Sentry pricing guide works through two monthly bills.",
		},
	],
	sources: [
		MAPLE_SOURCE,
		...SENTRY_SOURCES,
		...GLITCHTIP_SOURCES,
		...pricingSource("better-stack"),
		...compareSource("better-stack", 2),
		...POSTHOG_SOURCES,
		...pricingSource("signoz"),
		...compareSource("signoz", 4),
	],
}

export const alternativesPages: AlternativesPage[] = [datadog, sentry, grafana, newRelic, dash0]

export const alternativesBySlug = (slug: string) => alternativesPages.find((page) => page.slug === slug)

export const alternativesPath = (slug: string) => `/alternatives/${slug}`
