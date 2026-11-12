import { AlertDestinationId, AlertRuleId } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import * as Keyed from "@maple/views/data/keyed"
import { requestKey } from "@maple/views/data/request-key"
import * as Menu from "@maple/views/ui/menu"
import { Array as Arr, Option, Result, Schema } from "effect"
import { AsyncData, Command as FoldkitCommand } from "foldkit"
import { isClerkAuthEnabled } from "../../../platform/auth-mode"
import type { AppRoute } from "../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { pickedDestination } from "../../kit/destination-picker"
import { chain, slotStep } from "../../kit/keyed-step"
import { acceptGrants } from "../../kit/session-grants"
import { detectionsHref } from "../kit/detection-format"
import { templateOf } from "../kit/detection-templates"
import { FetchExistingDetection, ReadDetectionFormGrants, SaveDetection } from "./command"
import {
	detectionIn,
	formFromDetection,
	formFromSearch,
	formIssues,
	wirePayload,
	withTemplate,
} from "./derive"
import type { Form } from "./form"
import { accessOf, Message, type Model } from "./model"

type Return = PageReturn<Model, Message>

type SecurityDetectionNewRoute = Extract<AppRoute, { readonly _tag: "SecurityDetectionNew" }>

const DESTINATION_MENU_ID = "security-detection-destinations"

const decodeRuleId = Schema.decodeUnknownOption(AlertRuleId)
const decodeDestinationId = Schema.decodeUnknownOption(AlertDestinationId)

/** The edited detection's read, unless the session said the viewer may not read it. */
const readExisting = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return =>
	model.editingId === null || accessOf(model) !== "ask"
		? { model }
		: slotStep(
				model,
				model.existing,
				(existing) => ({ existing }),
				requestKey(context.orgId, "auditTrail.listDetections", {}),
				mode,
				(key) => FetchExistingDetection({ key }),
			)

/**
 * Entering the editor. `sessionDecides`: the hosted product, where the session says what the
 * viewer may do and nothing is asked before it answers. Self-hosted has one role and reads at once.
 */
export const enter = (
	route: SecurityDetectionNewRoute,
	context: PageContext,
	sessionDecides: boolean,
): Return => {
	const named = route.search.detectionId
	const editingId = named === undefined ? null : Option.getOrNull(decodeRuleId(named))
	const model: Model = {
		search: route.search,
		editingId,
		isMissing: named !== undefined && editingId === null,
		existing: Keyed.idle(),
		form: formFromSearch(route.search),
		templateId: Option.match(templateOf(route.search.template), {
			onNone: () => "",
			onSome: (template) => template.id,
		}),
		isSaving: false,
		saveFailure: null,
		destinations: null,
		destinationMenu: Menu.init(DESTINATION_MENU_ID),
		grants: sessionDecides ? [] : Policy.allPermissions,
		isGrantsRead: !sessionDecides,
	}
	const entered: Return = {
		model,
		commands: sessionDecides ? [ReadDetectionFormGrants({ orgId: context.orgId })] : [],
	}
	return chain(entered, (next) => readExisting(next, context, "Load"))
}

export const init = (route: SecurityDetectionNewRoute, context: PageContext): Return =>
	enter(route, context, isClerkAuthEnabled)

const withForm = (model: Model, patch: Partial<Form>): Return => ({
	model: { ...model, form: { ...model.form, ...patch } },
})

/** The "Add destination" menu: a pick of a synced destination adds it. */
const updateDestinationMenu = (model: Model, message: Menu.Message): Return => {
	const result = Menu.update(model.destinationMenu, message)
	const commands = FoldkitCommand.mapMessages(result.commands ?? [], (child) =>
		Message.GotDestinationMenuMessage({ message: child }),
	)
	const next: Model = { ...model, destinationMenu: result.model }
	const ids = model.form.destinationIds
	return Option.match(
		Option.flatMap(pickedDestination(result.outMessage, model.destinations, ids), decodeDestinationId),
		{
			onNone: () => ({ model: next, commands }),
			onSome: (id) => ({
				model: { ...next, form: { ...next.form, destinationIds: [...ids, id] } },
				commands,
			}),
		},
	)
}

const save = (model: Model): Return =>
	model.isSaving || model.isMissing || formIssues(model.form).length > 0
		? { model }
		: {
				model: { ...model, isSaving: true, saveFailure: null },
				commands: [SaveDetection({ editingId: model.editingId, payload: wirePayload(model.form) })],
			}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedReadGrants: (answer) =>
			readExisting(acceptGrants(model, context.orgId, answer, { isGrantsRead: true }), context, "Load"),
		CompletedFetchExisting: ({ key, result }) => {
			const existing = Keyed.accept(model.existing, key, result)
			if (existing === model.existing) return { model }
			return Option.match(AsyncData.getData(existing.data), {
				onNone: (): Return => ({ model: { ...model, existing } }),
				onSome: (list): Return =>
					Option.match(detectionIn(list, model.editingId), {
						onNone: (): Return => ({ model: { ...model, existing, isMissing: true } }),
						onSome: (detection): Return => ({
							model: { ...model, existing, form: formFromDetection(detection) },
						}),
					}),
			})
		},
		ClickedRetry: () => readExisting(model, context, "Refresh"),
		UpdatedDestinations: ({ orgId, rows }) =>
			orgId === context.orgId ? { model: { ...model, destinations: rows } } : { model },
		PickedTemplate: ({ id }) =>
			Option.match(templateOf(id), {
				onNone: (): Return => ({ model: { ...model, templateId: "" } }),
				onSome: (template): Return => ({
					model: { ...model, templateId: template.id, form: withTemplate(model.form, template) },
				}),
			}),
		ChangedText: ({ field, value }) => withForm(model, { [field]: value }),
		ChangedSelect: ({ field, value }) => withForm(model, { [field]: value }),
		PickedSeverity: ({ severity }) => withForm(model, { severity }),
		ToggledEnabled: () => withForm(model, { enabled: !model.form.enabled }),
		RemovedDestination: ({ id }) =>
			withForm(model, {
				destinationIds: Arr.filter(model.form.destinationIds, (existing) => existing !== id),
			}),
		GotDestinationMenuMessage: ({ message: child }) => updateDestinationMenu(model, child),
		ClickedSave: () => save(model),
		CompletedSave: ({ result }) =>
			Result.match(result, {
				// The form takes the API's answer, and the list is read again on arrival.
				onSuccess: (saved): Return => ({
					model: { ...model, isSaving: false, form: formFromDetection(saved) },
					outMessage: PageOutMessage.RequestedNavigation({
						url: detectionsHref(),
						isReplace: true,
						toast: {
							type: "success",
							title: model.editingId === null ? "Detection created" : "Changes saved",
							description: "",
						},
					}),
				}),
				// Inline above the action bar, in the server's words: a taken name, the cap.
				onFailure: (saveFailure): Return => ({ model: { ...model, isSaving: false, saveFailure } }),
			}),
	})
