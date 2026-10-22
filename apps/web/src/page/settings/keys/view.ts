import { buildKeyRows, filterKeyRows, type KeyTypeFilter } from "../../../components/settings/keys-table"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { confirmDialog } from "../../../ui/confirm-dialog"
import { icon } from "../../../ui/icon"
import * as MenuView from "../../../ui/menu-view"
import { panel } from "../../../ui/panel"
import { searchInput } from "../../../ui/search-input"
import { segmentedSelect } from "../../../ui/segmented-select"
import * as SelectView from "../../../ui/select-view"
import { skeletonList } from "../../../ui/skeleton"
import { errorState } from "../../../ui/error-state"
import { makeClientErrorBody } from "@maple/web-data/lib/error-messages"
import { settingsSection, settingsSections } from "../kit/section"
import * as CreateDialogView from "./create-dialog-view"
import { Message } from "./message"
import type { Model } from "./model"
import * as RollDialog from "./roll-dialog"
import { STATUS_VALUES } from "./update"
import { apiReference, oauthPointer } from "./view-reference"
import { keysEmpty, keysTable } from "./view-table"

// `ApiKeysSection`.

export type ViewInputs = Readonly<{ nowMs: number; timeZone: string }>

type H = HtmlBuilder<Message>

const TYPE_FILTER_LABELS = { all: "All", api: "API", mcp: "MCP" } as const
const STATUS_LABELS = { active: "Active", expired: "Expired", revoked: "Revoked" } as const

/** Members may create MCP keys only. */
const createKeyButton = (h: H, model: Model): Html => {
	const plus = icon(h, "PlusIcon", { attributes: [h.DataAttribute("icon", "inline-start")] })
	if (!model.isAdmin)
		return button(h, { size: "sm", attributes: [h.OnClick(Message.ClickedCreateKey())] }, [
			plus,
			"Create MCP key",
		])
	return h.div(
		[h.Class("flex")],
		[
			button(
				h,
				{
					size: "sm",
					className: "relative rounded-r-none before:rounded-r-none focus-visible:z-10",
					attributes: [h.OnClick(Message.ClickedCreateKey())],
				},
				[plus, "Create key"],
			),
			h.submodel({
				slotId: "keys-create-menu",
				model: model.createMenu,
				view: MenuView.view,
				toParentMessage: (message) => Message.GotCreateMenuMessage({ message }),
				viewInputs: {
					entries: [
						{ _tag: "Item", value: "standard", label: "API key" },
						{ _tag: "Item", value: "mcp", label: "MCP key" },
					],
					align: "end",
					className: "min-w-40",
					toView: ({ trigger, withTrigger }) =>
						h.span(
							[h.Class("contents")],
							withTrigger(
								button(
									h,
									{
										size: "icon-sm",
										className:
											"relative -ml-px rounded-l-none border-l border-l-primary-foreground/20 before:rounded-l-none focus-visible:z-10",
										attributes: [h.AriaLabel("Choose key type"), ...trigger],
									},
									[icon(h, "ChevronDownIcon", { className: "size-3.5" })],
								),
							),
						),
				},
			}),
		],
	)
}

