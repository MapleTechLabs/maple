import { GCP_PROJECT_ASSET_TYPE } from "@maple/domain/gcp-metrics"
import { gcpResourceWorkload } from "../../../../components/infra/gcp/inventory"
import { gcpAssetTypeLabel, gcpResourceName, gcpStateLabel } from "../../../../components/infra/gcp/tabs"
import { countLabel, EMPTY_VALUE } from "@maple/ui/lib/format"
import { AsyncData } from "foldkit"
import type { Html } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "../../../../ui/alert"
import { errorState } from "../../../../ui/error-state"
import { icon } from "../../../../ui/icon"
import type * as Select from "../../../../ui/select"
import { type SelectEntry, view as selectView } from "../../../../ui/select-view"
import { skeleton } from "../../../../ui/skeleton"
import {
	columnHead,
	dataTable,
	dataTableEmpty,
	skeletonRows,
	ROW_LINK_CLASS,
} from "../../../infra/kit/data-table"
import { filteredEmpty } from "../../../kit/signal-empty-state"
import type { Resources } from "../data"
import { gcpMessage } from "../gcp-message"
import { Message, type Model } from "./model"
import type { H, TimeSearch } from "./view-rows"
import { workloadHref } from "./view-rows"

// `GcpResources`: the inventory filtered by type and project.
// TODO(select-align): these Selects should open below the trigger (`alignItemWithTrigger={false}`).

const ALL = "all"
const CELL = "truncate font-mono text-xs text-foreground/80"

const columns = (h: H): ReadonlyArray<Html> => [
	columnHead(h, { label: "Resource", width: "w-0 flex-1 min-w-[220px]" }),
	columnHead(h, { label: "Type", width: "w-[170px]" }),
	columnHead(h, { label: "Project", width: "w-[200px]" }),
	columnHead(h, { label: "Location", width: "w-[120px]" }),
	columnHead(h, { label: "State", width: "w-[120px]" }),
	columnHead(h, { label: "Labels", width: "w-[150px]", hidden: "hidden lg:flex" }),
]

const loading = (h: H): Html =>
	dataTable(
		h,
		{ ariaLabel: "Google Cloud resources" },
		columns(h),
		skeletonRows(h, 5, () => [
			skeleton(h, "h-4 w-0 min-w-[220px] flex-1"),
			skeleton(h, "h-3 w-[170px]"),
			skeleton(h, "h-3 w-[200px]"),
			skeleton(h, "h-3 w-[120px]"),
			skeleton(h, "h-3 w-[120px]"),
			skeleton(h, "hidden h-3 w-[150px] lg:block"),
		]),
	)

const filterSelect = (
	h: H,
	options: Readonly<{
		slotId: string
		model: Select.Model
		label: string
		allLabel: string
		entries: ReadonlyArray<{ value: string; label: string }>
		value: string | undefined
		toMessage: (message: Select.Message) => Message
	}>,
	toView: (parts: ReadonlyArray<Html>) => Html,
): Html =>
	h.submodel({
		slotId: options.slotId,
		model: { ...options.model, value: options.value ?? ALL },
		view: selectView,
		toParentMessage: options.toMessage,
		viewInputs: {
			entries: [{ value: ALL, label: options.allLabel }, ...options.entries].map(
				(item): SelectEntry => ({ _tag: "Item", item }),
			),
			ariaLabel: options.label,
			className: "w-auto min-w-0",
			toView,
		},
	})

const metaChip = (h: H, text: string): Html =>
	h.span([h.Class("font-mono text-3xs text-muted-foreground/80")], [text])

const resourceRow = (h: H, resource: Resources["resources"][number], timeSearch: TimeSearch): Html => {
	const labels = Object.entries(resource.labels).map(([key, value]) => `${key}: ${value}`)
	const type = gcpAssetTypeLabel(resource.assetType)
	const state = resource.state === null ? null : gcpStateLabel(resource.state)
	const workload = gcpResourceWorkload(resource)
	const cells = [
		h.div(
			[
				h.Class(
					"w-0 min-w-[220px] flex-1 truncate font-mono text-xs font-medium text-foreground transition-colors group-hover:text-primary",
				),
				h.Title(resource.name),
			],
			[gcpResourceName(resource)],
		),
		h.div([h.Class("w-[170px] truncate text-xs text-foreground/80"), h.Title(type)], [type]),
		h.div([h.Class(`w-[200px] ${CELL}`), h.Title(resource.projectId)], [resource.projectId]),
		h.div(
			[
				h.Class(`w-[120px] ${CELL}`),
				...(resource.location === null ? [] : [h.Title(resource.location)]),
			],
			[resource.location ?? EMPTY_VALUE],
		),
		h.div(
			[
				h.Class("w-[120px] truncate text-xs text-foreground/80"),
				...(state === null ? [] : [h.Title(state)]),
			],
			[state ?? EMPTY_VALUE],
		),
		h.div(
			[
				h.Class("hidden w-[150px] items-center gap-2 whitespace-nowrap lg:flex"),
				h.Title(labels.join("\n")),
			],
			[
				...(labels.length === 0
					? []
					: [h.span([h.Class("min-w-0 truncate")], [metaChip(h, labels[0] ?? "")])]),
				...(labels.length > 1 ? [metaChip(h, `+${labels.length - 1}`)] : []),
			],
		),
	]
	return workload === undefined
		? h.div(
				[
					h.Class(
						"flex items-center gap-4 border-b border-border/40 px-4 py-3 last:border-0 hover:bg-muted/40",
					),
				],
				cells,
			)
		: h.a(
				[h.Class(ROW_LINK_CLASS), h.Href(workloadHref(workload.service, workload.keys, timeSearch))],
				cells,
			)
}

