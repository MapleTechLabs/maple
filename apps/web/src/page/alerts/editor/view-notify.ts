import type { AlertDestinationDocument, AlertDestinationId, AlertDestinationType } from "@maple/domain/http"
import type { V2ChatConnector } from "@maple/domain/http/v2"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { iconButton } from "@maple/views/ui/icon-button"
import { icon } from "@maple/views/ui/icon"
import * as Menu from "@maple/views/ui/menu"
import * as MenuView from "@maple/views/ui/menu-view"
import { middleTruncate } from "@maple/views/ui/middle-truncate"
import { panel } from "@maple/views/ui/panel"
import {
	destinationProvider,
	destinationTypesFor,
	providerLogo,
	type ProviderLogoOptions,
} from "../shared/providers"
import { menuIdOf } from "./dest-steps"
import { pressable } from "@maple/views/ui/pressable"
import { waitingFor } from "../shared/chat-connect"
import { destinationTarget } from "./derive"
import { Message, type Tier } from "./message"
import { canManage, type Model } from "./model"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { Array as Arr, Option } from "effect"
import { hstack } from "@maple/views/ui/stack"

// `DestinationList` and `AddDestinationMenu`: a tier's destinations and the menu that adds one.

type H = HtmlBuilder<Message>

/** What a tier's list and its Add destination menu read off the Model. */
export type NotifyView = Pick<
	Model,
	"grants" | "connectors" | "menus" | "chatConnect" | "chatConnectMenuId" | "brokenLogos"
>

/** `ProviderLogo size={30} bare`: a destination's mark, the monogram once its image failed. */
export const logo = <M>(
	h: HtmlBuilder<M>,
	model: NotifyView,
	type: AlertDestinationType,
	chatConnector: string | undefined,
	className: string,
	onLogoError?: M,
): Html => {
	const options: ProviderLogoOptions<M> = {
		type,
		size: 30,
		isBare: true,
		className,
		isLogoBroken: model.brokenLogos.includes(type),
	}
	const withConnector = chatConnector === undefined ? options : { ...options, chatConnector }
	return providerLogo(h, onLogoError === undefined ? withConnector : { ...withConnector, onLogoError })
}

const logoError = (type: AlertDestinationType) => Message.FailedLoadProviderLogo({ type })

const selectedRow = (h: H, model: NotifyView, tier: Tier, destination: AlertDestinationDocument): Html => {
	const { primary, secondary } = destinationTarget(destination)
	const paused =
		destination.disabledAt !== null
			? "Paused after repeated delivery failures"
			: destination.enabled
				? null
				: "Paused"
	return hstack(h, { gap: "2.5", align: "center", className: "px-3 py-2" }, [
		logo(
			h,
			model,
			destination.type,
			destination.chatConnector ?? undefined,
			"flex shrink-0",
			logoError(destination.type),
		),
		middleTruncate(h, {
			text: primary,
			tail: 16,
			className: typographyClass({ size: "sm", weight: "medium" }),
		}),
		typography(h, { size: "xs", tone: "muted", truncate: true, className: "min-w-0 flex-1" }, [
			...(paused === null ? [] : [typography(h, { tone: "error" }, [paused, " · "])]),
			secondary,
		]),
		iconButton(
			h,
			{
				label: `Stop notifying ${primary}`,
				className: "-my-1 shrink-0 text-muted-foreground",
				attributes: [h.OnClick(Message.ClickedRemoveDestination({ tier, id: destination.id }))],
			},
			[icon(h, "XmarkIcon")],
		),
	])
}

/** The menu's entries: existing destinations, then new ones per linked workspace and provider. */
const menuEntries = (
	h: H,
	model: NotifyView,
	available: ReadonlyArray<AlertDestinationDocument>,
	connectors: ReadonlyArray<V2ChatConnector>,
	newTypes: ReadonlyArray<AlertDestinationType>,
): ReadonlyArray<MenuView.MenuEntry> => {
	const existing: ReadonlyArray<MenuView.MenuEntry> =
		available.length === 0
			? []
			: [
					{
						_tag: "Group",
						label: "Existing",
						entries: Arr.map(available, (destination): MenuView.MenuEntry => {
							const { primary, secondary } = destinationTarget(destination)
							return {
								_tag: "Item",
								value: `existing:${destination.id}`,
								label: primary,
								content: [
									logo(
										h,
										model,
										destination.type,
										destination.chatConnector ?? undefined,
										"flex shrink-0",
									),
									middleTruncate(h, { text: primary, tail: 16, className: "flex-1" }),
									h.span(
										[h.Class("max-w-24 shrink-0 truncate text-xs text-muted-foreground")],
										[secondary],
									),
								],
							}
						}),
					},
				]
	if (!canManage(model)) return existing
	const chat = Arr.flatMap(connectors, (connector): ReadonlyArray<MenuView.MenuItemEntry> => {
		const mark = logo(h, model, "chat", connector.id, "flex shrink-0")
		if (connector.workspaces.length > 0)
			return Arr.map(connector.workspaces, (workspace) => ({
				_tag: "Item",
				value: `chat:${connector.id}:${workspace.id}`,
				label: connector.name,
				content: [
					mark,
					h.span([h.Class("flex-1")], [connector.name]),
					...(connector.workspaces.length > 1
						? [
								h.span(
									[h.Class("max-w-28 truncate text-xs text-muted-foreground")],
									[workspace.name],
								),
							]
						: []),
				],
			}))
		if (!connector.available || connector.id === "discord") return []
		return [
			{
				_tag: "Item",
				value: `connect:${connector.id}`,
				label: connector.name,
				content: [
					mark,
					h.span([h.Class("flex-1")], [connector.name]),
					typography(h, { size: "xs", tone: "muted" }, ["Connect"]),
				],
			},
		]
	})
	const created: ReadonlyArray<MenuView.MenuItemEntry> = Arr.map(newTypes, (type) => ({
		_tag: "Item",
		value: `type:${type}`,
		label: destinationProvider(type).label,
		content: [logo(h, model, type, undefined, "flex shrink-0"), destinationProvider(type).label],
	}))
	return [
		...existing,
		...(available.length > 0 ? [SEPARATOR] : []),
		{ _tag: "Group", label: "New destination", entries: [...chat, ...created] },
	]
}

