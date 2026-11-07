import type { V2OnCallOverride, V2OnCallSchedule, V2OnCallShift, V2OnCallShifts } from "@maple/domain/http/v2"
import { Option, Array as Arr } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { borderedBox } from "@maple/views/ui/bordered-box"
import { button, linkButton } from "@maple/views/ui/button"
import { confirmDialog } from "@maple/views/ui/confirm-dialog"
import { errorState } from "@maple/views/ui/error-state"
import { fieldErrorText } from "@maple/views/ui/field"
import { formDialog } from "@maple/views/ui/form-dialog"
import { icon } from "@maple/views/ui/icon"
import { iconButton } from "@maple/views/ui/icon-button"
import { input } from "@maple/views/ui/input"
import { label } from "@maple/views/ui/label"
import { nativeOption, nativeSelect } from "@maple/views/ui/native-select"
import { personLabel } from "@maple/views/ui/person-avatar"
import { shiftTimeline, type TimelineBar, type TimelineRow } from "@maple/views/ui/shift-timeline"
import { skeleton } from "@maple/views/ui/skeleton"
import { hstack, vstack } from "@maple/views/ui/stack"
import { typography, typographyClass } from "@maple/views/ui/typography"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { detailActions, detailTitle, detailTitleSkeleton } from "../../kit/detail-header"
import { resourceNotFound } from "../../kit/resource-not-found"
import { sectionHeading } from "../../kit/section-heading"
import { editScheduleHref, formatShiftEdge, oncallTabHref } from "../shared/oncall-schedules"
import { memberName, memberOf, type OrgMember } from "../shared/org-members"
import { Message } from "./message"
import { canManage, type Model } from "./model"
import {
	DELETE_OVERRIDE_DIALOG_ID,
	OVERRIDE_DIALOG_ID,
	overrideIssue,
	overridesOf,
	rangeOf,
	readRangeOf,
	scheduleOf,
} from "./update"
import { isoMs } from "../shared/time"

// `/alerts/schedules/$scheduleId`: who is on call now, the week's calendar (each layer and the
// final row with its overrides), the upcoming overrides, and the dialog that adds one.

type H = HtmlBuilder<Message>

const imageOf = (members: ReadonlyArray<OrgMember> | null, userId: string) =>
	Option.getOrUndefined(Option.map(memberOf(members, userId), (member) => member.imageUrl))

const rangeText = (startMs: number, endMs: number, timeZone: string) =>
	`${formatShiftEdge(startMs, timeZone)} to ${formatShiftEdge(endMs, timeZone)}`

const onCallLine = (model: Model, schedule: V2OnCallSchedule): string =>
	Option.match(Option.fromNullishOr(schedule.on_call_now), {
		onNone: () => "Nobody is on call right now",
		onSome: (now) =>
			`${memberName(model.members, now.user_id)} is on call until ${formatShiftEdge(isoMs(now.ends_at), schedule.time_zone)}`,
	})

/** A shift as a bar: the person's name, and who and when in its tooltip. */
const barOf = (
	model: Model,
	schedule: V2OnCallSchedule,
	shift: V2OnCallShift,
	key: string,
	isFinal: boolean,
): TimelineBar<Message> => {
	const startMs = isoMs(shift.starts_at)
	const endMs = isoMs(shift.ends_at)
	const name = memberName(model.members, shift.user_id)
	const isOverride = shift.source.kind === "override"
	const bar: TimelineBar<Message> = {
		key,
		startMs,
		endMs,
		label: name,
		title: `${isOverride ? "Override: " : ""}${name}, ${rangeText(startMs, endMs, schedule.time_zone)}`,
		tone: isOverride ? "info" : isFinal ? "primary" : "neutral",
	}
	// Only a final shift that has not ended opens an override, and only for someone who may add one.
	return isFinal && canManage(model) && endMs > (model.nowMs ?? 0)
		? { ...bar, onClick: Message.ClickedShift({ startMs, endMs }) }
		: bar
}

