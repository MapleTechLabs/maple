import {
	buildKeyRows,
	filterKeyRows,
	type KeyTypeFilter,
} from "@maple/web/components/settings/keys-table"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertAction, alertDescription } from "../../../ui/alert"
import { button } from "../../../ui/button"
import { confirmDialog } from "../../../ui/confirm-dialog"
import { icon } from "../../../ui/icon"
import * as MenuView from "../../../ui/menu-view"
import { panel } from "../../../ui/panel"
import { searchInput } from "../../../ui/search-input"
import { segmentedSelect } from "../../../ui/segmented-select"
import * as SelectView from "../../../ui/select-view"
import { skeletonList } from "../../../ui/skeleton"
import { settingsSection, settingsSections } from "../kit/section"
import * as CreateDialogView from "./create-dialog-view"
import { Message } from "./message"
import type { Model } from "./model"
import * as RollDialog from "./roll-dialog"
import { STATUS_VALUES } from "./update"
import { apiReference, oauthPointer } from "./view-reference"
import { keysEmpty, keysTable } from "./view-table"

// `KeysTab` (apps/web/src/components/settings/api-keys-section.tsx).

export type ViewInputs = Readonly<{ nowMs: number; timeZone: string }>

type H = HtmlBuilder<Message>

const TYPE_FILTER_LABELS = { all: "All", ingest: "Ingest", api: "API", mcp: "MCP" } as const
const STATUS_LABELS = { active: "Active", expired: "Expired", revoked: "Revoked" } as const

/** Ingest keys are a fixed pair, so only API and MCP keys can be created. Members may create MCP keys. */
const createKeyButton = (h: H, model: Model): Html => {
	const plus = icon(h, "PlusIcon", { attributes: [h.DataAttribute("icon", "inline-start")] })
	if (!model.isAdmin)
		return button(h, { size: "sm", attributes: [h.OnClick(Message.ClickedCreateKey())] }, [plus, "Create MCP key"])
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

const retryAlert = (h: H, text: string, onRetry: Message): Html =>
	alert(h, { size: "sm", variant: "crit" }, [
		alertDescription(h, [text]),
		alertAction(h, [button(h, { size: "sm", variant: "outline", attributes: [h.OnClick(onRetry)] }, ["Retry"])]),
	])

const toolbar = (h: H, model: Model, counts: ReturnType<typeof filterKeyRows>): Html =>
	h.div(
		[h.Class("flex flex-wrap items-center gap-3")],
		[
			segmentedSelect<KeyTypeFilter, Message>(h, {
				size: "sm",
				ariaLabel: "Key type",
				value: model.typeFilter,
				onChange: (type) => Message.ClickedTypeFilter({ type }),
				// Members never see ingest keys, so that chip would always read 0.
				options: (["all", "ingest", "api", "mcp"] as const)
					.filter((type) => type !== "ingest" || model.isAdmin)
					.map((type) => ({ value: type, label: `${TYPE_FILTER_LABELS[type]} · ${counts.typeCounts[type]}` })),
			}),
			h.submodel({
				slotId: "keys-status-select",
				model: { ...model.statusSelect, value: model.statusFilter },
				view: SelectView.view,
				toParentMessage: (message) => Message.GotStatusSelectMessage({ message }),
				viewInputs: {
					entries: STATUS_VALUES.map(
						(status): SelectView.SelectEntry => ({ _tag: "Item", item: { value: status, label: STATUS_LABELS[status] } }),
					),
					ariaLabel: "Key status",
					size: "sm",
					className: "w-36",
					renderValue: () => [STATUS_LABELS[model.statusFilter]],
					renderItem: (option) => [
						option.label,
						" · ",
						String(new Map<string, number>(Object.entries(counts.statusCounts)).get(option.value) ?? 0),
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

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
	const ingestKeys = AsyncData.getOrElse(model.ingest, () => null)
	const isIngestFailed = AsyncData.isFailure(model.ingest)
	const rows = buildKeyRows({ apiKeys: model.apiKeys ?? [], ingestKeys, now: inputs.nowMs })
	const counts = filterKeyRows(rows, { type: model.typeFilter, status: model.statusFilter, search: model.search })
	const isIngestLoading = model.isAdmin && ingestKeys === null && !isIngestFailed
	const isLoading = model.apiKeys === null
	const showSkeleton = isLoading || (isIngestLoading && (model.apiKeys ?? []).length === 0)
	return settingsSections(h, "wide", [
		settingsSection(
			h,
			{
				id: "keys-heading",
				title: "Keys",
				description: ["Every credential that sends data to Maple or reads from it."],
				framed: false,
				width: "wide",
				actions: createKeyButton(h, model),
			},
			[
				toolbar(h, model, counts),
				// TODO(settings-keys): the API-key sync-failure alert and `SyncUnavailable` need the
				// collection load-failure signal (`useCollectionLoadFailed`), not wired in Foldkit yet.
				...(isIngestFailed
					? [retryAlert(h, "Couldn't load the ingest keys. API and MCP keys below are unaffected.", Message.ClickedRetryIngestKeys())]
					: []),
				panel(h, {}, [
					showSkeleton
						? skeletonList(h, { rows: 3, rowClassName: "h-[52px]", gap: "2", className: "p-4" })
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
		confirmDialog(h, {
			slotId: "keys-ingest-roll-dialog",
			model: model.ingestRollDialog,
			toParentMessage: (message) => Message.GotIngestRollDialogMessage({ message }),
			title: `Roll ${model.ingestRollType === "ingest_public" ? "public" : "private"} ingest key?`,
			description: [
				"This action cannot be undone. Everything sending telemetry with this key will be rejected immediately. You will need to update your",
				" ",
				model.ingestRollType === "ingest_public" ? "client-side SDKs" : "server configurations",
				" ",
				"with the new key.",
			],
			confirmLabel: "Roll key",
			onConfirm: Message.ClickedConfirmIngestRoll(),
			isPending: model.isIngestRolling,
		}),
	])
})
