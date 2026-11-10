import { DATA_SOURCE_KINDS, type DataSourceKind } from "@maple/domain/data-sources"
import type { V2DataSource } from "@maple/domain/http/v2"
import { Array as Arr } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { cardButton } from "@maple/views/ui/card-button"
import {
	empty,
	emptyContent,
	emptyDescription,
	emptyHeader,
	emptyMedia,
	emptyTitle,
} from "@maple/views/ui/empty"
import { icon } from "@maple/views/ui/icon"
import { listRow } from "@maple/views/ui/list-row"
import { panel } from "@maple/views/ui/panel"
import { dividedList } from "@maple/views/ui/rule"
import { hstack, vstack } from "@maple/views/ui/stack"
import { grid } from "@maple/views/ui/grid"
import { typography } from "@maple/views/ui/typography"
import { adminOnlyNote, settingsSection } from "../../kit/settings-section"
import { Message } from "./model"
import {
	agentAccessShort,
	environmentBadge,
	type Inputs,
	KIND_ICON,
	KIND_LABEL,
	kindLogo,
	statusLine,
} from "./view-parts"

type H = HtmlBuilder<Message>

export const connectButton = (h: H): Html =>
	button(h, { size: "sm", attributes: [h.OnClick(Message.ClickedConnect())] }, [
		icon(h, "PlugIcon"),
		"Connect a source",
	])

const emptyState = (h: H, inputs: Inputs): Html =>
	empty(h, [
		emptyHeader(h, [
			emptyMedia(h, { variant: "icon" }, [icon(h, "PlugIcon")]),
			emptyTitle(h, ["Query your own systems in place"]),
			emptyDescription(h, [
				"Connect a database or an API and Maple queries it where it lives: nothing is copied or imported. ",
				"Dashboards, alerts and assistants can then read it next to your telemetry.",
			]),
		]),
		emptyContent(h, [
			inputs.canManage
				? connectButton(h)
				: adminOnlyNote(h, ["Ask an organization admin to connect a data source."]),
		]),
	])

// The logo names the kind; the status and agent access share one short line so a phone row stays three lines.
const sourceRow = (h: H, source: V2DataSource): Html =>
	listRow(h, {
		divided: true,
		onClick: Message.ClickedOpen({ id: source.id }),
		className: "items-start py-3 [&>[data-slot=list-row-trailing]]:self-center",
		leading: kindLogo(h, source.kind),
		title: hstack(h, { gap: "2", className: "min-w-0" }, [
			typography(h, { mono: true, weight: "medium", truncate: true, className: "min-w-0" }, [
				source.name,
			]),
			h.span([h.Class("shrink-0")], [environmentBadge(h, source.environment)]),
		]),
		meta: vstack(h, { gap: "1", align: "start", className: "whitespace-normal" }, [
			hstack(h, { gap: "3", wrap: true, className: "gap-y-0.5" }, [
				statusLine(h, source),
				typography(h, { size: "xs", tone: "muted" }, [agentAccessShort(source)]),
			]),
			...(source.status === "error" && source.last_error !== null
				? [
						typography(h, { size: "xs", tone: "error", className: "line-clamp-2 break-words" }, [
							source.last_error,
						]),
					]
				: []),
			...(source.description === ""
				? []
				: [
						typography(h, { size: "xs", tone: "muted", className: "line-clamp-2 font-prose" }, [
							source.description,
						]),
					]),
		]),
		trailing: icon(h, "ChevronRightIcon", { size: 16, className: "text-muted-foreground" }),
	})

export const listView = (h: H, sources: ReadonlyArray<V2DataSource>, inputs: Inputs): Html =>
	settingsSection(
		h,
		{
			id: "data-sources",
			title: "Data sources",
			isLead: true,
			framed: false,
		},
		[
			sources.length === 0
				? panel(h, {}, [emptyState(h, inputs)])
				: panel(h, { className: "overflow-hidden" }, [
						dividedList(
							h,
							{ as: "div" },
							Arr.map(sources, (source) => sourceRow(h, source)),
						),
					]),
		],
	)

const KIND_HINT = {
	clickhouse: "A ClickHouse database over its HTTP interface. Maple runs read-only SQL.",
	clerk: "Your Clerk users, organizations and sessions, read through Clerk's API.",
} as const satisfies Record<DataSourceKind, string>

export const pickKindView = (h: H): Html =>
	settingsSection(
		h,
		{
			id: "data-sources-pick",
			title: "Connect a data source",
			description: ["What do you want to connect?"],
		},
		[
			vstack(h, { gap: "4" }, [
				grid(
					h,
					{ sm: 2, gap: "3" },
					Arr.map(DATA_SOURCE_KINDS, (kind) =>
						cardButton(
							h,
							{ onClick: Message.ClickedKind({ kind }), className: "p-4 text-left" },
							[
								vstack(h, { gap: "2", align: "start" }, [
									hstack(h, { gap: "2" }, [
										icon(h, KIND_ICON[kind]),
										typography(h, { weight: "medium" }, [KIND_LABEL[kind]]),
									]),
									typography(h, { size: "xs", tone: "muted", className: "font-prose" }, [
										KIND_HINT[kind],
									]),
								]),
							],
						),
					),
				),
				hstack(h, {}, [
					button(
						h,
						{ variant: "ghost", size: "sm", attributes: [h.OnClick(Message.ClickedBack())] },
						[icon(h, "ArrowLeftIcon"), "Back to data sources"],
					),
				]),
			]),
		],
	)
