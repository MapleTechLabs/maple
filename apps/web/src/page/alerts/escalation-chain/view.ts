import { MAX_ESCALATION_REPEATS, MAX_ESCALATION_STEPS, MAX_ESCALATION_WAIT_MINUTES } from "@maple/domain/http"
import type { AlertDestinationId } from "@maple/domain/http"
import type { V2EscalationTarget } from "@maple/domain/http/v2"
import { pluralize } from "@maple/ui/lib/format"
import { rowToAlertDestinationDocument } from "@maple/web-data/collections/alerts"
import { Option, Array as Arr, String as Str } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { failureMessage } from "@maple/views/data/load-failure"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { button, linkButton } from "@maple/views/ui/button"
import { confirmDialog } from "@maple/views/ui/confirm-dialog"
import { errorState } from "@maple/views/ui/error-state"
import { fieldErrorText, type FieldIds, fieldLabel, input } from "@maple/views/ui/field"
import { icon } from "@maple/views/ui/icon"
import type { FieldState } from "@maple/views/ui/input"
import * as Menu from "@maple/views/ui/menu"
import type { MenuEntry } from "@maple/views/ui/menu-view"
import { panel } from "@maple/views/ui/panel"
import { personAvatar } from "@maple/views/ui/person-avatar"
import { rowActionsMenu } from "@maple/views/ui/row-actions-menu"
import { skeleton } from "@maple/views/ui/skeleton"
import { hstack, hstackClass, vstack } from "@maple/views/ui/stack"
import { textLink } from "@maple/views/ui/text-link"
import { textarea } from "@maple/views/ui/textarea"
import { typography } from "@maple/views/ui/typography"
import type { PageViewInputs } from "../../contract"
import { chainConnector } from "../../kit/chain-connector"
import { chainDeleteConfirm } from "../shared/chain-delete-confirm"
import { dashboardPage } from "../../kit/dashboard-page"
import { managersOnlyPage } from "../../kit/form-section"
import { type PickedChip, pickChips } from "../../kit/pick-chips"
import { resourceNotFound } from "../../kit/resource-not-found"
import { CHAIN_NOT_FOUND_CODE, chainSummary, routingTabHref } from "../shared/escalation-chains"
import { ruleHref } from "../shared/links"
import { memberName, memberOf } from "../shared/org-members"
import { providerLogo } from "../shared/providers"
import {
	canAddStep,
	descriptionError,
	formIssues,
	nameError,
	numberOf,
	previewOf,
	repeatError,
	type StepDraft,
	stepsError,
	targetKey,
	targetsError,
	waitError,
} from "./form"
import { Message } from "./message"
import { canManage, type Model } from "./model"
import { backHref, DELETE_DIALOG_ID, insertButtonId, LEAVE_DIALOG_ID, menuIdOf } from "./update"

// The escalation chain editor: the chain as a column of sentence cards, its name and preview beside it.

type H = HtmlBuilder<Message>

/** The page's name: the chain as last read, or "New escalation chain". */
export const chainTitle = (model: Pick<Model, "editingId" | "existing">): string =>
	model.editingId === null
		? "New escalation chain"
		: Option.getOrElse(
				Option.map(AsyncData.getData(model.existing.data), (chain) => chain.name),
				() => "Escalation chain",
			)

const nameOr = <A extends { readonly id: string; readonly name: string }>(
	rows: ReadonlyArray<A> | null,
	id: string,
	fallback: string,
): string =>
	Option.getOrElse(
		Option.map(
			Arr.findFirst(rows ?? [], (row) => row.id === id),
			(row) => row.name,
		),
		() => (rows === null ? fallback : `Unavailable ${Str.toLowerCase(fallback)}`),
	)

/** A person by id; someone removed from the org reads "Unavailable member", as a deleted destination does. */
const personName = (model: Model, userId: string): string =>
	memberName(model.members, userId, "Unavailable member")

