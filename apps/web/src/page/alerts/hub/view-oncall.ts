import type { V2OnCallSchedule } from "@maple/domain/http/v2"
import { pluralize } from "@maple/ui/lib/format"
import { Array as Arr, Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { borderedBox } from "@maple/views/ui/bordered-box"
import { linkButton } from "@maple/views/ui/button"
import { confirmDialog } from "@maple/views/ui/confirm-dialog"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon, rowIcon } from "@maple/views/ui/icon"
import * as Menu from "@maple/views/ui/menu"
import type { MenuEntry } from "@maple/views/ui/menu-view"
import { personLabel } from "@maple/views/ui/person-avatar"
import { rowActionsMenu } from "@maple/views/ui/row-actions-menu"
import { emptyActions } from "@maple/views/ui/signal-empty-state"
import { skeleton } from "@maple/views/ui/skeleton"
import { hstack, vstack } from "@maple/views/ui/stack"
import { textLink } from "@maple/views/ui/text-link"
import { typography } from "@maple/views/ui/typography"
import { sectionHeading } from "../../kit/section-heading"
import { formatShiftEdge, formatUntil, newScheduleHref, scheduleHref } from "../shared/oncall-schedules"
import { memberName, memberOf } from "../shared/org-members"
import { Message } from "./message"
import { canManage, type Model } from "./model"
import { DELETE_SCHEDULE_DIALOG_ID, scheduleMenuId } from "./update"
import { isoMs } from "../shared/time"
import { dividedList } from "@maple/views/ui/rule"

// The hub's On-call tab (each schedule with who is on call and the next handoff), the inbox's
// "On call now" strip, and the schedule delete confirmation.

type H = HtmlBuilder<Message>

/**
 * Who holds the schedule now, with when they hand off; "Nobody on call" in a gap. The handoff
 * reads on the schedule's clock, so `withZone` names it where the zone is not shown beside it.
 */
const onCallPerson = (h: H, model: Model, schedule: V2OnCallSchedule, withZone: boolean): Html =>
	Option.match(Option.fromNullishOr(schedule.on_call_now), {
		onNone: () =>
			hstack(h, { gap: "2" }, [
				icon(h, "UserIcon", { className: "text-foreground-subtle" }),
				typography(h, { size: "sm", tone: "muted", className: "whitespace-nowrap" }, [
					"Nobody on call",
				]),
			]),
		onSome: (now) =>
			personLabel(h, {
				name: memberName(model.members, now.user_id),
				imageUrl: Option.getOrUndefined(
					Option.map(memberOf(model.members, now.user_id), (member) => member.imageUrl),
				),
				detail: `until ${formatShiftEdge(isoMs(now.ends_at), schedule.time_zone)}${withZone ? ` ${schedule.time_zone}` : ""}`,
			}),
	})

const layerCount = (schedule: V2OnCallSchedule) =>
	`${schedule.layers.length} ${pluralize(schedule.layers.length, "layer")}`

