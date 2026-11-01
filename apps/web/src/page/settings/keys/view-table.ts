import type { V2ApiKey } from "@maple/domain/http/v2"
import { EMPTY_VALUE } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { apiKeyRowPermissions } from "../../../components/settings/api-key-permissions"
import {
	KEY_TYPE_LABELS,
	keyAccessSummary,
	type KeyRow,
	type KeyType,
} from "../../../components/settings/keys-table"
import { formatDateInTimezone } from "@maple/web-data/lib/timezone-format"
import { DateTime, Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../ui/display"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../ui/empty"
import { icon } from "../../../ui/icon"
import * as Menu from "../../../ui/menu"
import type * as MenuView from "../../../ui/menu-view"
import { rowActionsMenu } from "../../../ui/row-actions-menu"
import { truncatedText } from "../../../ui/truncated-text"
import { columnHead, dataTable } from "../../infra/kit/data-table"
import { relativeTime } from "../../kit/relative-time"
import { Message } from "./message"
import type { Model } from "./model"

// `KeysTable`, `ApiRow`, `DevicesTable`.

type H = HtmlBuilder<Message>
type Inputs = Readonly<{ nowMs: number; timeZone: string }>

const STATUS_LABELS = { active: "Active", expired: "Expired", revoked: "Revoked" } as const

const TYPE_BADGE = {
	api: "muted",
	mcp: "ok",
} as const satisfies { readonly [Type in KeyType]: "muted" | "ok" }

const COL = {
	name: "w-0 min-w-44 flex-1",
	access: "hidden w-36 shrink-0 @xl:block",
	createdBy: "hidden w-36 shrink-0 @min-[820px]:block",
	lastUsed: "hidden w-20 shrink-0 @2xl:block",
	expires: "w-24 shrink-0",
	menu: "w-7 shrink-0",
}

const ROW_CLASS =
	"flex items-center gap-4 border-b border-border-subtle px-4 py-3 transition-colors last:border-0"

const typeBadge = (h: H, type: KeyType): Html =>
	badge(h, { variant: TYPE_BADGE[type], size: "sm", mono: true }, [KEY_TYPE_LABELS[type]])

const rowMenu = (
	h: H,
	model: Model,
	menuId: string,
	label: string,
	entries: ReadonlyArray<MenuView.MenuEntry>,
) =>
	rowActionsMenu(h, {
		slotId: menuId,
		model: model.rowMenus[menuId] ?? Menu.init(menuId),
		entries,
		label,
		toParentMessage: (message) => Message.GotRowMenuMessage({ menuId, message }),
	})

/** "In 3 days" / "Today": the urgency; the date sits under it. */
const expiresInLabel = (expiresAt: number, now: number): string => {
	const days = Math.floor((expiresAt - now) / 86_400_000)
	if (days < 1) return "Today"
	return days === 1 ? "In 1 day" : `In ${days} days`
}

const epochOf = (iso: string | null): number | null =>
	iso === null ? null : Option.getOrNull(Option.map(DateTime.make(iso), DateTime.toEpochMillis))

const statusBadge = (h: H, row: KeyRow, now: number): ReadonlyArray<Html> => {
	const expiresAt = epochOf(row.key.expires_at)
	if (row.status === "revoked") return [badge(h, { variant: "crit", size: "sm" }, ["Revoked"])]
	if (row.status === "expired") return [badge(h, { variant: "outline", size: "sm" }, ["Expired"])]
	if (row.status === "expiring" && expiresAt !== null)
		return [badge(h, { variant: "warn", size: "sm" }, [expiresInLabel(expiresAt, now)])]
	return []
}

const apiRow = (
	h: H,
	model: Model,
	row: KeyRow,
	inputs: Inputs,
	formatDate: (iso: string) => string,
): Html => {
	const key: V2ApiKey = row.key
	const isDead = row.status === "revoked" || row.status === "expired"
	const can = apiKeyRowPermissions(key, { isAdmin: model.isAdmin, userId: model.userId })
	const entries: ReadonlyArray<MenuView.MenuEntry> = [
		...(can.canRoll
			? [{ _tag: "Item" as const, value: "roll", label: "Roll key", icon: "ArrowPathIcon" as const }]
			: []),
		...(can.canRevoke
			? [
					{
						_tag: "Item" as const,
						value: "revoke",
						label: "Revoke key",
						icon: "TrashIcon" as const,
						variant: "destructive" as const,
					},
				]
			: []),
	]
	return h.div(
		[h.Key(row.id), h.Class(cn(ROW_CLASS, isDead ? "opacity-60" : "hover:bg-surface-sunken active:bg-surface-sunken"))],
		[
			h.div(
				[h.Class(cn(COL.name, "flex flex-col gap-1"))],
				[
					h.div(
						[h.Class("flex min-w-0 items-center gap-2")],
						[
							truncatedText(h, {
								text: key.name,
								className: "text-foreground text-sm font-medium",
							}),
							h.span(
								[h.Class("text-muted-foreground shrink-0 font-mono text-2xs")],
								[key.key_prefix],
							),
							typeBadge(h, row.type),
						],
					),
					...(key.description
						? [
								truncatedText(h, {
									text: key.description,
									className: "text-muted-foreground text-2xs",
								}),
							]
						: []),
				],
			),
			truncatedText(h, {
				text: keyAccessSummary(row),
				className: cn(COL.access, "text-foreground-soft text-2xs"),
			}),
			h.div(
				[h.Class(COL.createdBy)],
				[
					h.div(
						[h.Class("flex min-w-0 flex-col gap-0.5 text-2xs")],
						[
							truncatedText(h, {
								text: key.created_by_email ?? EMPTY_VALUE,
								className: "text-foreground-soft",
							}),
							h.span([h.Class("text-muted-foreground truncate")], [formatDate(key.created_at)]),
						],
					),
				],
			),
			h.span(
				[h.Class(cn(COL.lastUsed, "text-muted-foreground truncate text-2xs"))],
				[
					key.last_used_at
						? relativeTime(h, {
								value: key.last_used_at,
								nowMs: inputs.nowMs,
								timeZone: inputs.timeZone,
								tooltip: "title",
							})
						: EMPTY_VALUE,
				],
			),
			h.div(
				[h.Class(cn(COL.expires, "flex flex-col items-start gap-0.5 text-2xs"))],
				[
					...statusBadge(h, row, inputs.nowMs),
					h.span(
						[h.Class(row.status === "expiring" ? "text-severity-warn" : "text-muted-foreground")],
						[key.expires_at ? formatDate(key.expires_at) : "Never"],
					),
				],
			),
			h.div(
				[h.Class(cn(COL.menu, "flex items-center justify-end"))],
				entries.length === 0
					? []
					: [rowMenu(h, model, `keys-row-${key.id}`, `Actions for ${key.name}`, entries)],
			),
		],
	)
}

export const keysTable = (h: H, model: Model, rows: ReadonlyArray<KeyRow>, inputs: Inputs): Html => {
	const formatDate = (iso: string) => formatDateInTimezone(iso, { timeZone: inputs.timeZone })
	return dataTable(
		h,
		{ ariaLabel: "Keys", stickySurfaceClass: "bg-card", className: "@container border-y-0" },
		[
			columnHead(h, { label: "Name", width: COL.name }),
			columnHead(h, { label: "Access", width: COL.access }),
			columnHead(h, { label: "Created by", width: COL.createdBy }),
			columnHead(h, { label: "Last used", width: COL.lastUsed }),
			columnHead(h, { label: "Expires", width: COL.expires }),
			h.span([h.Class(COL.menu)], []),
		],
		rows.map((row) => apiRow(h, model, row, inputs, formatDate)),
	)
}

const DEVICE_COL = {
	name: "w-0 min-w-44 flex-1",
	owner: "hidden w-44 shrink-0 @xl:block",
	created: "hidden w-28 shrink-0 @2xl:block",
	lastUsed: "hidden w-20 shrink-0 @lg:block",
	expires: "w-24 shrink-0",
	menu: "w-7 shrink-0",
}

const deviceRow = (
	h: H,
	model: Model,
	row: KeyRow,
	inputs: Inputs,
	formatDate: (iso: string) => string,
): Html => {
	const key: V2ApiKey = row.key
	const can = apiKeyRowPermissions(key, { isAdmin: model.isAdmin, userId: model.userId })
	const entries: ReadonlyArray<MenuView.MenuEntry> = can.canRevoke
		? [
				{
					_tag: "Item",
					value: "revoke",
					label: "Revoke device key",
					icon: "TrashIcon",
					variant: "destructive",
				},
			]
		: []
	return h.div(
		[h.Key(row.id), h.Class(cn(ROW_CLASS, "hover:bg-surface-sunken active:bg-surface-sunken"))],
		[
			h.div(
				[h.Class(cn(DEVICE_COL.name, "flex min-w-0 items-center gap-2"))],
				[
					truncatedText(h, { text: key.name, className: "text-foreground text-sm font-medium" }),
					h.span([h.Class("text-muted-foreground shrink-0 font-mono text-2xs")], [key.key_prefix]),
				],
			),
			truncatedText(h, {
				text: key.created_by_email ?? EMPTY_VALUE,
				className: cn(DEVICE_COL.owner, "text-foreground-soft text-2xs"),
			}),
			h.span(
				[h.Class(cn(DEVICE_COL.created, "text-muted-foreground truncate text-2xs"))],
				[formatDate(key.created_at)],
			),
			h.span(
				[h.Class(cn(DEVICE_COL.lastUsed, "text-muted-foreground truncate text-2xs"))],
				[
					key.last_used_at
						? relativeTime(h, {
								value: key.last_used_at,
								nowMs: inputs.nowMs,
								timeZone: inputs.timeZone,
								tooltip: "title",
							})
						: EMPTY_VALUE,
				],
			),
			h.span(
				[h.Class(cn(DEVICE_COL.expires, "text-muted-foreground truncate text-2xs"))],
				[key.expires_at ? formatDate(key.expires_at) : "Never"],
			),
			h.div(
				[h.Class(cn(DEVICE_COL.menu, "flex items-center justify-end"))],
				entries.length === 0
					? []
					: [rowMenu(h, model, `keys-row-${key.id}`, `Actions for ${key.name}`, entries)],
			),
		],
	)
}

/** One row per phone with Home Screen widgets: the key its app minted for them. */
export const devicesTable = (h: H, model: Model, rows: ReadonlyArray<KeyRow>, inputs: Inputs): Html => {
	const formatDate = (iso: string) => formatDateInTimezone(iso, { timeZone: inputs.timeZone })
	return dataTable(
		h,
		{ ariaLabel: "Mobile devices", stickySurfaceClass: "bg-card", className: "@container border-y-0" },
		[
			columnHead(h, { label: "Device key", width: DEVICE_COL.name }),
			columnHead(h, { label: "Owner", width: DEVICE_COL.owner }),
			columnHead(h, { label: "Created", width: DEVICE_COL.created }),
			columnHead(h, { label: "Last used", width: DEVICE_COL.lastUsed }),
			columnHead(h, { label: "Expires", width: DEVICE_COL.expires }),
			h.span([h.Class(DEVICE_COL.menu)], []),
		],
		rows.map((row) => deviceRow(h, model, row, inputs, formatDate)),
	)
}

export const keysEmpty = (h: H, model: Model): Html => {
	const needle = model.search.trim()
	return empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "KeyIcon", { size: 16 })]),
				emptyTitle(h, [needle.length > 0 ? "No keys match" : "No keys here"]),
				emptyDescription(h, [
					needle.length > 0
						? `Nothing matches "${needle}".`
						: `There are no ${STATUS_LABELS[model.statusFilter].toLowerCase()} keys of this type.`,
				]),
			]),
		],
		"py-8",
	)
}
