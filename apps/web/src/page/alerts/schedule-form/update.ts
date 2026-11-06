import { UserId } from "@maple/domain/http"
import { Option, Result, Schema, Array as Arr } from "effect"
import { AsyncData, Command as FoldkitCommand } from "foldkit"
import * as Keyed from "@maple/views/data/keyed"
import { requestKey } from "@maple/views/data/request-key"
import * as Combobox from "@maple/views/ui/combobox"
import * as Menu from "@maple/views/ui/menu"
import type { AppRoute } from "../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { scheduleHref, scheduleIdFromUrl } from "../shared/oncall-schedules"
import {
	FetchExistingSchedule,
	FetchScheduleFormMembers,
	FetchScheduleFormSession,
	ReadScheduleFormDefaults,
	SaveSchedule,
} from "./command"
import {
	emptyForm,
	emptyLayer,
	emptyRestriction,
	type Form,
	formFromSchedule,
	type LayerDraft,
	MAX_ONCALL_LAYERS,
	MAX_ONCALL_RESTRICTIONS,
	payloadOf,
	type RestrictionDraft,
} from "./form"
import { type Direction, Message } from "./message"
import { canManage, type Model } from "./model"

type Return = PageReturn<Model, Message>
type FormRoute = Extract<AppRoute, { readonly _tag: "AlertsScheduleNew" }>

export const ZONE_PICKER_ID = "schedule-form-zone"

export const participantMenuId = (layerKey: string) => `schedule-form-people-${layerKey}`

export const init = (route: FormRoute, context: PageContext): Return => {
	const editingId = Option.getOrNull(
		Option.flatMap(Option.fromNullishOr(route.search.scheduleId), scheduleIdFromUrl),
	)
	const model: Model = {
		search: route.search,
		editingId,
		existing: Keyed.idle(),
		form: emptyForm("UTC", 0),
		isReady: false,
		nowMs: 0,
		zones: [],
		zonePicker: Combobox.init(ZONE_PICKER_ID, "single", { selected: ["UTC"] }),
		members: null,
		membersError: null,
		menus: {},
		isSaving: false,
		isShowingErrors: false,
		saveFailure: null,
		grants: [],
		isSessionLoaded: false,
	}
	const common = [
		ReadScheduleFormDefaults(),
		FetchScheduleFormMembers(),
		FetchScheduleFormSession({ orgId: context.orgId }),
	]
	if (editingId === null) return { model, commands: common }
	const key = requestKey(context.orgId, "oncallSchedules.retrieve", { id: editingId })
	return Option.match(Keyed.request(model.existing, key, "Load"), {
		onNone: () => ({ model, commands: common }),
		onSome: (existing) => ({
			model: { ...model, existing },
			commands: [...common, FetchExistingSchedule({ key, scheduleId: editingId })],
		}),
	})
}

const withForm = (model: Model, form: Form): Return => ({ model: { ...model, form } })

/** The zone picker reads the form's zone again (a load, a new default). */
const syncZone = (model: Model): Model => ({
	...model,
	zonePicker: Combobox.init(ZONE_PICKER_ID, "single", { selected: [model.form.timeZone] }),
})

const editLayer = (model: Model, key: string, edit: (layer: LayerDraft) => LayerDraft): Return =>
	withForm(model, {
		...model.form,
		layers: Arr.map(model.form.layers, (layer) => (layer.key === key ? edit(layer) : layer)),
	})

const editRestriction = (
	model: Model,
	key: string,
	restrictionKey: string,
	edit: (restriction: RestrictionDraft) => RestrictionDraft,
): Return =>
	editLayer(model, key, (layer) => ({
		...layer,
		restrictions: Arr.map(layer.restrictions, (restriction) =>
			restriction.key === restrictionKey ? edit(restriction) : restriction,
		),
	}))

/** Swaps an item with its neighbour; at either end the list stays as it is. */
export const moved = <A>(items: ReadonlyArray<A>, index: number, direction: Direction): ReadonlyArray<A> => {
	const to = direction === "up" ? index - 1 : index + 1
	const moving = items[index]
	const other = items[to]
	if (moving === undefined || other === undefined) return items
	return Arr.map(items, (item, at) => (at === index ? other : at === to ? moving : item))
}