/** The final row on top, then the layers from the top one down, as they stack. */
const timelineRows = (
	model: Model,
	schedule: V2OnCallSchedule,
	shifts: V2OnCallShifts,
): ReadonlyArray<TimelineRow<Message>> => [
	{
		key: "final",
		label: "Final schedule",
		detail: "Who gets paged",
		bars: Arr.map(shifts.final, (shift, index) => barOf(model, schedule, shift, `final-${index}`, true)),
		emptyText: "Nobody on call in this range",
	},
	...Arr.reverse(
		Arr.map(schedule.layers, (layer, index): TimelineRow<Message> => ({
			key: `layer-${index}`,
			label: layer.name,
			detail: `Layer ${index + 1}`,
			bars: Arr.map(shifts.layers[index] ?? [], (shift, at) =>
				barOf(model, schedule, shift, `layer-${index}-${at}`, false),
			),
			emptyText: "Not active in this range",
		})),
	),
]

/** "10 Nov to 16 Nov": the first and last day the calendar shows. */
const weekLabel = (fromMs: number, toMs: number, timeZone: string): string => {
	const day = new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short" })
	return `${day.format(fromMs)} to ${day.format(toMs - 1)}`
}

/** The calendar's header: the week, prev/this week/next, and which zone the times read in. */
const calendarSection = (h: H, model: Model, schedule: V2OnCallSchedule, viewerZone: string): Html => {
	const range = rangeOf(model)
	const nowMs = model.nowMs ?? 0
	// Shifts kept from another week (a week's read still in flight) draw as the skeleton, not blank rows.
	const timeline = (fromMs: number, toMs: number, shifts: V2OnCallShifts): Html =>
		!Option.exists(readRangeOf(model), (read) => isoMs(shifts.from) === read.fromMs)
			? skeleton(h, "h-40 w-full")
			: shiftTimeline(h, {
					fromMs,
					toMs,
					timeZone: schedule.time_zone,
					nowMs,
					rows: timelineRows(model, schedule, shifts),
					ariaLabel: `Shifts for ${schedule.name}`,
					nowLabel: `Now, ${formatShiftEdge(nowMs, schedule.time_zone)}`,
					legend: [
						{ tone: "primary", label: "On call" },
						{ tone: "info", label: "Override" },
						{ tone: "neutral", label: "Layer shift" },
					],
				})
	const body = Option.match(range, {
		onNone: () => skeleton(h, "h-40 w-full"),
		onSome: ({ fromMs, toMs }) =>
			AsyncData.match(model.shifts.data, {
				onIdle: () => skeleton(h, "h-40 w-full"),
				onLoading: () => skeleton(h, "h-40 w-full"),
				onFailure: (failure) =>
					errorState(h, {
						failure,
						title: "Couldn't load the shifts",
						onRetry: Message.ClickedRetryShifts(),
					}),
				onRefreshing: (shifts) => timeline(fromMs, toMs, shifts),
				onStale: ({ data }) => timeline(fromMs, toMs, data),
				onSuccess: (shifts) => timeline(fromMs, toMs, shifts),
			}),
	})
	const zoneNote =
		viewerZone === schedule.time_zone
			? `Times in ${schedule.time_zone}.`
			: `Times in ${schedule.time_zone}. Yours is ${viewerZone}.`
	return h.section(
		[h.Class("space-y-3")],
		[
			sectionHeading(h, {
				title: Option.match(range, {
					onNone: () => "This week",
					onSome: ({ fromMs, toMs }) => weekLabel(fromMs, toMs, schedule.time_zone),
				}),
				actions: hstack(h, { gap: "1" }, [
					iconButton(
						h,
						{ label: "Previous week", attributes: [h.OnClick(Message.ClickedPreviousWeek())] },
						[icon(h, "ChevronLeftIcon")],
					),
					button(
						h,
						{
							size: "sm",
							variant: "outline",
							isDisabled: model.weekOffset === 0,
							attributes: [h.OnClick(Message.ClickedThisWeek())],
						},
						["Today"],
					),
					iconButton(
						h,
						{ label: "Next week", attributes: [h.OnClick(Message.ClickedNextWeek())] },
						[icon(h, "ChevronRightIcon")],
					),
				]),
			}),
			typography(h, { size: "xs", tone: "muted", as: "p" }, [
				zoneNote,
				...(canManage(model) ? [" Pick a shift in the final row to cover it with an override."] : []),
			]),
			body,
		],
	)
}

