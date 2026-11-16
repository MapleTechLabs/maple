/**
 * The content of each feature page's extra sections, and its markdown form.
 *
 * The `.md` twins used to stop at the capability list, so an agent reading
 * `/features/kubernetes-monitoring.md` never saw the Helm install the HTML page
 * shows. Snippets live here so the section component and the twin print the same
 * commands. Messages are called inside functions only (`page-registry.ts` rule 1);
 * no `.astro` imports, since the registry that reads `SectionId` ships to the nav island.
 */
import * as m from "../paraglide/messages.js"
import { Array as Arr } from "effect"
import { absolute, blocks } from "./page-markdown"
import type { SectionId } from "./page-registry"

export const K8S_INSTALL_STEPS = [
	{
		caption: m.page_k8s_install_step_1,
		code: "kubectl create namespace maple\nkubectl -n maple create secret generic maple-ingest-key \\\n  --from-literal=ingest-key=$MAPLE_INGEST_KEY",
	},
	{
		caption: m.page_k8s_install_step_2,
		code: "helm upgrade --install maple-k8s-infra \\\n  oci://ghcr.io/mapletechlabs/charts/maple-k8s-infra \\\n  --namespace maple \\\n  --set maple.ingestKey.existingSecret.name=maple-ingest-key \\\n  --set maple.ingestKey.existingSecret.key=ingest-key \\\n  --set global.clusterName=production",
	},
	{
		caption: m.page_k8s_install_step_3,
		code: "kubectl -n maple rollout status daemonset/maple-k8s-infra-agent",
	},
]

/** One uptime check written three ways; the code is runnable, so never translated. */
export const UPTIME_SETUP_WAYS = [
	{
		label: m.uptime_setup_way_agent,
		lang: "text",
		code: `> Add an uptime check for https://api.example.com/health,
  every minute, linked to the checkout service.

create_uptime_monitor({
  kind: "http",
  name: "checkout-api",
  url: "https://api.example.com/health",
  interval_seconds: 60,
  service: "checkout",
})`,
	},
	{
		label: m.uptime_setup_way_terraform,
		lang: "hcl",
		code: `resource "maple_uptime_monitor" "checkout_api" {
  name             = "checkout-api"
  interval_seconds = 60
  service_name     = "checkout"
  config = jsonencode({
    type = "http"
    url  = "https://api.example.com/health"
  })
}`,
	},
	{
		label: m.uptime_setup_way_api,
		lang: "bash",
		code: `curl https://api.maple.dev/v2/uptime_monitors \\
  -H "Authorization: Bearer $MAPLE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"name": "checkout-api", "kind": "http",
       "config": {"type": "http", "url": "https://api.example.com/health"},
       "interval_seconds": 60, "service_name": "checkout"}'`,
	},
]

/** Copied from `/docs/product-events/*` and must stay runnable, so never translated. */
export const PRODUCT_EVENT_SOURCES = [
	{
		label: "browser",
		title: m.pe_src_browser_title,
		body: m.pe_src_browser_body,
		file: "checkout.tsx",
		lang: "ts",
		code: 'MapleBrowser.track("checkout_completed", {\n  plan: "pro",\n  seats: 12,\n})',
		href: "/docs/session-replay/browser-sdk#custom-events",
	},
	{
		label: "span",
		title: m.pe_src_span_title,
		body: m.pe_src_span_body,
		file: "billing.ts",
		lang: "ts",
		code: 'span.setAttributes({\n  "maple.product_event.name": "plan_started",\n  "maple.product_event.user_id": user.id,\n})',
		href: "/docs/product-events/from-traces",
	},
	{
		label: "server",
		title: m.pe_src_server_title,
		body: m.pe_src_server_body,
		file: "terminal",
		lang: "bash",
		code: 'curl https://ingest.maple.dev/v1/events \\\n  -H "Authorization: Bearer $INGEST_KEY" \\\n  -H "Content-Type: application/x-ndjson" \\\n  -d \'{"name":"plan_started","user_id":"u_123"}\'',
		href: "/docs/product-events/api",
	},
] as const

export const STATUS_PAGE_ENDPOINTS = [
	{ path: "/feed.rss", what: "RSS" },
	{ path: "/feed.atom", what: "Atom" },
	{ path: "/badge.svg", what: "badge" },
]

type Rule = { title: () => string; body: () => string }

const fence = (lang: string, code: string) => `\`\`\`${lang}\n${code}\n\`\`\``

const section = (title: string, lede: string, ...rest: string[]) => blocks(`## ${title}`, lede, ...rest)