const swapIndex = <A>(items: ReadonlyArray<A>, find: (item: A) => boolean, direction: Direction) =>
	Option.match(Arr.findFirstIndex(items, find), {
		onNone: () => items,
		onSome: (index) => moved(items, index, direction),
	})

const decodeUserId = Schema.decodeUnknownOption(UserId)

/** A layer's "Add person" menu: a pick appends the member to the rotation. */
const participantMenu = (model: Model, key: string, message: Menu.Message): Return => {
	const result = Menu.update(model.menus[key] ?? Menu.init(participantMenuId(key)), message)
	const next: Model = { ...model, menus: { ...model.menus, [key]: result.model } }
	const commands = FoldkitCommand.mapMessages(result.commands ?? [], (child) =>
		Message.GotParticipantMenuMessage({ key, message: child }),
	)
	const picked = Option.flatMap(
		result.outMessage?._tag === "SelectedItem" ? Option.some(result.outMessage.value) : Option.none(),
		decodeUserId,
	)
	return Option.match(picked, {
		onNone: () => ({ model: next, commands }),
		onSome: (userId) => ({
			...editLayer(next, key, (layer) =>
				layer.participants.includes(userId)
					? layer
					: { ...layer, participants: [...layer.participants, userId] },
			),
			commands,
		}),
	})
}

const zonePicked = (model: Model, message: Combobox.Message): Return => {
	const step = Combobox.update(model.zonePicker, message)
	const commands = FoldkitCommand.mapMessages(step.commands ?? [], (child) =>
		Message.GotZoneMessage({ message: child }),
	)
	const zone =
		step.outMessage?._tag === "ChangedValue" && model.zones.includes(step.outMessage.value)
			? step.outMessage.value
			: null
	return {
		model: {
			...model,
			zonePicker: step.model,
			form: zone === null ? model.form : { ...model.form, timeZone: zone },
		},
		commands,
	}
}

const save = (model: Model): Return =>
	model.isSaving || !canManage(model)
		? { model }
		: Option.match(payloadOf(model.form), {
				onNone: () => ({ model: { ...model, isShowingErrors: true } }),
				onSome: (payload) => ({
					model: { ...model, isSaving: true, isShowingErrors: true, saveFailure: null },
					commands: [SaveSchedule({ editingId: model.editingId, payload })],
				}),
			})