const toolbar = (h: H, model: Model, counts: ReturnType<typeof filterKeyRows>): Html =>
	h.div(
		[h.Class("flex flex-wrap items-center gap-3")],
		[
			segmentedSelect<KeyTypeFilter, Message>(h, {
				size: "sm",
				ariaLabel: "Key type",
				value: model.typeFilter,
				onChange: (type) => Message.ClickedTypeFilter({ type }),
				options: (["all", "api", "mcp"] as const).map((type) => ({
					value: type,
					label: `${TYPE_FILTER_LABELS[type]} · ${counts.typeCounts[type]}`,
				})),
			}),
			h.submodel({
				slotId: "keys-status-select",
				model: { ...model.statusSelect, value: model.statusFilter },
				view: SelectView.view,
				toParentMessage: (message) => Message.GotStatusSelectMessage({ message }),
				viewInputs: {
					entries: STATUS_VALUES.map((status): SelectView.SelectEntry => ({
						_tag: "Item",
						item: { value: status, label: STATUS_LABELS[status] },
					})),
					ariaLabel: "Key status",
					size: "sm",
					className: "w-36",
					renderValue: () => [STATUS_LABELS[model.statusFilter]],
					renderItem: (option) => [
						option.label,
						" · ",
						String(
							new Map<string, number>(Object.entries(counts.statusCounts)).get(option.value) ??
								0,
						),
					],
					toView: (parts) => h.div([h.Class("contents")], parts),
				},
			}),
			h.div([h.Class("flex-1")], []),
			searchInput(h, {
				id: "keys-search",
				value: model.search,
				onInput: (value) => Message.ChangedSearch({ value }),
				onClear: Message.ClickedClearSearch(),
				placeholder: "Search keys",
				className: "w-64",
			}),
		],
	)

/** `SyncUnavailable`: the `api_keys` stream stopped before its first answer. */
const SYNC_UNAVAILABLE = makeClientErrorBody({
	_tag: "@maple/web/errors/SyncUnavailable",
	code: "sync_unavailable",
	title: "Failed to load keys",
	message: "Live sync is unavailable, so keys couldn’t be loaded. Try again.",
	retryable: false,
	recovery: "retry",
})

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
	const rows = buildKeyRows({ apiKeys: model.apiKeys ?? [], now: inputs.nowMs })
	const counts = filterKeyRows(rows, {
		type: model.typeFilter,
		status: model.statusFilter,
		search: model.search,
	})
	const isLoading = model.apiKeys === null && !model.isLoadFailed
	const isFailed = model.apiKeys === null && model.isLoadFailed
	return settingsSections(h, "wide", [
		settingsSection(
			h,
			{
				id: "keys-heading",
				title: "Keys",
				description: ["Keys for the Maple API and MCP clients. Ingest keys live in Ingestion."],
				framed: false,
				width: "wide",
				actions: createKeyButton(h, model),
			},
			[
				toolbar(h, model, counts),
				panel(h, {}, [
					isFailed
						? errorState(h, {
								failure: SYNC_UNAVAILABLE,
								title: "Failed to load keys",
								onRetry: Message.ClickedRetryLoad(),
								className: "py-12",
							})
						: isLoading
							? skeletonList(h, {
									rows: 3,
									rowClassName: "h-[52px]",
									gap: "2",
									className: "p-4",
								})
							: counts.visible.length === 0
								? keysEmpty(h, model)
								: keysTable(h, model, counts.visible, inputs),
				]),
			],
		),
		oauthPointer(h),
		apiReference(h, model),
		h.submodel({
			slotId: "keys-create-dialog",
			model: model.create,
			view: CreateDialogView.view,
			toParentMessage: (message) => Message.GotCreateMessage({ message }),
			viewInputs: { slotId: "keys-create-dialog-popup" },
		}),
		h.submodel({
			slotId: "keys-roll-dialog",
			model: model.roll,
			view: RollDialog.view,
			toParentMessage: (message) => Message.GotRollMessage({ message }),
			viewInputs: { slotId: "keys-roll-dialog-popup" },
		}),
		confirmDialog(h, {
			slotId: "keys-revoke-dialog",
			model: model.revokeDialog,
			toParentMessage: (message) => Message.GotRevokeDialogMessage({ message }),
			title: "Revoke key?",
			description:
				model.revoking === null
					? "Any integrations using this key will stop working immediately. This action cannot be undone."
					: [
							h.span([h.Class("text-foreground font-medium")], [model.revoking.name]),
							" (",
							h.span([h.Class("font-mono text-xs")], [model.revoking.key_prefix]),
							") will stop working immediately. This action cannot be undone.",
						],
			confirmLabel: "Revoke key",
			onConfirm: Message.ClickedConfirmRevoke(),
			isPending: model.isRevoking,
		}),
	])
})
