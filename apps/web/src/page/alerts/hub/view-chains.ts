import type { AlertDestinationId } from "@maple/domain/http"
import type { V2EscalationChain } from "@maple/domain/http/v2"
import { pluralize } from "@maple/ui/lib/format"
import type { AlertDestinationRow } from "@maple/web-data/collections/alerts"
import { Array as Arr, Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { borderedBox } from "@maple/views/ui/bordered-box"
import { button } from "@maple/views/ui/button"
import { confirmDialog } from "@maple/views/ui/confirm-dialog"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import * as Menu from "@maple/views/ui/menu"
import type { MenuEntry } from "@maple/views/ui/menu-view"
import { rowActionsMenu } from "@maple/views/ui/row-actions-menu"
import { emptyActions } from "@maple/views/ui/signal-empty-state"
import { skeleton } from "@maple/views/ui/skeleton"
import { hstack, vstack } from "@maple/views/ui/stack"
import { tooltipTrigger } from "@maple/views/ui/tooltip-host"
import { typography } from "@maple/views/ui/typography"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { sectionHeading } from "../../kit/section-heading"
import { chainSummary } from "../shared/escalation-chains"
import { memberName } from "../shared/org-members"
import { Message } from "./message"
import { canManage, type Model } from "./model"
import { chainMenuId, chainRuleNames } from "./update"
import { dividedList } from "@maple/views/ui/rule"

// The Routing tab's "Escalation chains" section and its delete confirmation.

type H = HtmlBuilder<Message>

const nameOfDestination =
	(rows: ReadonlyArray<AlertDestinationRow>) =>
	(id: AlertDestinationId): string =>
		Option.getOrElse(
			Option.map(
				Arr.findFirst(rows, (row) => row.id === id),
				(row) => row.name,
			),
			() => "an unavailable destination",
		)

/** `ChainRow`: name, the steps in one line, and how many rules start it. */
export const chainRow = (
	h: H,
	model: Model,
	chain: V2EscalationChain,
	destinations: ReadonlyArray<AlertDestinationRow>,
): Html => {
	const summary = chainSummary(chain, nameOfDestination(destinations), {
		userName: (id) => memberName(model.members, id),
		// Before the schedules load the summary says "the on-call"; once loaded, a missing one is deleted.
		scheduleName: (id) =>
			Option.match(AsyncData.getData(model.schedules.data), {
				onNone: () => undefined,
				onSome: (schedules) =>
					Option.getOrElse(
						Option.map(
							Arr.findFirst(schedules, (schedule) => schedule.id === id),
							(schedule) => schedule.name,
						),
						() => "a deleted schedule",
					),
			}),
	})
	const ruleCount = chain.rule_ids.length
	const ruleNames = chainRuleNames(model, chain)
	const menuId = chainMenuId(chain.id)
	const entries: ReadonlyArray<MenuEntry> = [
		{ _tag: "Item", value: "edit", label: "Edit", icon: "PencilIcon" },
		{ _tag: "Separator" },
		{
			_tag: "Item",
			value: "delete",
			label: "Delete",
			icon: "TrashIcon",
			variant: "destructive",
			isDisabled: model.deletingChainId === chain.id,
		},
	]
	const usage =
		ruleCount === 0 ? "Not used by any rule" : `Used by ${ruleCount} ${pluralize(ruleCount, "rule")}`
	return h.li(
		[h.Key(chain.id), h.Class("px-4 py-3")],
		[
			hstack(h, { gap: "3", align: "start" }, [
				icon(h, "BellIcon", { className: "mt-0.5 shrink-0 text-muted-foreground" }),
				vstack(h, { gap: "0.5", shrink: true, grow: true }, [
					typography(h, { size: "sm", weight: "medium", truncate: true, as: "p" }, [chain.name]),
					typography(
						h,
						{
							size: "xs",
							tone: "muted",
							as: "p",
							className: "line-clamp-2 break-words",
							attributes: [h.Title(summary)],
						},
						[summary],
					),
				]),
				hstack(h, { gap: "2", className: "shrink-0" }, [
					typography(
						h,
						{
							size: "xs",
							tone: "muted",
							numeric: true,
							className: "hidden whitespace-nowrap sm:inline",
							attributes:
								ruleNames.length === 0
									? []
									: [...tooltipTrigger(h, Arr.join(ruleNames, ", "))],
						},
						[usage],
					),
					...(canManage(model)
						? [
								rowActionsMenu(h, {
									slotId: menuId,
									model: model.menus[menuId] ?? Menu.init(menuId),
									entries,
									label: `Actions for ${chain.name}`,
									toParentMessage: (message) =>
										Message.GotRowMenuMessage({ menuId, message }),
								}),
							]
						: []),
				]),
			]),
		],
	)
}

const chainsEmpty = (h: H, model: Model): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "BellIcon", { size: 18 })]),
				emptyTitle(h, ["No escalation chains"]),
				emptyDescription(h, [
					"A chain pages one set of destinations, waits for someone to acknowledge, then pages the next. A rule's severity tier can start one on top of its own destinations.",
					...(canManage(model) ? [] : [" Ask an org admin to create one."]),
				]),
			]),
			...(canManage(model)
				? [
						emptyActions(h, [
							button(h, { size: "sm", attributes: [h.OnClick(Message.ClickedNewChain())] }, [
								icon(h, "PlusIcon"),
								"Create chain",
							]),
						]),
					]
				: []),
		],
		"py-12",
	)