const addRestriction = (model: Model, key: string): Return => {
	const added = editLayer(model, key, (layer) =>
		layer.restrictions.length >= MAX_ONCALL_RESTRICTIONS
			? layer
			: { ...layer, restrictions: [...layer.restrictions, emptyRestriction(model.form.nextKey)] },
	)
	return withForm(added.model, { ...added.model.form, nextKey: added.model.form.nextKey + 1 })
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		ReadDefaults: ({ timeZone, nowMs, zones }) => {
			const ready: Model = { ...model, nowMs, zones, isReady: true }
			// An edit fills from the schedule; a new one starts on the viewer's zone and today.
			return model.editingId !== null
				? { model: ready }
				: { model: syncZone({ ...ready, form: emptyForm(timeZone, nowMs) }) }
		},
		CompletedFetchExisting: ({ key, result }) => {
			const existing = Keyed.accept(model.existing, key, result)
			const loaded = Option.getOrNull(AsyncData.getData(existing.data))
			return {
				model:
					loaded === null
						? { ...model, existing }
						: syncZone({ ...model, existing, form: formFromSchedule(loaded) }),
			}
		},
		CompletedFetchMembers: ({ result }) =>
			Result.match(result, {
				onSuccess: (members) => ({ model: { ...model, members, membersError: null } }),
				// Members stay unknown (names read "Member"), and the picker says why it is empty.
				onFailure: (error) => ({ model: { ...model, members: null, membersError: error } }),
			}),
		CompletedFetchSession: ({ orgId, grants }) =>
			orgId === context.orgId ? { model: { ...model, grants, isSessionLoaded: true } } : { model },
		ChangedName: ({ value }) => withForm(model, { ...model.form, name: value }),
		ChangedDescription: ({ value }) => withForm(model, { ...model.form, description: value }),
		GotZoneMessage: ({ message: child }) => zonePicked(model, child),
		ClickedAddLayer: () =>
			model.form.layers.length >= MAX_ONCALL_LAYERS
				? { model }
				: withForm(model, {
						...model.form,
						layers: [
							...model.form.layers,
							emptyLayer(
								model.form.nextKey,
								model.form.layers.length,
								model.nowMs,
								model.form.timeZone,
							),
						],
						nextKey: model.form.nextKey + 1,
					}),
		ClickedRemoveLayer: ({ key }) =>
			withForm(model, {
				...model.form,
				layers: Arr.filter(model.form.layers, (layer) => layer.key !== key),
			}),
		// Layers are stored bottom first and drawn top first: "up" raises a layer over the next one.
		ClickedMoveLayer: ({ key, direction }) =>
			withForm(model, {
				...model.form,
				layers: swapIndex(
					model.form.layers,
					(layer) => layer.key === key,
					direction === "up" ? "down" : "up",
				),
			}),
		ClickedRetryExisting: () => {
			const editingId = model.editingId
			if (editingId === null) return { model }
			const existing = Keyed.supersede(
				model.existing,
				requestKey(context.orgId, "oncallSchedules.retrieve", { id: editingId }),
			)
			return {
				model: { ...model, existing },
				commands: [FetchExistingSchedule({ key: existing.key, scheduleId: editingId })],
			}
		},
		ChangedLayerText: ({ key, field, value }) =>
			field === "startsAt"
				? editLayer(model, key, (layer) => ({ ...layer, startsAt: value, startsAtMs: null }))
				: editLayer(model, key, (layer) => ({ ...layer, [field]: value })),
		PickedRotation: ({ key, rotation }) => editLayer(model, key, (layer) => ({ ...layer, rotation })),
		PickedHandoffWeekday: ({ key, weekday }) =>
			editLayer(model, key, (layer) => ({ ...layer, handoffWeekday: weekday })),
		GotParticipantMenuMessage: ({ key, message: child }) => participantMenu(model, key, child),
		ClickedRemoveParticipant: ({ key, userId }) =>
			editLayer(model, key, (layer) => ({
				...layer,
				participants: Arr.filter(layer.participants, (id) => id !== userId),
			})),
		ClickedMoveParticipant: ({ key, userId, direction }) =>
			editLayer(model, key, (layer) => ({
				...layer,
				participants: swapIndex(layer.participants, (id) => id === userId, direction),
			})),
		ClickedAddRestriction: ({ key }) => addRestriction(model, key),
		ClickedRemoveRestriction: ({ key, restrictionKey }) =>
			editLayer(model, key, (layer) => ({
				...layer,
				restrictions: Arr.filter(
					layer.restrictions,
					(restriction) => restriction.key !== restrictionKey,
				),
			})),
		ToggledRestrictionDay: ({ key, restrictionKey, weekday }) =>
			editRestriction(model, key, restrictionKey, (restriction) => ({
				...restriction,
				weekdays: restriction.weekdays.includes(weekday)
					? Arr.filter(restriction.weekdays, (day) => day !== weekday)
					: [...restriction.weekdays, weekday],
			})),
		ChangedRestrictionTime: ({ key, restrictionKey, edge, value }) =>
			editRestriction(model, key, restrictionKey, (restriction) =>
				edge === "start" ? { ...restriction, startTime: value } : { ...restriction, endTime: value },
			),
		ClickedSave: () => save(model),
		CompletedSave: ({ result }) =>
			Result.match(result, {
				onSuccess: (schedule): Return => ({
					model: { ...model, isSaving: false },
					outMessage: PageOutMessage.RequestedNavigation({
						url: scheduleHref(schedule.id),
						isReplace: true,
						toast: {
							type: "success",
							title: model.editingId === null ? "Schedule created" : "Changes saved",
							description: "",
						},
					}),
				}),
				onFailure: (failure): Return => ({
					model: { ...model, isSaving: false, saveFailure: failure },
				}),
			}),
	})