/** A field's error once a save was tried, or at once for a number typed out of range. */
const shown = (model: Model, error: Option.Option<string>, isImmediate = false): Option.Option<string> =>
	model.isShowingErrors || isImmediate ? error : Option.none()

const errorText = (h: H, error: Option.Option<string>): ReadonlyArray<Html> =>
	Option.match(error, {
		onNone: () => [],
		onSome: (text) => [fieldErrorText(h, { attributes: [h.Role("alert")] }, [text])],
	})

const isOutOfRange = (raw: string, error: Option.Option<string>) => raw !== "" && Option.isSome(error)

const idsOf = (id: string): FieldIds => ({ control: id, label: `${id}-label`, error: `${id}-error` })

const stateOf = (value: string, isInvalid: boolean): FieldState => ({
	isInvalid,
	isDirty: false,
	isFilled: value !== "",
	isFocused: false,
	isTouched: false,
})

/** Nothing can be typed: a save is in flight, or the viewer may only read the chain. */
const isLocked = (model: Model): boolean => model.isSaving || !canManage(model)

// STEP CARDS

/** A destination's own mark (Slack, PagerDuty, email); a bell once the destination is gone. */
const destinationMedia = (h: H, model: Model, id: AlertDestinationId): Html =>
	Option.match(
		Option.flatMap(
			Arr.findFirst(model.destinations ?? [], (row) => row.id === id),
			rowToAlertDestinationDocument,
		),
		{
			onNone: () => icon(h, "BellIcon", { size: 14, className: "shrink-0 text-muted-foreground" }),
			onSome: (destination) =>
				providerLogo(h, {
					type: destination.type,
					chatConnector: destination.chatConnector ?? undefined,
					size: 30,
					isBare: true,
					className: hstackClass({ className: "shrink-0" }),
					isLogoBroken: model.brokenLogos.includes(destination.type),
					onLogoError: Message.FailedLoadProviderLogo({ type: destination.type }),
				}),
		},
	)

/** Who a schedule pages right now, once the schedules have loaded. */
const onCallNote = (model: Model, scheduleId: string): string | undefined =>
	Option.getOrUndefined(
		Option.map(
			Arr.findFirst(model.schedules ?? [], (schedule) => schedule.id === scheduleId),
			(schedule) =>
				schedule.on_call_now === null
					? "nobody on call"
					: `${personName(model, schedule.on_call_now.user_id)} on call`,
		),
	)

/** A picked target's chip: a destination's logo, a member's avatar, a schedule's calendar. */
const targetChip = (
	h: H,
	model: Model,
	key: string,
	index: number,
	target: V2EscalationTarget,
): PickedChip<Message> => {
	const onRemove = Message.ClickedRemoveTarget({ key, target: targetKey(target) })
	// The step is named: the same target may sit on several steps.
	const onStep = `on step ${index + 1}`
	switch (target.type) {
		case "destination": {
			const name = nameOr(model.destinations, target.destination_id, "Destination")
			return {
				key: targetKey(target),
				label: name,
				media: destinationMedia(h, model, target.destination_id),
				removeLabel: `Stop notifying ${name} ${onStep}`,
				onRemove,
			}
		}
		case "user": {
			const name = personName(model, target.user_id)
			return {
				key: targetKey(target),
				label: name,
				media: personAvatar(h, {
					name,
					size: "xs",
					imageUrl: Option.getOrUndefined(
						Option.map(memberOf(model.members, target.user_id), (member) => member.imageUrl),
					),
				}),
				removeLabel: `Stop paging ${name} ${onStep}`,
				onRemove,
			}
		}
		case "schedule": {
			const name = nameOr(model.schedules, target.schedule_id, "Schedule")
			const detail = onCallNote(model, target.schedule_id)
			return {
				key: targetKey(target),
				label: name,
				media: icon(h, "CalendarIcon", { size: 14, className: "shrink-0 text-muted-foreground" }),
				...(detail === undefined ? undefined : { detail }),
				removeLabel: `Stop paging ${name} ${onStep}`,
				onRemove,
			}
		}
	}
}