const resourcesList = (
	h: H,
	model: Model,
	inventory: Resources,
	timeSearch: TimeSearch,
	isWaiting: boolean,
): ReadonlyArray<Html> => {
	const { resources, total, types, projects } = inventory
	const projectCount = types.find((entry) => entry.assetType === GCP_PROJECT_ASSET_TYPE)?.count ?? 0
	const type = model.search.type || undefined
	const project = model.search.project || undefined
	const filtered = type !== undefined || project !== undefined
	const summary = `${total > resources.length ? `First ${resources.length} of ${countLabel(total, "resource")}` : countLabel(total, "resource")}`
	const toolbar = filterSelect(
		h,
		{
			slotId: "gcp-resource-type",
			model: model.resourceTypeSelect,
			label: "Resource type",
			allLabel: "All types",
			entries: types.map((entry) => ({
				value: entry.assetType,
				label: `${gcpAssetTypeLabel(entry.assetType)} (${entry.count})`,
			})),
			value: type,
			toMessage: (message) => Message.GotResourceTypeSelectMessage({ message }),
		},
		(typeParts) =>
			filterSelect(
				h,
				{
					slotId: "gcp-resource-project",
					model: model.resourceProjectSelect,
					label: "Project",
					allLabel: "All projects",
					entries: projects.map((name) => ({ value: name, label: name })),
					value: project,
					toMessage: (message) => Message.GotResourceProjectSelectMessage({ message }),
				},
				(projectParts) =>
					h.div(
						[h.Class("flex flex-wrap items-center justify-between gap-3")],
						[
							h.div(
								[h.Class("flex flex-wrap items-center gap-2")],
								[...typeParts, ...projectParts],
							),
							h.span(
								[h.Class("text-xs text-muted-foreground tabular-nums")],
								[summary, " · ", countLabel(projectCount, "project"), " discovered"],
							),
						],
					),
			),
	)
	return [
		toolbar,
		resources.length === 0 && filtered
			? filteredEmpty(h, {
					noun: "resources",
					description: "Clear the type or project filter to see them all.",
				})
			: dataTable(
					h,
					{ ariaLabel: "Google Cloud resources", isWaiting },
					columns(h),
					resources.length === 0
						? [
								dataTableEmpty(h, [
									"No resources yet. Maple lists them with a connection's first metrics read, then every hour.",
								]),
							]
						: resources.map((resource) => resourceRow(h, resource, timeSearch)),
				),
	]
}

export const resourcesView = (h: H, model: Model, timeSearch: TimeSearch, syncError: string | null): Html =>
	h.div(
		[h.Class("space-y-4")],
		[
			...(syncError === null
				? []
				: [
						alert(h, { variant: "warn" }, [
							icon(h, "CircleWarningIcon", { size: 16 }),
							alertTitle(h, ["Not every resource is listed"]),
							alertDescription(h, [gcpMessage(h, syncError)]),
						]),
					]),
			...AsyncData.match(model.resources.data, {
				onIdle: () => [loading(h)],
				onLoading: () => [loading(h)],
				onFailure: (failure) => [
					errorState(h, {
						failure,
						title: "Couldn't load resources",
						onRetry: Message.ClickedRetryResources(),
					}),
				],
				onStale: ({ error }) => [
					errorState(h, {
						failure: error,
						title: "Couldn't load resources",
						onRetry: Message.ClickedRetryResources(),
					}),
				],
				onRefreshing: (inventory) => resourcesList(h, model, inventory, timeSearch, true),
				onSuccess: (inventory) => resourcesList(h, model, inventory, timeSearch, false),
			}),
		],
	)
