import type { V2CatalogEntry, V2DataSource, V2DataSourceCatalog } from "@maple/domain/http/v2"
import { Array as Arr } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { formatNumber } from "@maple/ui/lib/format"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { button } from "@maple/views/ui/button"
import { badge } from "@maple/views/ui/display"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import { panel } from "@maple/views/ui/panel"
import { refreshButton } from "@maple/views/ui/refresh-button"
import { dividedList } from "@maple/views/ui/rule"
import { skeletonList } from "@maple/views/ui/skeleton"
import { hstack, vstack } from "@maple/views/ui/stack"
import { switchControl } from "@maple/views/ui/switch"
import { typography } from "@maple/views/ui/typography"
import { sectionNote, settingsSection } from "../kit/section"
import { isSavingEntry, Message, type Model } from "./model"
import { entryEditor } from "./view-catalog-entry"
import type { Inputs } from "./view-parts"

type H = HtmlBuilder<Message>

const exposedControl = (h: H, model: Model, entry: V2CatalogEntry, inputs: Inputs): ReadonlyArray<Html> =>
	inputs.canManage
		? [
				typography(h, { size: "xs", tone: "muted" }, [
					entry.exposed ? "Shown to agents" : "Hidden from agents",
				]),
				...switchControl(h, {
					id: `catalog-${entry.name}-exposed`,
					inputId: `catalog-${entry.name}-exposed-input`,
					isChecked: entry.exposed,
					isDisabled: isSavingEntry(model, entry.name),
					ariaLabel: `Show ${entry.name} to agents`,
					onToggle: Message.ToggledEntryExposed({ name: entry.name }),
				}),
			]
		: [
				badge(h, { variant: entry.exposed ? "muted" : "meta", size: "sm" }, [
					entry.exposed ? "Shown to agents" : "Hidden from agents",
				]),
			]

const entryRow = (h: H, model: Model, entry: V2CatalogEntry, inputs: Inputs): Html => {
	const isOpen = model.entryDraft?.name === entry.name
	// One draft at a time: another row's edit would drop its unsaved notes.
	const isLocked = model.entryDraft !== null && !isOpen
	return vstack(h, { gap: "2", className: "px-4 py-3" }, [
		hstack(h, { gap: "3", justify: "between", wrap: true }, [
			vstack(h, { gap: "1", align: "start", className: "min-w-0" }, [
				hstack(h, { gap: "2", wrap: true }, [
					typography(h, { mono: true, weight: "medium", className: "break-all" }, [entry.name]),
					badge(h, { variant: "meta", size: "sm" }, [entry.kind]),
					typography(h, { size: "xs", tone: "muted" }, [
						`${entry.fields.length} fields`,
						...(entry.row_estimate === null
							? []
							: [` · ~${formatNumber(entry.row_estimate)} rows`]),
						...(entry.time_field === null ? [] : [` · time field ${entry.time_field}`]),
					]),
				]),
				...(entry.note === null
					? []
					: [typography(h, { size: "xs", tone: "muted", className: "font-prose" }, [entry.note])]),
			]),
			hstack(h, { gap: "2" }, [
				...exposedControl(h, model, entry, inputs),
				button(
					h,
					{
						variant: "ghost",
						size: "sm",
						isDisabled: isLocked,
						attributes: [
							h.OnClick(
								isOpen
									? Message.ClickedCancelEntry()
									: Message.ClickedEditEntry({ name: entry.name }),
							),
						],
					},
					[isOpen ? "Close" : inputs.canManage ? "Fields and notes" : "Fields"],
				),
			]),
		]),
		...(isOpen && model.entryDraft !== null
			? [entryEditor(h, model, entry, model.entryDraft, inputs)]
			: []),
	])
}

const entriesBody = (h: H, model: Model, catalog: V2DataSourceCatalog, inputs: Inputs): Html =>
	catalog.entries.length === 0
		? sectionNote(
				h,
				inputs.canManage
					? "No tables or resources found yet. Refresh the catalog once the source has data."
					: "No tables or resources found yet.",
			)
		: dividedList(
				h,
				{ as: "div" },
				Arr.map(catalog.entries, (entry) => entryRow(h, model, entry, inputs)),
			)

const entriesView = (h: H, model: Model, inputs: Inputs): Html =>
	AsyncData.match(model.catalog, {
		onIdle: () => skeletonList(h, { rows: 3, className: "p-4" }),
		onLoading: () => skeletonList(h, { rows: 3, className: "p-4" }),
		onFailure: (failure) => errorState(h, { failure, variant: "inline" }),
		onSuccess: (catalog) => entriesBody(h, model, catalog, inputs),
		onRefreshing: (catalog) => entriesBody(h, model, catalog, inputs),
		onStale: ({ data }) => entriesBody(h, model, data, inputs),
	})

export const catalogSection = (h: H, model: Model, source: V2DataSource, inputs: Inputs): Html =>
	settingsSection(
		h,
		{
			id: "data-source-catalog",
			title: "Catalog",
			description: [
				"The tables and resources Maple found on this source. Notes and time fields help assistants write correct queries; hidden entries are not shown to agents.",
			],
			framed: false,
			actions: inputs.canManage
				? refreshButton(h, {
						onRefresh: Message.ClickedRefreshCatalog(),
						isPending: model.refreshingId === source.id,
						label: "Refresh catalog",
						size: "sm",
						variant: "outline",
					})
				: undefined,
		},
		[
			...(source.catalog_error === null
				? []
				: [
						alert(h, { variant: "crit" }, [
							icon(h, "CircleWarningIcon"),
							alertTitle(h, ["The last refresh failed"]),
							alertDescription(h, [source.catalog_error]),
						]),
					]),
			panel(h, { className: "overflow-hidden" }, [entriesView(h, model, inputs)]),
		],
	)