/** The picker with nothing to offer: where a destination is made (in its own tab, keeping the draft). */
const nothingToAdd = (h: H, model: Model): Html =>
	h.div(
		[h.Class("px-2 py-1.5")],
		[
			typography(h, { size: "xs", tone: "muted", as: "p" }, [
				(model.destinations ?? []).length === 0
					? "No destinations yet. "
					: "Everything is on this step already. ",
				textLink(h, { href: routingTabHref(), attributes: [h.Target("_blank"), h.Rel("noopener")] }, [
					"Create a destination",
				]),
			]),
		],
	)

const loadingEntry = (label: string): MenuEntry => ({ _tag: "Label", label })

/** The target picker: destinations, people and schedules not yet on the step, by kind. */
const addEntries = (h: H, model: Model, step: StepDraft): ReadonlyArray<MenuEntry> => {
	const picked = new Set(Arr.map(step.targets, targetKey))
	const group = (
		groupLabel: string,
		items: ReadonlyArray<Readonly<{ value: string; label: string }>>,
	): ReadonlyArray<MenuEntry> => {
		const open = Arr.filter(items, (item) => !picked.has(item.value))
		return open.length === 0
			? []
			: [
					{
						_tag: "Group",
						label: groupLabel,
						entries: Arr.map(open, (item): MenuEntry => ({ _tag: "Item", ...item })),
					},
				]
	}
	const entries: ReadonlyArray<MenuEntry> = [
		...(model.destinations === null
			? [loadingEntry("Loading destinations")]
			: group(
					"Destinations",
					Arr.map(model.destinations, (row) => ({
						value: `destination:${row.id}`,
						label: row.name,
					})),
				)),
		...(model.members === null
			? [loadingEntry(model.isMembersFailed ? "People could not be loaded" : "Loading people")]
			: group(
					"People",
					Arr.map(model.members, (member) => ({
						value: `user:${member.userId}`,
						label: member.name,
					})),
				)),
		...(model.schedules === null
			? [loadingEntry(model.isSchedulesFailed ? "Schedules could not be loaded" : "Loading schedules")]
			: group(
					"Whoever is on call on",
					Arr.map(model.schedules, (schedule) => ({
						value: `schedule:${schedule.id}`,
						label: schedule.name,
					})),
				)),
	]
	return entries.length === 0 ? [{ _tag: "Content", content: nothingToAdd(h, model) }] : entries
}

const stepActions = (model: Model, index: number): ReadonlyArray<MenuEntry> => {
	const count = model.form.steps.length
	return [
		{ _tag: "Item", value: "up", label: "Move up", icon: "ArrowUpIcon", isDisabled: index === 0 },
		{
			_tag: "Item",
			value: "down",
			label: "Move down",
			icon: "ArrowDownIcon",
			isDisabled: index === count - 1,
		},
		{
			_tag: "Item",
			value: "duplicate",
			label: "Duplicate",
			icon: "CopyIcon",
			isDisabled: !canAddStep(model.form),
		},
		{ _tag: "Separator" },
		{
			_tag: "Item",
			value: "remove",
			label: "Remove",
			icon: "TrashIcon",
			variant: "destructive",
			isDisabled: count === 1,
		},
	]
}

/** What follows a step's wait: the next step, another pass, or nothing once the chain stops. */
const waitTail = (model: Model, index: number): string => {
	if (index < model.form.steps.length - 1) return "minutes for an acknowledgement"
	return (numberOf(model.form.repeatCount) ?? 0) > 0
		? "minutes for an acknowledgement, then repeat"
		: "minutes, then stop"
}