/** The chains list, or its empty, loading or failed state. */
export const chainsList = (
	h: H,
	model: Model,
	chains: ReadonlyArray<V2EscalationChain>,
	destinations: ReadonlyArray<AlertDestinationRow>,
): Html =>
	chains.length === 0
		? chainsEmpty(h, model)
		: borderedBox(h, { overflow: "hidden" }, [
				dividedList(
					h,
					{ as: "ul", bordered: false },
					Arr.map(chains, (chain) => chainRow(h, model, chain, destinations)),
				),
			])

const chainsBody = (h: H, model: Model): Html => {
	const destinations = model.destinations ?? []
	const loading = h.div([h.Class("space-y-3")], [skeleton(h, "h-16 w-full"), skeleton(h, "h-16 w-full")])
	return AsyncData.match(model.chains.data, {
		onIdle: () => loading,
		onLoading: () => loading,
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Couldn't load escalation chains",
				onRetry: Message.ClickedRetryChains(),
			}),
		onRefreshing: (chains) => chainsList(h, model, chains, destinations),
		onStale: ({ data }) => chainsList(h, model, data, destinations),
		onSuccess: (chains) => chainsList(h, model, chains, destinations),
	})
}

const hasChains = (model: Model): boolean =>
	Option.exists(AsyncData.getData(model.chains.data), (chains) => chains.length > 0)

/** "Escalation chains": the heading, its New chain button once one exists, and the list. */
export const chainsSection = (h: H, model: Model): Html =>
	h.section(
		[h.Class("space-y-4")],
		[
			h.div(
				[],
				[
					sectionHeading(h, {
						title: "Escalation chains",
						actions:
							canManage(model) && hasChains(model)
								? button(
										h,
										{
											size: "sm",
											variant: "outline",
											attributes: [h.OnClick(Message.ClickedNewChain())],
										},
										[icon(h, "PlusIcon"), "New chain"],
									)
								: undefined,
					}),
					typography(h, { size: "sm", tone: "muted", as: "p" }, [
						"Page step by step until someone acknowledges. Acknowledging pauses a chain and resolving ends it.",
					]),
				],
			),
			chainsBody(h, model),
		],
	)

/** "Delete {chain}?": the 409 that names the rules holding it stays in the dialog. */
export const deleteChainDialog = (h: H, model: Model): Html => {
	const chain = Arr.findFirst(
		Option.getOrElse(AsyncData.getData(model.chains.data), () => []),
		(candidate) => candidate.id === model.confirmDeleteChainId,
	)
	const name = Option.getOrElse(
		Option.map(chain, (found) => found.name),
		() => "escalation chain",
	)
	return confirmDialog(h, {
		slotId: "alerts-delete-chain",
		model: model.deleteChainDialog,
		toParentMessage: (message) => Message.GotDeleteChainDialogMessage({ message }),
		title: `Delete ${name}?`,
		description: "Escalations already running finish on their own copy. This cannot be undone.",
		children:
			model.deleteChainError === null
				? undefined
				: [
						alert(h, { variant: "crit", size: "sm" }, [
							icon(h, "CircleXmarkIcon"),
							alertTitle(h, ["Couldn't delete chain"]),
							alertDescription(h, [model.deleteChainError]),
						]),
					],
		confirmLabel: "Delete chain",
		isPending: model.deletingChainId !== null,
		onConfirm: Message.ClickedConfirmDeleteChain(),
	})
}
