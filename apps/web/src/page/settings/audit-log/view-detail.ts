import { auditActionLabel, auditResourceLabel } from "@maple/domain/audit-actions"
import {
	encodePublicId,
	PublicIdPrefixes,
	type V2AuditChanges,
	type V2AuditLogEntry,
} from "@maple/domain/http/v2"
import { EMPTY_VALUE } from "@maple/ui/lib/format"
import type { AuditResourceLink } from "../../../components/settings/audit-log-resource"
import { DateTime, Option, Schema, Array as Arr, Record as Rec, String as Str } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import * as CopyButton from "@maple/views/ui/copy-button"
import { badge } from "@maple/views/ui/display"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { inlineCode } from "@maple/views/ui/inline-code"
import { keyValue, keyValueList } from "@maple/views/ui/key-value"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "@maple/views/ui/table"
import { Message, type Model } from "./model"
import { OUTCOME_ICONS, SOURCE_ICONS } from "./icons"
import { actorBadge, deniedBadge, SOURCE_LABELS } from "./view"
import { icon } from "@maple/views/ui/icon"
import { typography } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"
import { timestamp } from "@maple/views/ui/timestamp"
import { textLink } from "@maple/views/ui/text-link"
import { attributeFilterAction } from "@maple/views/ui/attributes/attribute-row"

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

const encodeJsonOption = Schema.encodeOption(Schema.fromJsonString(Schema.Unknown))

const isPlaceholder = (value: unknown): value is string =>
	typeof value === "string" && /^<[a-z]+>$/.test(value)
const formatScalar = (value: unknown): string =>
	typeof value === "string" ? value : Option.getOrElse(encodeJsonOption(value), () => "undefined")

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const encodePrettyJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }))

/** Structured or long metadata renders as a block (`metadataBlock`). */
const metadataBlock = (value: unknown): string | null => {
	if (typeof value === "string") {
		const trimmed = Str.trim(value)
		const parsed =
			Str.startsWith("{")(trimmed) || Str.startsWith("[")(trimmed)
				? Option.getOrNull(parseJson(trimmed))
				: null
		if (parsed !== null && typeof parsed === "object") return encodePrettyJson(parsed)
		return value.length > 72 || Str.includes("\n")(value) ? value : null
	}
	if (value !== null && typeof value === "object") return encodePrettyJson(value)
	return null
}

const changeValue = (h: H, value: unknown): Html => {
	if (isPlaceholder(value))
		return typography(h, { tone: "subtle", className: "italic" }, [Str.slice(1, -1)(value)])
	if (value === undefined || value === null || value === "")
		return typography(h, { tone: "subtle" }, [EMPTY_VALUE])
	return h.span([h.Class("break-all")], [formatScalar(value)])
}

const identifier = (h: H, model: Model, value: string, label: string): Html => {
	const key = `${label}:${value}`
	return hstack(h, { gap: "0.5", align: "center", inline: true, as: "span", className: "max-w-full" }, [
		inlineCode(h, { variant: "plain", size: "2xs", tone: "foreground", className: "truncate" }, [value]),
		CopyButton.view(h, {
			model: model.copies[key] ?? CopyButton.init(),
			toParentMessage: (message) => Message.GotCopyMessage({ key, message }),
			value,
			label,
			iconSize: 12,
			className: "size-5",
		}),
	])
}