const stepCard = (h: H, model: Model, step: StepDraft, index: number): Html => {
	const key = step.key
	const wait = waitError(step.waitMinutes)
	const targetsMenuId = menuIdOf("targets", key)
	const actionsMenuId = menuIdOf("actions", key)
	const waitId = `escalation-chain-wait-${key}`
	const shownWait = shown(model, wait, isOutOfRange(step.waitMinutes, wait))
	const waitState = stateOf(step.waitMinutes, Option.isSome(shownWait))
	return panel(h, { padded: "sm", className: "gap-2", attributes: [h.Key(key)] }, [
		hstack(h, { gap: "2", align: "start" }, [
			hstack(h, { gap: "1.5", wrap: true, grow: true, shrink: true, className: "min-h-7" }, [
				typography(h, { size: "sm", weight: "medium", className: "mr-0.5" }, [
					index === 0 ? "Notify" : "Then notify",
				]),
				...pickChips(h, {
					entries: Arr.map(step.targets, (target) => targetChip(h, model, key, index, target)),
					menu: model.menus[targetsMenuId] ?? Menu.init(targetsMenuId),
					toMenuMessage: (message) => Message.GotMenuMessage({ kind: "targets", key, message }),
					addEntries: addEntries(h, model, step),
					addLabel: "Add destination, person or schedule",
					addAriaLabel: `Add destination, person or schedule to step ${index + 1}`,
					isDisabled: model.isSaving,
					isReadOnly: !canManage(model),
					emptyText: "nobody",
				}),
			]),
			...(canManage(model)
				? [
						rowActionsMenu(h, {
							slotId: actionsMenuId,
							model: model.menus[actionsMenuId] ?? Menu.init(actionsMenuId),
							entries: stepActions(model, index),
							label: `Actions for step ${index + 1}`,
							toParentMessage: (message) =>
								Message.GotMenuMessage({ kind: "actions", key, message }),
						}),
					]
				: []),
		]),
		...errorText(h, shown(model, targetsError(step.targets))),
		hstack(h, { gap: "2", wrap: true }, [
			fieldLabel(h, { ids: idsOf(waitId), state: waitState, className: "font-normal" }, "then wait"),
			input(h, {
				ids: idsOf(waitId),
				state: waitState,
				className: "w-20",
				isDisabled: isLocked(model),
				attributes: [
					h.Type("number"),
					h.Min("1"),
					h.Attribute("max", String(MAX_ESCALATION_WAIT_MINUTES)),
					h.Attribute("step", "1"),
					h.AriaLabel(`Step ${index + 1} wait, in minutes`),
					h.Value(step.waitMinutes),
					h.OnInput((value) => Message.ChangedWait({ key, value })),
				],
			}),
			typography(h, { size: "sm" }, [waitTail(model, index)]),
		]),
		...errorText(h, shownWait),
	])
}

/** The line between two cards; while a step can be added, an editor gets a + on it that adds one there. */
const connector = (h: H, model: Model, index: number): Html => {
	const count = model.form.steps.length
	return chainConnector(h, {
		attributes: [h.Key(`connector-${index}`)],
		insert:
			canManage(model) && !model.isSaving && canAddStep(model.form)
				? {
						id: insertButtonId(index),
						label:
							index === 0
								? "Add a step at the start"
								: index === count
									? "Add a step at the end"
									: `Add a step after step ${index}`,
						onClick: Message.ClickedInsertStep({ index }),
						isPinned: index === count,
					}
				: null,
	})
}

const startCard = (h: H): Html =>
	panel(h, { padded: "sm", tone: "muted" }, [
		hstack(h, { gap: "2" }, [
			icon(h, "BellIcon", { size: 16, className: "shrink-0 text-muted-foreground" }),
			typography(h, { size: "sm" }, ["When an alert escalates to this chain"]),
		]),
	])