const overrideRow = (h: H, model: Model, schedule: V2OnCallSchedule, override: V2OnCallOverride): Html => {
	const name = memberName(model.members, override.user_id)
	return h.li(
		[h.Key(override.id), h.Class("px-4 py-3")],
		[
			hstack(h, { gap: "3", justify: "between" }, [
				personLabel(h, {
					name,
					imageUrl: imageOf(model.members, override.user_id),
					detail: rangeText(isoMs(override.starts_at), isoMs(override.ends_at), schedule.time_zone),
				}),
				...(canManage(model)
					? [
							iconButton(
								h,
								{
									label: `Delete ${name}'s override, ${rangeText(isoMs(override.starts_at), isoMs(override.ends_at), schedule.time_zone)}`,
									isDisabled: model.deletingOverrideId === override.id,
									className: "text-muted-foreground",
									attributes: [
										h.OnClick(Message.ClickedDeleteOverride({ overrideId: override.id })),
									],
								},
								[icon(h, "TrashIcon")],
							),
						]
					: []),
			]),
		],
	)
}

const overridesSection = (h: H, model: Model, schedule: V2OnCallSchedule): Html => {
	const overrides = overridesOf(model)
	return h.section(
		[h.Class("space-y-3")],
		[
			sectionHeading(h, { title: "Upcoming overrides" }),
			AsyncData.isFailure(model.overrides.data)
				? errorState(h, {
						failure: model.overrides.data.error,
						title: "Couldn't load the overrides",
						onRetry: Message.ClickedRetryOverrides(),
					})
				: overrides.length === 0
					? typography(h, { size: "sm", tone: "muted", as: "p" }, [
							AsyncData.isLoading(model.overrides.data)
								? "Loading overrides…"
								: "No overrides. One puts a person on call for a time range, over every layer.",
						])
					: borderedBox(h, { overflow: "hidden" }, [
							h.ul(
								[h.Class("divide-y")],
								Arr.map(overrides, (override) => overrideRow(h, model, schedule, override)),
							),
						]),
		],
	)
}

const dialogField = (h: H, id: string, text: string, control: Html): Html =>
	vstack(h, { gap: "1.5" }, [
		label(h, { className: typographyClass({ size: "xs", tone: "muted" }), attributes: [h.For(id)] }, [
			text,
		]),
		control,
	])

/** "Add override": who covers, from when to when on the schedule's clock. */
const overrideDialog = (h: H, model: Model, schedule: V2OnCallSchedule): Html => {
	const issue = overrideIssue(model.overrideDraft, schedule.time_zone, model.nowMs ?? 0)
	const id = OVERRIDE_DIALOG_ID
	return formDialog(h, {
		slotId: `${id}-dialog`,
		model: model.overrideDialog,
		toParentMessage: (message) => Message.GotOverrideDialogMessage({ message }),
		title: "Add override",
		description: `Put one person on call for a time range, over every layer. Times in ${schedule.time_zone}.`,
		panelClassName: "space-y-4",
		fields: [
			dialogField(
				h,
				`${id}-person`,
				"Who covers",
				nativeSelect(
					h,
					{
						defaultValue: model.overrideDraft.userId,
						className: "w-full",
						isDisabled: model.isMembersFailed,
						attributes: [
							h.Key(`${id}-person-${model.overrideOpenCount}-${(model.members ?? []).length}`),
							h.Id(`${id}-person`),
							h.OnChange((value) => Message.ChangedOverrideUser({ value })),
						],
					},
					[
						nativeOption(
							"",
							model.isMembersFailed
								? "Couldn't load members, try reloading the page"
								: "Pick a person",
						),
						...Arr.map(model.members ?? [], (member) => nativeOption(member.userId, member.name)),
					],
				),
			),
			hstack(h, { gap: "3", wrap: true }, [
				dialogField(
					h,
					`${id}-start`,
					"From",
					input(h, {
						id: `${id}-start`,
						type: "datetime-local",
						attributes: [
							h.Value(model.overrideDraft.startsAt),
							h.OnInput((value) => Message.ChangedOverrideStart({ value })),
						],
					}),
				),
				dialogField(
					h,
					`${id}-end`,
					"To",
					input(h, {
						id: `${id}-end`,
						type: "datetime-local",
						attributes: [
							h.Value(model.overrideDraft.endsAt),
							h.OnInput((value) => Message.ChangedOverrideEnd({ value })),
						],
					}),
				),
			]),
			...(model.isShowingOverrideErrors
				? Option.match(issue, {
						onNone: () => [],
						onSome: (text) => [fieldErrorText(h, { attributes: [h.Role("alert")] }, text)],
					})
				: []),
			...(model.overrideError === null
				? []
				: [
						alert(h, { variant: "crit", size: "sm" }, [
							icon(h, "CircleXmarkIcon"),
							alertTitle(h, ["Couldn't create the override"]),
							alertDescription(h, [model.overrideError]),
						]),
					]),
		],
		onSubmit: Message.ClickedCreateOverride(),
		submitLabel: "Add override",
		isPending: model.isCreatingOverride,
	})
}

