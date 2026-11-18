import type { DataSourceEnvironment, DataSourceKind, DataSourceStatus } from "@maple/domain/data-sources"
import type { V2DataSource } from "@maple/domain/http/v2"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "@maple/views/ui/display"
import { icon, type IconName } from "@maple/views/ui/icon"
import { hstack } from "@maple/views/ui/stack"
import { statusDot } from "@maple/views/ui/status-dot"
import { typography } from "@maple/views/ui/typography"
import { DATA_SOURCE_KIND_ENTRY } from "../../kit/providers"
import { gatedBy } from "../../kit/gated-controls"

// Small pieces the list, the form and the detail share.

export type Inputs = Readonly<{ canManage: boolean; nowMs: number; timeZone: string }>

/** The kind's name, from the provider registry. */
export const kindLabel = (kind: DataSourceKind): string => DATA_SOURCE_KIND_ENTRY[kind].name

export const kindIcon = (kind: DataSourceKind): IconName => DATA_SOURCE_KIND_ENTRY[kind].icon

export const ENVIRONMENT_LABEL = {
	production: "Production",
	staging: "Staging",
	development: "Development",
	other: "Other",
} as const satisfies Record<DataSourceEnvironment, string>

const STATUS = {
	ok: { tone: "ok", label: "Connected" },
	error: { tone: "crit", label: "Connection error" },
	unknown: { tone: "neutral", label: "Not checked" },
} as const satisfies Record<
	DataSourceStatus,
	{ readonly tone: "ok" | "crit" | "neutral"; readonly label: string }
>

/** The kind's logo in a small tile: a row's leading media, labelled for screen readers. */
export const kindLogo = <M>(h: HtmlBuilder<M>, kind: DataSourceKind): Html =>
	hstack(
		h,
		{
			as: "span",
			justify: "center",
			className: "size-9 shrink-0 rounded-md border border-border-subtle bg-surface-sunken",
			attributes: [h.Role("img"), h.AriaLabel(kindLabel(kind))],
		},
		[icon(h, kindIcon(kind), { size: 18 })],
	)

export const kindBadge = <M>(h: HtmlBuilder<M>, kind: DataSourceKind): Html =>
	badge(h, { variant: "meta", size: "sm" }, [icon(h, kindIcon(kind)), kindLabel(kind)])

export const environmentBadge = <M>(h: HtmlBuilder<M>, environment: DataSourceEnvironment): Html =>
	badge(h, { variant: environment === "production" ? "info" : "muted", size: "sm" }, [
		ENVIRONMENT_LABEL[environment],
	])

export const statusLine = <M>(h: HtmlBuilder<M>, source: V2DataSource): Html =>
	hstack(h, { gap: "1.5", align: "center" }, [
		statusDot(h, { tone: STATUS[source.status].tone }),
		typography(h, { size: "xs", tone: source.status === "error" ? "error" : "muted" }, [
			STATUS[source.status].label,
		]),
	])

/** The list's short form of `agentAccessLabel`. */
export const agentAccessShort = (source: V2DataSource): string => {
	if (!source.agent_access) return "Hidden from agents"
	// Nothing marks personal data on this kind, so the PII switch withholds nothing: say so.
	if (!source.supports_pii_redaction) return "Agents: every column"
	return source.agent_pii ? "Agents: full data" : "Agents: PII redacted"
}

export const agentAccessLabel = (source: V2DataSource): string => {
	if (!source.agent_access) return "Hidden from agents"
	if (!source.supports_pii_redaction) return "Agents can read every column of the tables shown to them"
	return source.agent_pii
		? "Agents can query, including personal data"
		: "Agents can query, personal data redacted"
}

/** The limit of hiding a table on a SQL source, said wherever hiding is offered. */
export const HIDING_IS_BY_NAME =
	"Hiding keeps agents from querying a table by name. For a hard boundary, connect a database account that cannot read it."

/** What the agent switch says on a kind that marks no personal data: there is no finer switch. */
export const AGENTS_READ_EVERY_COLUMN = `Off hides it from the MCP tools and investigations. On, agents can read every column of the tables they can see: this kind of source does not mark personal data. ${HIDING_IS_BY_NAME}`

/** `control(false)` for a viewer who may manage data sources, else `control(true)` locked with the reason. */
export const gatedSourceControl = <M>(
	h: HtmlBuilder<M>,
	canManage: boolean,
	control: (isLocked: boolean) => Html,
): Html => gatedBy(h, canManage, "data_sources:manage", control)