const rules = (items: Rule[]) => Arr.map(items, (rule) => `### ${rule.title()}\n\n${rule.body()}`)

const views = () =>
	Arr.join(
		Arr.map(
			[
				[
					m.page_k8s_views_workloads_caption,
					m.page_k8s_views_workloads_route,
					m.page_k8s_views_workloads_lede,
				],
				[m.page_k8s_views_pods_caption, m.page_k8s_views_pods_route, m.page_k8s_views_pods_lede],
				[m.page_k8s_views_nodes_caption, m.page_k8s_views_nodes_route, m.page_k8s_views_nodes_lede],
			] as const,
			([caption, route, lede]) => `- **${caption()}** (\`${route()}\`): ${lede()}`,
		),
		"\n",
	)

export const sectionMarkdown = (id: SectionId, site: URL | undefined): string => {
	switch (id) {
		case "k8s-console":
			return section(m.page_k8s_console_title(), m.page_k8s_console_lede())
		case "k8s-views":
			return section(m.page_k8s_views_title(), m.page_k8s_views_lede(), views())
		case "k8s-correlation":
			return section(m.page_k8s_correlation_title(), m.page_k8s_correlation_lede())
		case "k8s-install":
			return section(
				m.page_k8s_install_title(),
				m.page_k8s_install_lede(),
				...Arr.map(
					K8S_INSTALL_STEPS,
					(step, i) => `${i + 1}. ${step.caption()}\n\n${fence("bash", step.code)}`,
				),
			)
		case "product-events-sources":
			return section(
				m.pe_src_title(),
				m.pe_src_lede(),
				...Arr.map(PRODUCT_EVENT_SOURCES, (source) =>
					blocks(
						`### ${source.label}: ${source.title()}`,
						source.body(),
						fence(source.lang, source.code),
						`[${m.pe_src_docs_link()}](${absolute(site, source.href)})`,
					),
				),
			)
		case "github-ci":
			return section(m.gh_ci_title(), m.gh_ci_lede())
		case "github-after-merge":
			return section(
				m.gh_after_title(),
				m.gh_after_lede(),
				...rules([
					{ title: m.gh_after_rule_1_title, body: m.gh_after_rule_1_body },
					{ title: m.gh_after_rule_2_title, body: m.gh_after_rule_2_body },
					{ title: m.gh_after_rule_3_title, body: m.gh_after_rule_3_body },
				]),
			)
		case "uptime-check-trace":
			return section(
				m.uptime_trace_title(),
				m.uptime_trace_lede(),
				...rules([
					{ title: m.uptime_trace_rule_1_title, body: m.uptime_trace_rule_1_body },
					{ title: m.uptime_trace_rule_2_title, body: m.uptime_trace_rule_2_body },
					{ title: m.uptime_trace_rule_3_title, body: m.uptime_trace_rule_3_body },
				]),
			)
		case "uptime-setup":
			return section(
				m.uptime_setup_title(),
				m.uptime_setup_lede(),
				...Arr.map(UPTIME_SETUP_WAYS, (way) => `### ${way.label()}\n\n${fence(way.lang, way.code)}`),
				...rules([
					{ title: m.uptime_setup_fact_1_title, body: m.uptime_setup_fact_1_body },
					{ title: m.uptime_setup_fact_2_title, body: m.uptime_setup_fact_2_body },
					{ title: m.uptime_setup_fact_3_title, body: m.uptime_setup_fact_3_body },
				]),
				Arr.join(
					[
						`- [${m.uptime_setup_link_checks()}](${absolute(site, "/docs/alerting/uptime-checks")})`,
						`- [${m.uptime_setup_link_heartbeats()}](${absolute(site, "/docs/alerting/heartbeat-monitors")})`,
					],
					"\n",
				),
			)
		case "status-page-feeds":
			return section(
				m.status_feeds_title(),
				m.status_feeds_lede(),
				Arr.join(
					[
						"- `GET /api/v1/status.json`: statuspage.io summary format",
						...Arr.map(STATUS_PAGE_ENDPOINTS, (e) => `- \`GET ${e.path}\`: ${e.what}`),
					],
					"\n",
				),
				...rules([
					{ title: m.status_feeds_rule_1_title, body: m.status_feeds_rule_1_body },
					{ title: m.status_feeds_rule_2_title, body: m.status_feeds_rule_2_body },
					{ title: m.status_feeds_rule_3_title, body: m.status_feeds_rule_3_body },
				]),
			)
	}
}