const endCard = (h: H, model: Model): Html => {
	const repeat = repeatError(model.form.repeatCount)
	const count = numberOf(model.form.repeatCount) ?? 0
	const id = "escalation-chain-repeat"
	const shownRepeat = shown(model, repeat, isOutOfRange(model.form.repeatCount, repeat))
	const state = stateOf(model.form.repeatCount, Option.isSome(shownRepeat))
	return panel(h, { padded: "sm", tone: "muted", className: "gap-2" }, [
		hstack(h, { gap: "2" }, [
			icon(h, "ArrowPathIcon", { size: 16, className: "shrink-0 text-muted-foreground" }),
			hstack(h, { gap: "2", wrap: true, shrink: true }, [
				fieldLabel(
					h,
					{ ids: idsOf(id), state, className: "font-normal" },
					"If nobody acknowledges, repeat the chain",
				),
				input(h, {
					ids: idsOf(id),
					state,
					className: "w-16",
					isDisabled: isLocked(model),
					attributes: [
						h.Type("number"),
						h.Min("0"),
						h.Attribute("max", String(MAX_ESCALATION_REPEATS)),
						h.Attribute("step", "1"),
						h.Value(model.form.repeatCount),
						h.OnInput((value) => Message.ChangedRepeatCount({ value })),
					],
				}),
				typography(h, { size: "sm" }, [count === 0 ? "times, then stop" : pluralize(count, "time")]),
			]),
		]),
		...errorText(h, shownRepeat),
	])
}

const chainColumn = (h: H, model: Model): Html =>
	vstack(h, { className: "min-w-0" }, [
		startCard(h),
		...Arr.flatMap(model.form.steps, (step, index) => [
			connector(h, model, index),
			stepCard(h, model, step, index),
		]),
		connector(h, model, model.form.steps.length),
		endCard(h, model),
		...errorText(h, shown(model, stepsError(model.form.steps))),
		...(canManage(model) && !canAddStep(model.form)
			? [
					typography(h, { size: "xs", tone: "muted", as: "p", className: "mt-2" }, [
						`A chain has at most ${MAX_ESCALATION_STEPS} steps`,
					]),
				]
			: []),
	])

// ASIDE

const destinationName =
	(model: Model) =>
	(id: AlertDestinationId): string =>
		nameOr(model.destinations, id, "Destination")

/** The chain in one line, as it reads on the Routing section and in the rule editor. */
const preview = (h: H, model: Model): Html => {
	const chain = previewOf(model.form)
	const summary =
		chain.steps.length === 0
			? "Pick who the first step pages to see the chain in one line."
			: chainSummary(chain, destinationName(model), {
					userName: (id) => personName(model, id),
					scheduleName: (id) =>
						model.schedules === null ? undefined : nameOr(model.schedules, id, "Schedule"),
				})
	return vstack(h, { gap: "1.5" }, [
		typography(h, { size: "xs", tone: "muted", weight: "medium" }, ["Preview"]),
		typography(h, { size: "sm", as: "p", className: "break-words" }, [summary]),
	])
}

/** Name, notes and the one-line preview. */
const details = (h: H, model: Model): Html => {
	const name = shown(model, nameError(model.form.name))
	const description = shown(model, descriptionError(model.form.description))
	const nameState = stateOf(model.form.name, Option.isSome(name))
	const notesIds = idsOf("escalation-chain-description")
	return panel(h, { padded: "sm", className: "order-first gap-4 lg:order-none" }, [
		vstack(h, { gap: "1.5" }, [
			fieldLabel(h, { ids: idsOf("escalation-chain-name"), state: nameState }, "Name"),
			input(h, {
				ids: idsOf("escalation-chain-name"),
				state: nameState,
				isDisabled: isLocked(model),
				attributes: [
					h.Value(model.form.name),
					h.Placeholder("Checkout on-call"),
					h.Attribute("autocomplete", "off"),
					h.OnInput((value) => Message.ChangedName({ value })),
				],
			}),
			...errorText(h, name),
		]),
		vstack(h, { gap: "1.5" }, [
			fieldLabel(
				h,
				{ ids: notesIds, state: stateOf(model.form.description, Option.isSome(description)) },
				"Notes",
			),
			textarea(h, {
				id: notesIds.control,
				defaultValue: model.form.description,
				isDisabled: isLocked(model),
				attributes: [
					// Uncontrolled: keyed on the chain, so a loaded chain rebuilds it with its text.
					h.Key(`escalation-chain-description-${model.editingId ?? "new"}`),
					h.AriaLabelledBy(notesIds.label),
					h.Placeholder("Optional: who is on this chain and when to change it"),
					h.Rows(2),
					h.OnInput((value) => Message.ChangedDescription({ value })),
				],
			}),
			...errorText(h, description),
		]),
		preview(h, model),
	])
}