const changesTable = (h: H, changes: V2AuditChanges): Html =>
	table(h, { size: "sm", className: "font-mono" }, [
		tableHeader(h, [
			tableRow(h, [tableHead(h, ["Field"], "w-40"), tableHead(h, ["Before"]), tableHead(h, ["After"])]),
		]),
		tableBody(
			h,
			Arr.map(changes.fields, (field) =>
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
	const keys = Rec.keys(metadata)
	if (keys.length === 0) return []
	return [
		keyValueList(
			h,
			{ layout: "grid" },
			Arr.map(keys, (key) => {
				const block = metadataBlock(metadata[key])
				return keyValue(h, { wrap: true, label: metadataLabel(key) }, [
					block !== null
						? h.pre(
								[
									h.Class(
										"bg-surface-well max-h-64 overflow-auto rounded-md border px-2.5 py-2 font-mono text-2xs leading-relaxed whitespace-pre-wrap break-all",
									),
								],
								[block],
							)
						: typography(h, { size: "2xs", mono: true, className: "break-all" }, [
								changeValue(h, metadata[key]),
							]),
				])
			}),
		),
	]
}

/** A member's name for a `user_…` id, from the org's memberships; null for anyone else. */
export const memberName = (model: Model, userId: string | null): string | null =>
	userId === null
		? null
		: Option.getOrNull(
				Option.map(
					Arr.findFirst(model.members, (member) => member.value === userId),
					(member) => member.label,
				),
			)

/** "Filter" beside a value: lists every entry with that value instead. */
const pivot = (h: H, key: string, value: string, what: string): Html =>
	attributeFilterAction(h, {
		label: `Show every entry with this ${what}`,
		text: "Filter",
		icon: "FilterIcon",
		onClick: Message.ClickedPivot({ key, value }),
	})

const regionNames = new Intl.DisplayNames(["en"], { type: "region" })

/** `DE` -> "🇩🇪 Germany (DE)"; an unknown code reads as itself. */
const countryText = (code: string): string => {
	const upper = Str.toUpperCase(code)
	if (!/^[A-Z]{2}$/.test(upper)) return code
	const flag = String.fromCodePoint(
		...Arr.map(
			Str.split("")(upper),
			(char) => 0x1f1e6 + Option.getOrElse(Str.charCodeAt(0)(char), () => 65) - 65,
		),
	)
	const name = regionNames.of(upper)
	return name === undefined || name === upper ? `${flag} ${upper}` : `${flag} ${name} (${upper})`
}

/** Labels for the metadata keys the backend writes; anything else is its key, made readable. */
const METADATA_LABELS = {
	endpoint: "Endpoint",
	method: "Method",
	path: "Path",
	status: "HTTP status",
	body: "Request body",
	tool: "Tool",
	surface: "Surface",
	is_error: "Failed",
	params: "Parameters",
	sql: "SQL",
	context: "Ran from",
	start_time: "Window start",
	end_time: "Window end",
	row_count: "Rows returned",
	error: "Error",
	connector: "Chat connector",
	workspace_id: "Chat workspace",
	external_user_id: "Chat user ID",
	display_name: "Chat user",
	name: "Name",
	scopes: "Scopes",
	key: "Key",
	platform: "Platform",
} satisfies Readonly<Record<string, string>>

const isLabelledKey = (key: string): key is keyof typeof METADATA_LABELS =>
	Rec.has<string, string>(METADATA_LABELS, key)

const metadataLabel = (key: string): string =>
	isLabelledKey(key) ? METADATA_LABELS[key] : Str.capitalize(Str.replaceAll("_", " ")(key))

/**
 * The audit log ending at one entry, with that entry open. Newest first, so the entry heads the
 * first page however busy the minute was, and the minute before it follows as context.
 */
export const entryHref = (entry: V2AuditLogEntry): string => {
	const at = DateTime.toEpochMillis(DateTime.makeUnsafe(entry.occurred_at))
	return hrefOf(
		AppRoute.Settings({
			search: {
				tab: "audit-log",
				kind: "all",
				since: new Date(at - 60_000).toISOString(),
				until: entry.occurred_at,
				entry: encodePublicId(PublicIdPrefixes.auditLogEntry, entry.id),
			},
		}),
	)
}

const originSection = (h: H, model: Model, entry: V2AuditLogEntry): ReadonlyArray<Html> => {
	if (entry.origin_ip === null && entry.origin_country === null && entry.request_id === null) return []
	return [
		h.section(
			[h.Class("space-y-1.5")],
			[
				eyebrow(h, { variant: "mono", as: "h4", icon: "GlobeIcon" }, ["Origin"]),
				keyValueList(h, { layout: "grid", className: DETAIL_GRID }, [
					keyValue(h, { wrap: true, label: "Surface" }, [
						valueRow(h, [
							icon(h, SOURCE_ICONS[entry.source], {
								size: 13,
								className: "text-muted-foreground shrink-0",
							}),
							h.span([], [SOURCE_LABELS[entry.source]]),
						]),
					]),
					...(entry.origin_ip === null
						? []
						: [
								keyValue(h, { wrap: true, label: "IP address" }, [
									identifier(h, model, entry.origin_ip, "IP address"),
								]),
							]),
					...(entry.origin_country === null
						? []
						: [
								keyValue(h, { wrap: true, label: "Country" }, [
									h.span([], [countryText(entry.origin_country)]),
								]),
							]),
					...(entry.request_id === null
						? []
						: [
								keyValue(h, { wrap: true, label: "Request" }, [
									hstack(
										h,
										{ gap: "1.5", align: "center", wrap: true, shrink: true, as: "span" },
										[
											identifier(h, model, entry.request_id, "Request id"),
											pivot(h, "requestId", entry.request_id, "request"),
										],
									),
								]),
							]),
				]),
			],
		),
	]
}

const DETAIL_GRID =
	"@2xl:grid-cols-[minmax(6rem,max-content)_minmax(0,1fr)_minmax(6rem,max-content)_minmax(0,1fr)] @2xl:gap-x-6"

const valueRow = (h: H, children: ReadonlyArray<Html>): Html =>
	hstack(h, { gap: "1.5", align: "center", wrap: true, shrink: true, as: "span" }, children)

export const auditDetail = (
	h: H,
	model: Model,
	entry: V2AuditLogEntry,
	timeZone: string,
	nowMs: number,
): Html => {
	const full = (value: string) =>
		timestamp(h, { value, timeZone, nowMs, withYear: true, className: "tabular-nums" })
	const actionText = auditActionLabel(entry.action)
	const changes = entry.changes
	const metadata = entry.metadata
	const actorName = entry.actor_name ?? memberName(model, entry.actor_id)
	const affectedName = memberName(model, entry.affected_user)
	return h.div(
		[h.Class("border-border-subtle space-y-4 border-t px-4 py-3 @md:pl-11")],
		[
			keyValueList(h, { layout: "grid", className: DETAIL_GRID }, [
				keyValue(h, { wrap: true, label: "Occurred" }, [full(entry.occurred_at)]),
				keyValue(h, { wrap: true, label: "Recorded" }, [full(entry.recorded_at)]),
				keyValue(h, { wrap: true, label: "Actor" }, [
					valueRow(h, [
						actorBadge(h, entry.actor_type),
						...(actorName === null ? [] : [h.span([], [actorName])]),
						...(entry.actor_id === null
							? []
							: [
									identifier(h, model, entry.actor_id, "Actor id"),
									pivot(h, "actorId", entry.actor_id, "actor"),
								]),
					]),
				]),
				keyValue(h, { wrap: true, label: "Action" }, [
					valueRow(h, [
						...(actionText === null ? [] : [h.span([], [actionText])]),
						inlineCode(h, { variant: "plain", size: "2xs", tone: "foreground" }, [entry.action]),
						entry.outcome === "denied"
							? deniedBadge(h)
							: badge(h, { variant: "ok", size: "sm" }, [
									icon(h, OUTCOME_ICONS.allowed),
									"Allowed",
								]),
						...(actionText === null ? [] : [pivot(h, "action", entry.action, "action")]),
					]),
					...(entry.denial_reason === null
						? []
						: [
								typography(h, { tone: "muted", as: "p", className: "mt-0.5" }, [
									entry.denial_reason,
								]),
							]),
				]),
				keyValue(h, { wrap: true, label: "Resource" }, [
					entry.resource_type === null && entry.resource_id === null
						? typography(h, { tone: "subtle" }, [EMPTY_VALUE])
						: valueRow(h, [
								...(entry.resource_type === null
									? []
									: [
											h.span(
												[],
												[
													auditResourceLabel(entry.resource_type) ??
														entry.resource_type,
												],
											),
										]),
								...(entry.resource_id === null
									? []
									: [
											identifier(h, model, entry.resource_id, "Resource id"),
											pivot(h, "resourceId", entry.resource_id, "resource"),
										]),
							]),
				]),
				...(entry.affected_user === null
					? []
					: [
							keyValue(h, { wrap: true, label: "Affected user" }, [
								valueRow(h, [
									...(affectedName === null ? [] : [h.span([], [affectedName])]),
									identifier(h, model, entry.affected_user, "Affected user id"),
									pivot(h, "affectedUserId", entry.affected_user, "affected user"),
								]),
							]),
						]),
				keyValue(h, { wrap: true, label: "Entry" }, [
					valueRow(h, [
						identifier(
							h,
							model,
							encodePublicId(PublicIdPrefixes.auditLogEntry, entry.id),
							"Entry id",
						),
						textLink(h, { href: entryHref(entry) }, [
							icon(h, "LinkIcon", { size: 12 }),
							typography(h, { size: "2xs" }, ["Link to entry"]),
						]),
					]),
				]),
			]),
			...originSection(h, model, entry),
			...(changes !== null && changes.fields.length > 0
				? [
						h.section(
							[h.Class("space-y-1.5")],
							[
								eyebrow(h, { variant: "mono", as: "h4", icon: "PencilIcon" }, ["Changes"]),
								changesTable(h, changes),
							],
						),
					]
				: []),
			...(metadata !== null && Rec.keys(metadata).length > 0
				? [
						h.section(
							[h.Class("space-y-1.5")],
							[
								eyebrow(h, { variant: "mono", as: "h4", icon: "CircleInfoIcon" }, [
									"Details",
								]),
								...metadataList(h, metadata),
							],
						),
					]
				: []),
		],
	)
}
