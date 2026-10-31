import { auditActionLabel, auditResourceLabel } from "@maple/domain/audit-actions"
import { encodePublicId, PublicIdPrefixes, type V2AuditChanges, type V2AuditLogEntry } from "@maple/domain/http/v2"
import { EMPTY_VALUE } from "@maple/ui/lib/format"
import type { AuditResourceLink } from "../../../components/settings/audit-log-resource"
import { formatTimestampInTimezone } from "@maple/web-data/lib/timezone-format"
import { Option, Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import * as CopyButton from "../../../ui/copy-button"
import { badge } from "../../../ui/display"
import { eyebrow } from "../../../ui/eyebrow"
import { inlineCode } from "../../../ui/inline-code"
import { keyValue, keyValueList } from "../../../ui/key-value"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import { Message, type Model } from "./model"
import { ACTOR_BADGES, SOURCE_LABELS } from "./view"

// `AuditLogDetail` and its parts.

type H = HtmlBuilder<Message>

/** `<Link {...display.link}>` as an href. */
export const resourceHref = (link: AuditResourceLink): string => {
	switch (link.to) {
		case "/alerts/$ruleId":
			return `/alerts/${encodeURIComponent(link.params.ruleId)}`
		case "/dashboards/$dashboardId":
			return `/dashboards/${encodeURIComponent(link.params.dashboardId)}`
		case "/errors/issues/$issueId":
			return `/errors/issues/${encodeURIComponent(link.params.issueId)}`
		case "/investigations/$id":
			return `/investigations/${encodeURIComponent(link.params.id)}`
		case "/anomalies/$incidentId":
			return `/anomalies/${encodeURIComponent(link.params.incidentId)}`
		case "/alerts":
			return hrefOf(AppRoute.Alerts({ search: link.search }))
		case "/integrations":
			return hrefOf(AppRoute.Integrations({ search: link.search }))
		case "/settings":
			return `/settings?tab=${link.search.tab}`
	}
}

const isPlaceholder = (value: unknown): value is string => typeof value === "string" && /^<[a-z]+>$/.test(value)
const formatScalar = (value: unknown): string => (typeof value === "string" ? value : (JSON.stringify(value) ?? "undefined"))

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/** Structured or long metadata renders as a block (`metadataBlock`). */
const metadataBlock = (value: unknown): string | null => {
	if (typeof value === "string") {
		const trimmed = value.trim()
		const parsed =
			trimmed.startsWith("{") || trimmed.startsWith("[") ? Option.getOrNull(parseJson(trimmed)) : null
		if (parsed !== null && typeof parsed === "object") return JSON.stringify(parsed, null, 2)
		return value.length > 72 || value.includes("\n") ? value : null
	}
	if (value !== null && typeof value === "object") return JSON.stringify(value, null, 2)
	return null
}

const changeValue = (h: H, value: unknown): Html => {
	if (isPlaceholder(value)) return h.span([h.Class("text-foreground-subtle italic")], [value.slice(1, -1)])
	if (value === undefined || value === null || value === "") return h.span([h.Class("text-foreground-subtle")], [EMPTY_VALUE])
	return h.span([h.Class("break-all")], [formatScalar(value)])
}

const identifier = (h: H, model: Model, value: string, label: string): Html => {
	const key = `${label}:${value}`
	return h.span(
		[h.Class("inline-flex max-w-full items-center gap-0.5")],
		[
			inlineCode(h, { variant: "plain", className: "truncate text-2xs text-foreground" }, [value]),
			CopyButton.view(h, {
				model: model.copies[key] ?? CopyButton.init(),
				toParentMessage: (message) => Message.GotCopyMessage({ key, message }),
				value,
				label,
				iconSize: 12,
				className: "size-5",
			}),
		],
	)
}

const changesTable = (h: H, changes: V2AuditChanges): Html =>
	table(h, { size: "sm", className: "font-mono" }, [
		tableHeader(h, [
			tableRow(h, [
				tableHead(h, ["Field"], "w-40 font-normal"),
				tableHead(h, ["Before"], "font-normal"),
				tableHead(h, ["After"], "font-normal"),
			]),
		]),
		tableBody(
			h,
			changes.fields.map((field) =>
				tableRow(
					h,
					[
						tableCell(h, [field], "text-muted-foreground align-top"),
						tableCell(h, [changeValue(h, changes.before[field])], "align-top whitespace-normal"),
						tableCell(h, [changeValue(h, changes.after[field])], "align-top whitespace-normal"),
					],
					undefined,
					[h.Key(field)],
				),
			),
		),
	])

const metadataList = (h: H, metadata: Readonly<Record<string, unknown>>): ReadonlyArray<Html> => {
	const keys = Object.keys(metadata)
	if (keys.length === 0) return []
	return [
		keyValueList(
			h,
			{ layout: "grid" },
			keys.map((key) => {
				const block = metadataBlock(metadata[key])
				return keyValue(h, { wrap: true, label: key }, [
					block !== null
						? h.pre(
								[
									h.Class(
										"bg-background/60 max-h-64 overflow-auto rounded-md border px-2.5 py-2 font-mono text-2xs leading-relaxed whitespace-pre-wrap break-all",
									),
								],
								[block],
							)
						: h.span([h.Class("font-mono text-2xs break-all")], [changeValue(h, metadata[key])]),
				])
			}),
		),
	]
}

export const auditDetail = (h: H, model: Model, entry: V2AuditLogEntry, timeZone: string): Html => {
	const actor = ACTOR_BADGES[entry.actor_type]
	const formatFull = (value: string) => formatTimestampInTimezone(value, { timeZone, withYear: true })
	const actionText = auditActionLabel(entry.action)
	const changes = entry.changes
	const metadata = entry.metadata
	return h.div(
		[h.Class("border-border-subtle space-y-4 border-t px-4 py-3 @md:pl-[44px]")],
		[
			keyValueList(
				h,
				{
					layout: "grid",
					className:
						"@2xl:grid-cols-[minmax(6rem,max-content)_minmax(0,1fr)_minmax(6rem,max-content)_minmax(0,1fr)] @2xl:gap-x-6",
				},
				[
					keyValue(h, { wrap: true, label: "Occurred" }, [h.span([h.Class("tabular-nums")], [formatFull(entry.occurred_at)])]),
					keyValue(h, { wrap: true, label: "Recorded" }, [h.span([h.Class("tabular-nums")], [formatFull(entry.recorded_at)])]),
					keyValue(h, { wrap: true, label: "Actor" }, [
						h.span(
							[h.Class("flex min-w-0 flex-wrap items-center gap-1.5")],
							[
								badge(h, { variant: actor.variant, size: "sm" }, [actor.label]),
								...(entry.actor_name === null ? [] : [h.span([], [entry.actor_name])]),
								...(entry.actor_id === null ? [] : [identifier(h, model, entry.actor_id, "Actor id")]),
							],
						),
					]),
					keyValue(h, { wrap: true, label: "Source" }, [
						h.span([], [SOURCE_LABELS[entry.source]]),
						...(entry.origin_ip === null && entry.origin_country === null
							? []
							: [
									h.span(
										[h.Class("text-muted-foreground")],
										[
											" · ",
											entry.origin_ip ?? "unknown IP",
											...(entry.origin_country === null ? [] : [` (${entry.origin_country})`]),
										],
									),
								]),
					]),
					keyValue(h, { wrap: true, label: "Action" }, [
						h.span(
							[h.Class("flex flex-wrap items-center gap-1.5")],
							[
								...(actionText === null ? [] : [h.span([], [actionText])]),
								inlineCode(h, { variant: "plain", className: "text-2xs text-foreground" }, [entry.action]),
								entry.outcome === "denied"
									? badge(h, { variant: "crit", size: "sm" }, ["Denied"])
									: badge(h, { variant: "ok", size: "sm" }, ["Allowed"]),
							],
						),
						...(entry.denial_reason === null ? [] : [h.p([h.Class("text-muted-foreground mt-0.5")], [entry.denial_reason])]),
					]),
					keyValue(h, { wrap: true, label: "Resource" }, [
						entry.resource_type === null && entry.resource_id === null
							? h.span([h.Class("text-foreground-subtle")], [EMPTY_VALUE])
							: h.span(
									[h.Class("flex min-w-0 flex-wrap items-center gap-1.5")],
									[
										...(entry.resource_type === null
											? []
											: [h.span([], [auditResourceLabel(entry.resource_type) ?? entry.resource_type])]),
										...(entry.resource_id === null ? [] : [identifier(h, model, entry.resource_id, "Resource id")]),
									],
								),
					]),
					...(entry.affected_user === null
						? []
						: [keyValue(h, { wrap: true, label: "Affected user" }, [identifier(h, model, entry.affected_user, "Affected user id")])]),
					...(entry.request_id === null
						? []
						: [keyValue(h, { wrap: true, label: "Request" }, [identifier(h, model, entry.request_id, "Request id")])]),
					keyValue(h, { wrap: true, label: "Entry" }, [
						identifier(h, model, encodePublicId(PublicIdPrefixes.auditLogEntry, entry.id), "Entry id"),
					]),
				],
			),
			...(changes !== null && changes.fields.length > 0
				? [h.section([h.Class("space-y-1.5")], [eyebrow(h, { variant: "mono", as: "h4" }, ["Changes"]), changesTable(h, changes)])]
				: []),
			...(metadata !== null && Object.keys(metadata).length > 0
				? [h.section([h.Class("space-y-1.5")], [eyebrow(h, { variant: "mono", as: "h4" }, ["Details"]), ...metadataList(h, metadata)])]
				: []),
		],
	)
}