/** The rules whose tiers start this chain, as links; ones not synced yet are counted. */
const usedBy = (h: H, model: Model): ReadonlyArray<Html> =>
	Option.match(AsyncData.getData(model.existing.data), {
		onNone: () => [],
		onSome: (chain) => {
			const ruleIds = chain.rule_ids
			const rules = Arr.filter(model.rules ?? [], (rule) => Arr.some(ruleIds, (id) => id === rule.id))
			const others = ruleIds.length - rules.length
			return [
				vstack(h, { gap: "1.5" }, [
					typography(h, { size: "xs", tone: "muted", weight: "medium" }, [
						ruleIds.length === 0
							? "Not used by any rule"
							: `Used by ${ruleIds.length} ${pluralize(ruleIds.length, "rule")}`,
					]),
					...(ruleIds.length === 0
						? []
						: [
								h.ul(
									[h.Class("space-y-1")],
									[
										...Arr.map(rules, (rule) =>
											h.li(
												[h.Key(rule.id)],
												[
													typography(h, { size: "sm" }, [
														textLink(h, { href: ruleHref(rule.id) }, [rule.name]),
													]),
													// A paused rule starts no chain until it is resumed.
													...(rule.enabled
														? []
														: [
																typography(h, { size: "xs", tone: "muted" }, [
																	" · paused",
																]),
															]),
												],
											),
										),
										...(others > 0
											? [
													h.li(
														[],
														[
															typography(h, { size: "sm", tone: "muted" }, [
																`and ${others} more`,
															]),
														],
													),
												]
											: []),
									],
								),
							]),
				]),
			]
		},
	})

/** Under the details: who uses the chain, and its quiet Delete. */
const meta = (h: H, model: Model): ReadonlyArray<Html> => {
	const rows = [
		...usedBy(h, model),
		...(model.editingId !== null && canManage(model)
			? [
					button(
						h,
						{
							variant: "destructive-ghost",
							size: "sm",
							className: "-ml-2 self-start",
							isDisabled: model.isSaving || model.isDeleting,
							attributes: [h.OnClick(Message.ClickedDelete())],
						},
						[icon(h, "TrashIcon"), "Delete chain"],
					),
				]
			: []),
	]
	return rows.length === 0 ? [] : [vstack(h, { gap: "3", className: "px-1" }, rows)]
}

// Below `lg` the aside dissolves into the grid: the details lead, the chain follows, then the rest.
const aside = (h: H, model: Model): Html =>
	h.aside(
		[h.Class("contents lg:sticky lg:top-0 lg:block lg:space-y-4")],
		[details(h, model), ...meta(h, model)],
	)

/** "Delete {chain}?": lists the rules that start it, which the API makes move off it first. */
const deleteDialog = (h: H, model: Model): Html => {
	const confirm = chainDeleteConfirm(h, AsyncData.getData(model.existing.data), model.rules)
	return confirmDialog(h, {
		slotId: DELETE_DIALOG_ID,
		model: model.deleteDialog,
		toParentMessage: (message) => Message.GotDeleteDialogMessage({ message }),
		title: `Delete ${chainTitle(model)}?`,
		description: confirm.description,
		children: [
			...confirm.ruleList,
			...(model.deleteError === null
				? []
				: [
						alert(h, { variant: "crit", size: "sm" }, [
							icon(h, "CircleXmarkIcon"),
							alertTitle(h, ["Couldn't delete chain"]),
							alertDescription(h, [model.deleteError]),
						]),
					]),
		],
		confirmLabel: "Delete chain",
		isPending: model.isDeleting,
		isConfirmDisabled: confirm.isInUse,
		onConfirm: Message.ClickedConfirmDelete(),
	})
}

