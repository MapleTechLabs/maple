import { collapsiblePanelStyles } from "@maple/ui/styles/ui/collapsible"
import { apiPublicUrl } from "../../../lib/services/common/api-base-url"
import type { Html, HtmlBuilder } from "foldkit/html"
import { copyableField } from "../../../ui/copyable-field"
import { badge } from "../../../ui/display"
import { icon } from "../../../ui/icon"
import { panel } from "../../../ui/panel"
import { INLINE_LINK_CLASS, settingsSection } from "../kit/section"
import { Message } from "./message"
import type { Model } from "./model"
import { linkButton } from "../../../ui/button"

// `ApiReference` and `OAuthPointer`.

type H = HtmlBuilder<Message>

const SCOPE_FAMILY_ROWS = [
	{ id: "api_keys", label: "API keys", description: "Create, roll, and revoke API keys" },
	{ id: "dashboards", label: "Dashboards", description: "Dashboards, templates, and version history" },
	{
		id: "alerts",
		label: "Alerts",
		description: "Alert rules (incl. test/preview/checks), destinations, and incidents",
	},
	{ id: "ingest_keys", label: "Ingest keys", description: "View and roll telemetry ingest keys" },
	{
		id: "attribute_mappings",
		label: "Attribute mappings",
		description: "Ingest-time attribute rewrite rules",
	},
	{
		id: "scrape_targets",
		label: "Scrape targets",
		description: "Prometheus/PlanetScale scrape targets, probes, and checks",
	},
	{ id: "instrumentation", label: "Recommendations", description: "Instrumentation recommendations" },
	{
		id: "investigations",
		label: "Investigations",
		description: "AI investigation war-rooms: list, open, and update status",
	},
	{
		id: "error_issues",
		label: "Errors",
		description: "Error issues and their events; triage actions need write",
	},
	{
		id: "anomalies",
		label: "Anomalies",
		description: "Anomaly incidents (incl. timeseries/resolve/link-issue) and detector settings",
	},
	{
		id: "session_replays",
		label: "Session replays",
		description: "Search sessions, retrieve detail, events, and transcripts",
	},
	{ id: "traces", label: "Traces", description: "Search traces and retrieve spans" },
	{ id: "logs", label: "Logs", description: "Search and retrieve log records" },
	{ id: "metrics", label: "Metrics", description: "Metric catalog and timeseries reads" },
	{ id: "services", label: "Services", description: "Service catalog and health summaries" },
	{ id: "service_map", label: "Service map", description: "Service-to-service topology" },
	{ id: "sources", label: "Sources", description: "Ingest sources and their settings" },
	{
		id: "integrations",
		label: "Integrations",
		description: "Connected integrations, including source code repositories",
	},
	{ id: "query", label: "Query", description: "Structured telemetry queries" },
	{ id: "organization", label: "Organization", description: "Read the organization's identity" },
	{ id: "audit_log", label: "Audit log", description: "Read the audit log (org admins only)" },
] as const

const scopeRow = (h: H, family: (typeof SCOPE_FAMILY_ROWS)[number]): Html =>
	h.div(
		[
			h.Key(family.id),
			h.Class("flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-4 py-2.5"),
		],
		[
			h.div(
				[h.Class("min-w-0 flex-1 space-y-0.5")],
				[
					h.div([h.Class("text-sm")], [family.label]),
					h.div([h.Class("text-muted-foreground text-xs")], [family.description]),
				],
			),
			h.div(
				[h.Class("flex shrink-0 items-center gap-1.5")],
				[
					badge(h, { variant: "outline", mono: true, className: "text-2xs" }, [family.id, ":read"]),
					badge(h, { variant: "outline", mono: true, className: "text-2xs" }, [
						family.id,
						":write",
					]),
				],
			),
		],
	)

const scopes = (h: H, isOpen: boolean): Html =>
	h.div(
		[h.DataAttribute(isOpen ? "open" : "closed", ""), h.DataAttribute("slot", "collapsible")],
		[
			h.button(
				[
					...(isOpen ? [h.AriaControls("keys-scopes-panel")] : []),
					h.AriaDisabled(false),
					h.AriaExpanded(isOpen),
					h.Class(
						"group/scopes hover:bg-muted/50 flex w-full items-center gap-2 px-4 py-3 text-left",
					),
					...(isOpen ? [h.DataAttribute("panel-open", "")] : []),
					h.DataAttribute("slot", "collapsible-trigger"),
					h.Tabindex(0),
					h.Type("button"),
					h.OnClick(Message.ToggledScopes()),
				],
				[
					icon(h, "ChevronRightIcon", {
						size: 14,
						className:
							"text-muted-foreground shrink-0 transition-transform group-data-[panel-open]/scopes:rotate-90",
					}),
					h.span([h.Class("text-sm font-medium")], ["Scopes"]),
					h.span(
						[h.Class("text-muted-foreground text-sm")],
						[String(SCOPE_FAMILY_ROWS.length), " resource families"],
					),
					h.span([h.Class("flex-1")], []),
					h.span(
						[h.Class("text-muted-foreground hidden text-2xs md:block")],
						["Read or write per family. A key without scopes has full access."],
					),
				],
			),
			...(isOpen
				? [
						h.div(
							[
								h.Class(collapsiblePanelStyles),
								h.DataAttribute("open", ""),
								h.DataAttribute("slot", "collapsible-panel"),
								h.Id("keys-scopes-panel"),
								h.Style({
									"--collapsible-panel-height": "auto",
									"--collapsible-panel-width": "auto",
									"animation-name": "none",
								}),
							],
							[
								h.div(
									[h.Class("divide-y border-t")],
									SCOPE_FAMILY_ROWS.map((family) => scopeRow(h, family)),
								),
							],
						),
					]
				: []),
		],
	)

export const apiReference = (h: H, model: Model): Html =>
	settingsSection(
		h,
		{
			id: "keys-reference-heading",
			title: "API reference",
			description: [
				"A REST interface with snake_case JSON, cursor-paginated lists and scoped API keys.",
			],
			framed: false,
			actions: linkButton(
				h,
				{
					size: "sm",
					variant: "outline",
					href: `${apiPublicUrl}/v2/docs`,
					attributes: [h.Target("_blank"), h.Rel("noopener noreferrer")],
				},
				[
					icon(h, "CodeIcon", { attributes: [h.DataAttribute("icon", "inline-start")] }),
					"Open API reference",
				],
			),
		},
		[
			panel(h, { className: "divide-y" }, [
				h.div(
					[h.Class("flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3")],
					[
						h.span(
							[h.Class("w-20 shrink-0 font-prose text-xs text-muted-foreground")],
							["Base URL"],
						),
						h.div(
							[h.Class("min-w-0 flex-1")],
							[
								copyableField(h, {
									id: "keys-base-url",
									value: `${apiPublicUrl}/v2`,
									copyLabel: "Base URL",
									copy: model.baseUrlCopy,
									toCopyMessage: (message) => Message.GotBaseUrlCopyMessage({ message }),
								}),
							],
						),
					],
				),
				scopes(h, model.isScopesOpen),
			]),
		],
	)

export const oauthPointer = (h: H): Html =>
	h.p(
		[
			h.Class(
				"w-full rounded-md border border-dashed px-4 py-3 font-prose text-sm text-muted-foreground",
			),
		],
		[
			"Clients signed in with OAuth don't use keys. See and revoke them in the ",
			h.a(
				[h.Href("/settings?tab=mcp"), h.Class(INLINE_LINK_CLASS)],
				["Connected clients section of MCP"],
			),
			".",
		],
	)