const SEPARATOR: MenuView.MenuEntry = { _tag: "Separator" }

/** The trigger row: "Add destination" and the marks of where alerts can go. */
const addMenu = (
	h: H,
	model: NotifyView,
	tier: Tier,
	available: ReadonlyArray<AlertDestinationDocument>,
): Html => {
	const connectors = model.connectors ?? []
	const isDiscordLinked = Arr.some(connectors, (c) => c.id === "discord" && c.workspaces.length > 0)
	const newTypes = destinationTypesFor(isDiscordLinked)
	const previewChat = Arr.filter(
		connectors,
		(c) => c.workspaces.length > 0 || (c.available && c.id !== "discord"),
	)
	const menuId = menuIdOf(tier)
	const waitingId = model.chatConnectMenuId === menuId ? waitingFor(model.chatConnect) : null
	const waiting = Arr.findFirst(connectors, (c) => c.id === waitingId)
	const menu = model.menus[menuId] ?? Menu.init(menuId)
	return h.submodel({
		slotId: menuId,
		model: menu,
		view: MenuView.view,
		viewInputs: {
			entries: menuEntries(h, model, available, connectors, newTypes),
			align: "start",
			className: "w-72",
			toView: ({ trigger, withTrigger }) =>
				h.span(
					[h.Class("contents")],
					withTrigger(
						pressable(
							h,
							{
								className: cn(
									"flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-muted-foreground hover:bg-surface-sunken active:bg-surface-sunken hover:text-foreground active:text-foreground",
									// Open, Base UI's guards follow the trigger, so the panel's divider lands on it.
									menu.isOpen && "border-b border-border-subtle",
								),
								attributes: [h.DataAttribute("slot", "dropdown-menu-trigger"), ...trigger],
							},
							[
								icon(h, "PlusIcon", { size: 14 }),
								Option.match(waiting, {
									onNone: () => "Add destination",
									onSome: (connector) =>
										`Finish connecting ${connector.name} in the other window…`,
								}),
								hstack(
									h,
									{
										gap: "1.5",
										align: "center",
										as: "span",
										className: "ml-auto",
										attributes: [h.AriaHidden(true)],
									},
									[
										...Arr.map(previewChat, (connector) =>
											logo(h, model, "chat", connector.id, "flex", logoError("chat")),
										),
										...Arr.map(newTypes.slice(0, 5), (type) =>
											logo(h, model, type, undefined, "flex", logoError(type)),
										),
									],
								),
							],
						),
					),
				),
		},
		toParentMessage: (message) => Message.GotMenuMessage({ id: menuId, message }),
	})
}

/** `DestinationList`: one tier's destinations, plus the menu that adds an existing or new one. */
export const destinationList = (
	h: H,
	model: NotifyView,
	tier: Tier,
	ids: ReadonlyArray<AlertDestinationId>,
	destinations: ReadonlyArray<AlertDestinationDocument>,
): Html => {
	const selected = Arr.filter(destinations, (d) => ids.includes(d.id))
	const available = Arr.filter(destinations, (d) => !ids.includes(d.id))
	const unresolved = Arr.filter(ids, (id) => !Arr.some(destinations, (d) => d.id === id))
	const canAdd = available.length > 0 || canManage(model)
	return panel(h, { className: "mt-3 divide-y divide-border-subtle border-border-subtle" }, [
		...Arr.map(selected, (destination) => selectedRow(h, model, tier, destination)),
		...Arr.map(unresolved, (id) => unresolvedRow(h, tier, id)),
		...(selected.length === 0 && unresolved.length === 0
			? [
					h.p(
						[h.Class("px-3 py-2.5 text-sm text-muted-foreground")],
						[
							canAdd
								? "No one is notified yet."
								: "No destinations exist yet, and only an org admin can add one.",
						],
					),
				]
			: []),
		...(canAdd ? [addMenu(h, model, tier, available)] : []),
	])
}

const unresolvedRow = (h: H, tier: Tier, id: AlertDestinationId): Html =>
	hstack(h, { gap: "2.5", align: "center", className: "px-3 py-2" }, [
		h.span(
			[h.Class("min-w-0 flex-1 truncate text-sm text-muted-foreground")],
			["Destination unavailable"],
		),
		iconButton(
			h,
			{
				label: "Stop notifying this unavailable destination",
				className: "-my-1 shrink-0 text-muted-foreground",
				attributes: [h.OnClick(Message.ClickedRemoveDestination({ tier, id }))],
			},
			[icon(h, "XmarkIcon")],
		),
	])