/** "Unsaved changes": a link, Back or Cancel held while the form has edits. */
const leaveDialog = (h: H, model: Model): Html =>
	confirmDialog(h, {
		slotId: LEAVE_DIALOG_ID,
		model: model.leaveDialog,
		toParentMessage: (message) => Message.GotLeaveDialogMessage({ message }),
		title: "Unsaved changes",
		description: "This chain has changes you have not saved. Leave without saving them?",
		cancelLabel: "Stay",
		confirmLabel: "Discard changes",
		onConfirm: Message.ClickedDiscard(),
	})

// PAGE

const actions = (h: H, model: Model): Html =>
	canManage(model)
		? hstack(h, { gap: "2" }, [
				button(h, { variant: "outline", attributes: [h.OnClick(Message.ClickedCancel())] }, [
					"Cancel",
				]),
				button(h, { isLoading: model.isSaving, attributes: [h.OnClick(Message.ClickedSave())] }, [
					model.editingId === null ? "Create chain" : "Save chain",
				]),
			])
		: linkButton(h, { variant: "outline", href: backHref() }, ["Back to routing"])

const notices = (h: H, model: Model): ReadonlyArray<Html> => [
	...(canManage(model)
		? []
		: [
				alert(h, { variant: "info", size: "sm" }, [
					icon(h, "ShieldIcon"),
					alertTitle(h, ["Only org admins and engineers can change escalation chains"]),
				]),
			]),
	...(model.saveFailure === null
		? []
		: [
				alert(h, { variant: "crit", size: "sm" }, [
					icon(h, "CircleXmarkIcon"),
					alertTitle(h, [
						model.editingId === null ? "Couldn't create chain" : "Couldn't save chain",
					]),
					alertDescription(h, [
						model.saveFailure.code === CHAIN_NOT_FOUND_CODE
							? "This chain no longer exists. Someone deleted it while you were editing."
							: failureMessage(model.saveFailure),
					]),
				]),
			]),
	...(model.isShowingErrors && formIssues(model.form).length > 0
		? [
				typography(h, { size: "sm", tone: "destructive", as: "p", attributes: [h.Role("status")] }, [
					"Fix the highlighted fields to save the chain.",
				]),
			]
		: []),
]

const notFound = (h: H): Html =>
	resourceNotFound(h, {
		title: "Escalation chain not found",
		description: "It may have been deleted, or the link is wrong.",
		back: { href: backHref(), label: "Back to routing" },
	})

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, _inputs, h) => {
	const isEdit = model.editingId !== null
	const header = {
		title: chainTitle(model),
		description:
			"Page step by step until someone acknowledges. Acknowledging pauses it, resolving ends it.",
	}
	const loading = dashboardPage(h, header, [skeleton(h, "h-24 w-full"), skeleton(h, "h-80 w-full")])
	if (model.isBadId) return dashboardPage(h, header, [notFound(h)])
	if (!model.isSessionLoaded) return loading
	// Nothing to read on a new chain: a viewer who cannot create one is told who can.
	if (!isEdit && !canManage(model))
		return managersOnlyPage(h, {
			header,
			title: "Only org admins and engineers can create escalation chains",
			back: { href: backHref(), label: "Back to routing" },
		})
	if (isEdit && AsyncData.isFailure(model.existing.data))
		return dashboardPage(h, header, [
			model.existing.data.error.code === CHAIN_NOT_FOUND_CODE
				? notFound(h)
				: errorState(h, {
						failure: model.existing.data.error,
						title: "Couldn't load the chain",
						onRetry: Message.ClickedRetryExisting(),
					}),
		])
	if (isEdit && Option.isNone(AsyncData.getData(model.existing.data))) return loading
	return dashboardPage(h, { ...header, actions: actions(h, model) }, [
		vstack(h, { gap: "4" }, [
			...notices(h, model),
			h.div(
				[h.Class("grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start")],
				[chainColumn(h, model), aside(h, model)],
			),
		]),
		deleteDialog(h, model),
		leaveDialog(h, model),
	])
})
