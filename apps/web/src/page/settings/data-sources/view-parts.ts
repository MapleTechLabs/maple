import type { DataSourceEnvironment, DataSourceKind, DataSourceStatus } from "@maple/domain/data-sources"
import type { V2DataSource } from "@maple/domain/http/v2"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "@maple/views/ui/display"
import { icon, type IconName } from "@maple/views/ui/icon"
import { hstack } from "@maple/views/ui/stack"
import { statusDot } from "@maple/views/ui/status-dot"
import { typography } from "@maple/views/ui/typography"
import { DATA_SOURCE_KIND_ENTRY } from "../../kit/providers"

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
export const agentAccessShort = (source: V2DataSource): string =>
	!source.agent_access
		? "Hidden from agents"
		: source.agent_pii
			? "Agents: full data"
			: "Agents: PII redacted"

export const agentAccessLabel = (source: V2DataSource): string =>
	!source.agent_access
		? "Hidden from agents"
		: source.agent_pii
			? "Agents can query, including personal data"
			: "Agents can query, personal data redacted"
