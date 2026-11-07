import type { V2AlertMaintenanceWindow } from "@maple/domain/http/v2"
import { Array as Arr, Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { borderedBox } from "@maple/views/ui/bordered-box"
import { button } from "@maple/views/ui/button"
import { confirmDialog } from "@maple/views/ui/confirm-dialog"
import { badge } from "@maple/views/ui/display"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { icon, rowIcon } from "@maple/views/ui/icon"
import * as Menu from "@maple/views/ui/menu"
import type { MenuEntry } from "@maple/views/ui/menu-view"
import { rowActionsMenu } from "@maple/views/ui/row-actions-menu"
import { emptyActions } from "@maple/views/ui/signal-empty-state"
import { skeleton } from "@maple/views/ui/skeleton"
import { hstack, vstack } from "@maple/views/ui/stack"
import { switchControl } from "@maple/views/ui/switch"
import { textLink } from "@maple/views/ui/text-link"
import { typography } from "@maple/views/ui/typography"
import {
	excludesBaselines,
	occurrenceStateAt,
	occurrenceText,
	scheduleSummary,
	windowSilencesHref,
} from "../shared/maintenance-windows"
import { silenceScopeParts } from "../shared/silences"
import { Message } from "./message"
import { canManage, type Model } from "./model"
import { windowMenuId } from "./update"

// The Maintenance tab: planned, recurring quiet periods, each written ahead as silences.

type H = HtmlBuilder<Message>

/** "service checkout · rule Checkout errors"; before rules sync, rules are counted rather than named. */
const scopeText = (model: Model, window: V2AlertMaintenanceWindow): string => {
	const ruleIds = window.matchers.rule_ids ?? []
	const rules = model.rules
	if (rules === null)
		return Arr.join(
			[
				...silenceScopeParts({ ...window.matchers, rule_ids: [] }, () => ""),
				...(ruleIds.length === 0
					? []
					: [ruleIds.length === 1 ? "1 rule" : `${ruleIds.length} rules`]),
			],
			" · ",
		)
	const ruleName = (id: string): string =>
		Option.getOrElse(
			Option.map(
				Arr.findFirst(rules, (rule) => rule.id === id),
				(rule) => rule.name,
			),
			() => "deleted rule",
		)
	return Arr.join(silenceScopeParts(window.matchers, ruleName), " · ")
}

const rowMenu = (h: H, model: Model, window: V2AlertMaintenanceWindow): Html => {
	const menuId = windowMenuId(window.id)
	const entries: ReadonlyArray<MenuEntry> = [
		{ _tag: "Item", value: "edit", label: "Edit", icon: "PencilIcon" },
		{ _tag: "Separator" },
		{
			_tag: "Item",
			value: "delete",
			label: "Delete",
			icon: "TrashIcon",
			variant: "destructive",
			isDisabled: model.deletingWindowId === window.id,
		},
	]
	return rowActionsMenu(h, {
		slotId: menuId,
		model: model.menus[menuId] ?? Menu.init(menuId),
		entries,
		label: `Actions for ${window.name}`,
		toParentMessage: (message) => Message.GotRowMenuMessage({ menuId, message }),
	})
}

/** One window: name and markers, its schedule, what it covers and when it next runs. */
export const windowRow = (
	h: H,
	model: Model,
	window: V2AlertMaintenanceWindow,
	options: Readonly<{ nowMs: number; timeZone: string }>,
): Html => {
	const isRunning = window.enabled && occurrenceStateAt(window, options.nowMs)._tag === "Running"
	const scope = scopeText(model, window)
	return h.li(
		[h.Key(window.id), h.Class("px-4 py-3")],
		[
			hstack(h, { gap: "3", align: "start" }, [
				rowIcon(h, "CalendarIcon"),
				vstack(h, { gap: "0.5", shrink: true, grow: true }, [
					hstack(h, { gap: "2", wrap: true }, [
						typography(h, { size: "sm", weight: "medium", truncate: true, as: "p" }, [
							window.name,
						]),
						...(isRunning ? [badge(h, { variant: "live" }, ["Running"])] : []),
						...(excludesBaselines(window)
							? [badge(h, { variant: "meta" }, ["Excluded from baselines"])]
							: []),
					]),
					typography(h, { size: "xs", tone: "muted", as: "p", className: "break-words" }, [
						scheduleSummary(window.schedule, options.nowMs, options.timeZone),
					]),
					typography(h, { size: "xs", tone: "muted", as: "p", className: "break-words" }, [
						Arr.join([scope, occurrenceText(window, options.nowMs, options.timeZone)], " · "),
					]),
					textLink(
						h,
						{
							href: windowSilencesHref(window.id),
							tone: "muted",
							className: "self-start text-xs",
						},
						["Occurrences"],
					),
				]),
				hstack(h, { gap: "2", className: "shrink-0" }, [
					...switchControl(h, {
						id: `window-switch-${window.id}`,
						inputId: `window-switch-input-${window.id}`,
						isChecked: window.enabled,
						isDisabled: !canManage(model) || model.togglingWindowIds.includes(window.id),
						ariaLabel: window.enabled ? `Disable ${window.name}` : `Enable ${window.name}`,
						onToggle: Message.ClickedToggleWindow({ windowId: window.id }),
					}),
					...(canManage(model) ? [rowMenu(h, model, window)] : []),
				]),
			]),
		],
	)
}

const windowsEmpty = (h: H, model: Model): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "CalendarIcon", { size: 18 })]),
				emptyTitle(h, ["No maintenance windows"]),
				emptyDescription(h, [
					"Plan quiet periods once or every week, like a nightly backup or a weekend migration. Each occurrence silences the rules it covers, so no one is paged.",
					...(canManage(model) ? [] : [" Ask an org admin to create one."]),
				]),
			]),
			...(canManage(model)
				? [
						emptyActions(h, [
							button(h, { size: "sm", attributes: [h.OnClick(Message.ClickedNewWindow())] }, [
								icon(h, "PlusIcon"),
								"Create window",
							]),
						]),
					]
				: []),
		],
		"py-12",
	)

