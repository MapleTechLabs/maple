import { AlertDestinationId } from "@maple/domain/http"
import { Option, Result, Schema, Array as Arr } from "effect"
import { AsyncData, Command as FoldkitCommand } from "foldkit"
import * as Keyed from "@maple/views/data/keyed"
import { requestKey } from "@maple/views/data/request-key"
import * as Menu from "@maple/views/ui/menu"
import type { AppRoute } from "../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { pickedDestination } from "../../kit/destination-picker"
import { sloHref, sloIdFromUrl } from "../shared/slo-commands"
import { FetchExistingSlo, FetchSloFormServices, FetchSloFormSession, SaveSloDraft } from "./command"
import { formFromSlo, formIssues, wirePayload } from "./derive"
import { emptyForm, type Form, type Tier } from "./form"
import { Message } from "./message"
import { canManage, type Model } from "./model"

type Return = PageReturn<Model, Message>
type FormRoute = Extract<AppRoute, { readonly _tag: "AlertsSloNew" }>

export const CRITICAL_MENU_ID = "slo-form-critical-destinations"
export const WARNING_MENU_ID = "slo-form-warning-destinations"

const decodeDestinationId = Schema.decodeUnknownOption(AlertDestinationId)

export const init = (route: FormRoute, context: PageContext): Return => {
	const editingId = Option.getOrNull(Option.flatMap(Option.fromNullishOr(route.search.sloId), sloIdFromUrl))
	const model: Model = {
		search: route.search,
		editingId,
		existing: Keyed.idle(),
		form: emptyForm({ serviceName: route.search.serviceName ?? "" }),
		isSaving: false,
		saveFailure: null,
		services: [],
		destinations: null,
		criticalMenu: Menu.init(CRITICAL_MENU_ID),
		warningMenu: Menu.init(WARNING_MENU_ID),
		grants: [],
		isSessionLoaded: false,
	}
	const common = [FetchSloFormServices(), FetchSloFormSession({ orgId: context.orgId })]
	if (editingId === null) return { model, commands: common }
	const key = requestKey(context.orgId, "slos.retrieve", { sloId: editingId })
	return Option.match(Keyed.request(model.existing, key, "Load"), {
		onNone: () => ({ model, commands: common }),
		onSome: (existing) => ({
			model: { ...model, existing },
			commands: [...common, FetchExistingSlo({ key, sloId: editingId })],
		}),
	})
}

const withForm = (model: Model, patch: Partial<Form>): Return => ({
	model: { ...model, form: { ...model.form, ...patch } },
})

const idsOf = (form: Form, tier: Tier) =>
	tier === "critical" ? form.criticalDestinationIds : form.warningDestinationIds

const withIds = (tier: Tier, ids: ReadonlyArray<AlertDestinationId>): Partial<Form> =>
	tier === "critical" ? { criticalDestinationIds: ids } : { warningDestinationIds: ids }

/** One tier's "Add destination" menu: a pick of a synced destination adds it to that tier. */
const updateDestinationMenu = (model: Model, tier: Tier, message: Menu.Message): Return => {
	const result = Menu.update(tier === "critical" ? model.criticalMenu : model.warningMenu, message)
	const commands = FoldkitCommand.mapMessages(result.commands ?? [], (child) =>
		Message.GotDestinationMenuMessage({ tier, message: child }),
	)
	const next: Model =
		tier === "critical"
			? { ...model, criticalMenu: result.model }
			: { ...model, warningMenu: result.model }
	const ids = idsOf(model.form, tier)
	return Option.match(
		Option.flatMap(pickedDestination(result.outMessage, model.destinations, ids), decodeDestinationId),
		{
			onNone: () => ({ model: next, commands }),
			onSome: (id) => ({
				model: { ...next, form: { ...next.form, ...withIds(tier, [...ids, id]) } },
				commands,
			}),
		},
	)
}

const save = (model: Model): Return =>
	model.isSaving || !canManage(model) || formIssues(model.form).length > 0
		? { model }
		: {
				model: { ...model, isSaving: true, saveFailure: null },
				commands: [SaveSloDraft({ editingId: model.editingId, payload: wirePayload(model.form) })],
			}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedFetchExisting: ({ key, result }) => {
			const existing = Keyed.accept(model.existing, key, result)
			const loaded = Option.getOrNull(AsyncData.getData(existing.data))
			return {
				model: {
					...model,
					existing,
					...(loaded === null ? undefined : { form: formFromSlo(loaded) }),
				},
			}
		},
		UpdatedDestinations: ({ orgId, rows }) =>
			orgId === context.orgId ? { model: { ...model, destinations: rows } } : { model },
		CompletedFetchServices: ({ services }) => ({ model: { ...model, services } }),
		CompletedFetchSession: ({ orgId, grants }) =>
			orgId === context.orgId ? { model: { ...model, grants, isSessionLoaded: true } } : { model },
		ChangedText: ({ field, value }) => withForm(model, { [field]: value }),
		PickedSliType: ({ sliType }) => withForm(model, { sliType }),
		PickedThreshold: ({ thresholdMs }) => withForm(model, { thresholdMs }),
		PickedTarget: ({ target }) => withForm(model, { target }),
		PickedWindow: ({ windowDays }) => withForm(model, { windowDays }),
		ToggledAlerting: () => withForm(model, { alertingEnabled: !model.form.alertingEnabled }),
		RemovedDestination: ({ tier, id }) =>
			withForm(
				model,
				withIds(
					tier,
					Arr.filter(idsOf(model.form, tier), (existing) => existing !== id),
				),
			),
		GotDestinationMenuMessage: ({ tier, message: child }) => updateDestinationMenu(model, tier, child),
		ClickedSave: () => save(model),
		CompletedSave: ({ result }) =>
			Result.match(result, {
				onSuccess: (slo): Return => ({
					model: { ...model, isSaving: false },
					outMessage: PageOutMessage.RequestedNavigation({
						url: sloHref(slo.id),
						isReplace: true,
						toast: {
							type: "success",
							title: model.editingId === null ? "SLO created" : "Changes saved",
							description: "",
						},
					}),
				}),
				// Inline beside the action bar, never a toast over its buttons.
				onFailure: (saveFailure): Return => ({ model: { ...model, isSaving: false, saveFailure } }),
			}),
	})