/** `ScheduleRow`: name and zone, who is on call until when, the next handoff, and its actions. */
const scheduleRow = (h: H, model: Model, schedule: V2OnCallSchedule, nowMs: number): Html => {
	const menuId = scheduleMenuId(schedule.id)
	const entries: ReadonlyArray<MenuEntry> = [
		{ _tag: "Item", value: "edit", label: "Edit", icon: "PencilIcon" },
		{ _tag: "Separator" },
		{
			_tag: "Item",
			value: "delete",
			label: "Delete",
			icon: "TrashIcon",
			variant: "destructive",
			isDisabled: model.deletingScheduleId === schedule.id,
		},
	]
	const handoff = Option.match(Option.fromNullishOr(schedule.on_call_now), {
		onNone: () => "No one scheduled",
		onSome: (now) => `Hands off ${formatUntil(nowMs, isoMs(now.ends_at))}`,
	})
	return h.li(
		[h.Key(schedule.id), h.Class("px-4 py-3")],
		[
			hstack(h, { gap: "3", wrap: true }, [
				hstack(h, { gap: "3", align: "start", grow: true, shrink: true, className: "basis-60" }, [
					rowIcon(h, "CalendarIcon"),
					vstack(h, { gap: "0.5", shrink: true }, [
						textLink(
							h,
							{
								href: scheduleHref(schedule.id),
								tone: "muted",
								className: "min-w-0 text-foreground",
							},
							[
								typography(h, { size: "sm", weight: "medium", truncate: true }, [
									schedule.name,
								]),
							],
						),
						typography(h, { size: "xs", tone: "muted", truncate: true }, [
							`${schedule.time_zone} · ${layerCount(schedule)}`,
						]),
					]),
				]),
				hstack(h, { gap: "4", className: "w-full pl-7 sm:w-auto sm:pl-0" }, [
					h.div(
						[h.Class("min-w-0 flex-1 sm:w-56 sm:flex-none")],
						[onCallPerson(h, model, schedule, false)],
					),
					typography(
						h,
						{
							size: "xs",
							tone: "muted",
							numeric: true,
							className: "hidden shrink-0 whitespace-nowrap sm:inline sm:w-36",
						},
						[handoff],
					),
					...(canManage(model)
						? [
								rowActionsMenu(h, {
									slotId: menuId,
									model: model.menus[menuId] ?? Menu.init(menuId),
									entries,
									label: `Actions for ${schedule.name}`,
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

const schedulesEmpty = (h: H, model: Model): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "CalendarIcon", { size: 18 })]),
				emptyTitle(h, ["No on-call schedules"]),
				emptyDescription(h, [
					"A schedule says who is on call when: people take turns in layers that hand off daily, weekly or every few hours, and overrides cover swaps. Escalation chains page whoever is on call.",
					...(canManage(model) ? [] : [" Ask an org admin to create one."]),
				]),
			]),
			...(canManage(model)
				? [
						emptyActions(h, [
							linkButton(h, { size: "sm", href: newScheduleHref() }, [
								icon(h, "PlusIcon"),
								"Create schedule",
							]),
						]),
					]
				: []),
		],
		"py-12",
	)

const schedulesList = (h: H, model: Model, schedules: ReadonlyArray<V2OnCallSchedule>, nowMs: number): Html =>
	schedules.length === 0
		? schedulesEmpty(h, model)
		: borderedBox(h, { overflow: "hidden" }, [
				dividedList(
					h,
					{ as: "ul", bordered: false },
					Arr.map(schedules, (schedule) => scheduleRow(h, model, schedule, nowMs)),
				),
			])

const LOADING_ROWS = ["h-16 w-full", "h-16 w-full"]

/** The On-call tab: what schedules are, then the list, or its empty, loading or failed state. */
export const oncallTab = (h: H, model: Model, nowMs: number): Html => {
	const loading = vstack(
		h,
		{ gap: "3" },
		Arr.map(LOADING_ROWS, (row) => skeleton(h, row)),
	)
	return h.section(
		[h.Class("space-y-4")],
		[
			h.div(
				[],
				[
					sectionHeading(h, { title: "On-call schedules" }),
					typography(h, { size: "sm", tone: "muted", as: "p" }, [
						"Who is on call when. Later layers sit on top of earlier ones, and an override beats every layer.",
					]),
				],
			),
			AsyncData.match(model.schedules.data, {
				onIdle: () => loading,
				onLoading: () => loading,
				onFailure: (failure) =>
					errorState(h, {
						failure,
						title: "Couldn't load on-call schedules",
						onRetry: Message.ClickedRetrySchedules(),
					}),
				onRefreshing: (schedules) => schedulesList(h, model, schedules, nowMs),
				onStale: ({ data }) => schedulesList(h, model, data, nowMs),
				onSuccess: (schedules) => schedulesList(h, model, schedules, nowMs),
			}),
		],
	)
}

/** The org has a schedule: the header offers another. */
export const hasSchedules = (model: Model): boolean =>
	Option.exists(AsyncData.getData(model.schedules.data), (schedules) => schedules.length > 0)

const stripItem = (h: H, model: Model, schedule: V2OnCallSchedule): Html =>
	vstack(
		h,
		{ gap: "1", shrink: true, className: "min-w-44 flex-1 basis-56", attributes: [h.Key(schedule.id)] },
		[
			textLink(h, { href: scheduleHref(schedule.id), tone: "muted", className: "min-w-0" }, [
				typography(h, { size: "xs", truncate: true }, [schedule.name]),
			]),
			onCallPerson(h, model, schedule, true),
		],
	)

/** "On call now": each schedule's current person, atop the inbox; nothing without schedules. */
export const whoIsOnCallStrip = (h: H, model: Model): ReadonlyArray<Html> => {
	const schedules = Option.getOrElse(AsyncData.getData(model.schedules.data), () => [])
	return schedules.length === 0
		? []
		: [
				borderedBox(
					h,
					{ overflow: "hidden", as: "section", attributes: [h.AriaLabel("On call now")] },
					[
						vstack(h, { gap: "3", className: "p-4" }, [
							eyebrow(h, { as: "h2" }, ["On call now"]),
							hstack(
								h,
								{ gap: "6", wrap: true, align: "start", className: "gap-y-3" },
								Arr.map(schedules, (schedule) => stripItem(h, model, schedule)),
							),
						]),
					],
				),
			]
}

/** "Delete {schedule}?": the 409 that names the chains paging it stays in the dialog. */
export const deleteScheduleDialog = (h: H, model: Model): Html => {
	const name = Option.getOrElse(
		Option.map(
			Arr.findFirst(
				Option.getOrElse(AsyncData.getData(model.schedules.data), () => []),
				(schedule) => schedule.id === model.confirmDeleteScheduleId,
			),
			(schedule) => schedule.name,
		),
		() => "schedule",
	)
	return confirmDialog(h, {
		slotId: DELETE_SCHEDULE_DIALOG_ID,
		model: model.deleteScheduleDialog,
		toParentMessage: (message) => Message.GotDeleteScheduleDialogMessage({ message }),
		title: `Delete ${name}?`,
		description: "Its overrides go with it. This cannot be undone.",
		children:
			model.deleteScheduleError === null
				? undefined
				: [
						alert(h, { variant: "crit", size: "sm" }, [
							icon(h, "CircleXmarkIcon"),
							alertTitle(h, ["Couldn't delete schedule"]),
							alertDescription(h, [model.deleteScheduleError]),
						]),
					],
		confirmLabel: "Delete schedule",
		isPending: model.deletingScheduleId !== null,
		onConfirm: Message.ClickedConfirmDeleteSchedule(),
	})
}

/** The tab header's "New schedule", once one exists. */
export const newScheduleButton = (h: H): Html =>
	linkButton(h, { size: "sm", variant: "outline", href: newScheduleHref() }, [
		icon(h, "PlusIcon"),
		"New schedule",
	])