const windowsList = (
	h: H,
	model: Model,
	windows: ReadonlyArray<V2AlertMaintenanceWindow>,
	options: Readonly<{ nowMs: number; timeZone: string }>,
): Html =>
	windows.length === 0
		? windowsEmpty(h, model)
		: borderedBox(h, { overflow: "hidden" }, [
				h.ul(
					[h.Class("divide-y")],
					Arr.map(windows, (window) => windowRow(h, model, window, options)),
				),
			])

export const hasWindows = (model: Model): boolean =>
	Option.exists(AsyncData.getData(model.windows.data), (windows) => windows.length > 0)

/** The Maintenance tab: the windows, or their empty, loading or failed state. */
export const maintenanceTab = (h: H, model: Model, nowMs: number, timeZone: string): Html => {
	const loading = vstack(h, { gap: "3" }, [skeleton(h, "h-20 w-full"), skeleton(h, "h-20 w-full")])
	const options = { nowMs, timeZone }
	return AsyncData.match(model.windows.data, {
		onIdle: () => loading,
		onLoading: () => loading,
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Couldn't load maintenance windows",
				onRetry: Message.ClickedRetryWindows(),
				className: "py-12",
			}),
		onRefreshing: (windows) => windowsList(h, model, windows, options),
		onStale: ({ data }) => windowsList(h, model, data, options),
		onSuccess: (windows) => windowsList(h, model, windows, options),
	})
}

/** "Delete {window}?": ends a running occurrence and drops the ones ahead. */
export const deleteWindowDialog = (h: H, model: Model): Html => {
	const name = Option.getOrElse(
		Option.map(
			Arr.findFirst(
				Option.getOrElse(AsyncData.getData(model.windows.data), () => []),
				(window) => window.id === model.confirmDeleteWindowId,
			),
			(window) => window.name,
		),
		() => "maintenance window",
	)
	return confirmDialog(h, {
		slotId: "alerts-delete-window",
		model: model.deleteWindowDialog,
		toParentMessage: (message) => Message.GotDeleteWindowDialogMessage({ message }),
		title: `Delete ${name}?`,
		description:
			"An occurrence in progress ends now and the ones ahead are dropped. Past occurrences stay listed as ended silences.",
		confirmLabel: "Delete window",
		isPending: model.deletingWindowId !== null,
		onConfirm: Message.ClickedConfirmDeleteWindow(),
	})
}