/** "Delete {person}'s override?": the layers decide that window again. */
const deleteOverrideDialog = (h: H, model: Model, schedule: V2OnCallSchedule): Html => {
	const target = Arr.findFirst(
		overridesOf(model),
		(override) => override.id === model.confirmDeleteOverrideId,
	)
	const name = Option.getOrElse(
		Option.map(target, (override) => `${memberName(model.members, override.user_id)}'s override`),
		() => "this override",
	)
	return confirmDialog(h, {
		slotId: DELETE_OVERRIDE_DIALOG_ID,
		model: model.deleteOverrideDialog,
		toParentMessage: (message) => Message.GotDeleteOverrideDialogMessage({ message }),
		title: `Delete ${name}?`,
		description: Option.match(target, {
			onNone: () => "The layers decide who is on call again.",
			onSome: (override) =>
				`The layers decide who is on call again from ${rangeText(isoMs(override.starts_at), isoMs(override.ends_at), schedule.time_zone)}.`,
		}),
		confirmLabel: "Delete override",
		isPending: model.deletingOverrideId !== null,
		onConfirm: Message.ClickedConfirmDeleteOverride(),
	})
}

const page = (h: H, model: Model, viewerZone: string): Html => {
	const notFound = dashboardPage(h, {}, [
		resourceNotFound(h, {
			title: "Schedule not found",
			description: "It may have been deleted, or the link is stale.",
			back: { href: oncallTabHref(), label: "Back to on-call" },
		}),
	])
	if (model.scheduleId === null) return notFound
	const data = model.schedule.data
	if (AsyncData.isFailure(data))
		return data.error.code === "oncall_schedule_not_found"
			? notFound
			: dashboardPage(h, {}, [
					errorState(h, {
						failure: data.error,
						title: "Couldn't load the schedule",
						onRetry: Message.ClickedRetry(),
					}),
				])
	return Option.match(scheduleOf(model), {
		onNone: () =>
			dashboardPage(h, { titleContent: detailTitleSkeleton(h) }, [
				skeleton(h, "h-48 w-full"),
				skeleton(h, "h-24 w-full"),
			]),
		onSome: (schedule) =>
			h.div(
				[h.Class("contents")],
				[
					dashboardPage(
						h,
						{
							titleContent: detailTitle(h, {
								kind: ["On-call schedule", schedule.time_zone],
								title: [schedule.name],
								meta: [
									Option.match(Option.fromNullishOr(schedule.on_call_now), {
										onNone: () =>
											typography(h, { size: "sm", tone: "muted" }, [
												onCallLine(model, schedule),
											]),
										onSome: (now) =>
											personLabel(h, {
												name: memberName(model.members, now.user_id),
												imageUrl: imageOf(model.members, now.user_id),
												detail: `On call until ${formatShiftEdge(isoMs(now.ends_at), schedule.time_zone)}`,
											}),
									}),
								],
							}),
							actions: canManage(model)
								? detailActions(h, [
										linkButton(
											h,
											{
												size: "sm",
												variant: "outline",
												href: editScheduleHref(schedule.id),
											},
											[icon(h, "PencilIcon"), "Edit schedule"],
										),
										button(
											h,
											{
												size: "sm",
												attributes: [h.OnClick(Message.ClickedNewOverride())],
											},
											[icon(h, "PlusIcon"), "Add override"],
										),
									])
								: undefined,
							gap: "lg",
						},
						[
							calendarSection(h, model, schedule, viewerZone),
							overridesSection(h, model, schedule),
						],
					),
					overrideDialog(h, model, schedule),
					deleteOverrideDialog(h, model, schedule),
				],
			),
	})
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	page(h, model, inputs.context.timeZone),
)

/** The H1 names the schedule, so the trail stops at the tab. */
export const breadcrumbsOf = () => [
	{ label: "Alerts", href: "/alerts" },
	{ label: "On-call", href: oncallTabHref() },
]
