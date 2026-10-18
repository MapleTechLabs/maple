import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { eyebrow } from "../../ui/eyebrow"
import { icon, type IconName } from "../../ui/icon"

// `SettingsNav` over `SettingsNavShell` (apps/web/src/components/settings/settings-nav*.tsx), as the
// /integrations hub renders it: the self-hosted sections, "Integrations" the active link.
// TODO(clerk): the Clerk-mode rows (General, Members, Billing) and their admin / add-on gates.

type Row =
	| Readonly<{ _tag: "Tab"; id: string; label: string; icon: IconName }>
	| Readonly<{ _tag: "Link"; id: string; label: string; icon: IconName; href: string }>

const tab = (id: string, label: string, iconName: IconName): Row => ({
	_tag: "Tab",
	id,
	label,
	icon: iconName,
})

const SECTIONS: ReadonlyArray<Readonly<{ id: string; title: string; items: ReadonlyArray<Row> }>> = [
	{ id: "workspace", title: "Workspace", items: [tab("audit-log", "Audit log", "HistoryIcon")] },
	{
		id: "access",
		title: "Access",
		items: [
			{
				_tag: "Link",
				id: "integrations",
				label: "Integrations",
				icon: "GridIcon",
				href: "/integrations",
			},
			tab("keys", "Keys", "KeyIcon"),
			tab("mcp", "MCP", "SquareTerminalIcon"),
			tab("ai", "AI", "ChatBubbleSparkleIcon"),
		],
	},
	{
		id: "data",
		title: "Data",
		items: [
			tab("ingestion", "Ingestion", "ServerIcon"),
			tab("data-platform", "Data platform", "DatabaseIcon"),
			tab("setup-health", "Setup health", "CircleCheckIcon"),
		],
	},
	{ id: "alerting", title: "Alerting", items: [tab("automation", "Automation", "ShieldIcon")] },
]

const rowClass = (isActive: boolean) =>
	cn(
		"group relative flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors text-left",
		isActive
			? "bg-accent text-accent-foreground font-medium"
			: "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
	)

const activeIndicator = <M>(h: HtmlBuilder<M>): Html =>
	h.span([h.AriaHidden(true), h.Class("absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-primary")])

export const settingsNav = <M>(h: HtmlBuilder<M>, onSelectTab: (tab: string) => M): Html =>
	h.nav(
		[h.Class("flex flex-col gap-5")],
		SECTIONS.map((section) =>
			h.div(
				[h.Class("flex flex-col gap-1")],
				[
					eyebrow(h, { className: "px-2.5", as: "div" }, [section.title]),
					h.div(
						[h.Class("flex flex-col gap-0.5")],
						section.items.map((row) => {
							const isActive = row.id === "integrations"
							const children = [
								...(isActive ? [activeIndicator(h)] : []),
								icon(h, row.icon, { size: 16, className: "shrink-0" }),
								row.label,
							]
							return row._tag === "Link"
								? h.a(
										[
											...(isActive ? [h.AriaCurrent("page")] : []),
											h.Class(
												isActive
													? `${rowClass(isActive)} active`
													: rowClass(isActive),
											),
											...(isActive ? [h.DataAttribute("status", "active")] : []),
											h.Href(row.href),
										],
										children,
									)
								: h.button(
										[
											h.Class(rowClass(isActive)),
											h.Type("button"),
											h.OnClick(onSelectTab(row.id)),
										],
										children,
									)
						}),
					),
				],
			),
		),
	)
