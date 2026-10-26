import { AlertDestinationId } from "@maple/domain/http"
import { Option, Result, Schema } from "effect"
import { AsyncData, Command as FoldkitCommand } from "foldkit"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import type { AppRoute } from "../../../route"
import * as Menu from "../../../ui/menu"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { monitorHref, monitorIdFromUrl } from "../shared/uptime-commands"
import {
	FetchExistingMonitor,
	FetchFormServices,
	FetchFormSession,
	ReadFormTimeZones,
	SaveDraft,
	TestDraft,
} from "./command"
import { defaultName, formFromMonitor, formIssues, wireConfig, wirePayload } from "./derive"
import { ASSERTION_OPS, type AssertionDraft, emptyForm, type Form, MonitorKind, type TextField } from "./form"
import { Message } from "./message"
import type { Model } from "./model"

type Return = PageReturn<Model, Message>
type FormRoute = Extract<AppRoute, { readonly _tag: "AlertsUptimeNew" }>

const decodeDestinationId = Schema.decodeUnknownOption(AlertDestinationId)

export const DESTINATION_MENU_ID = "uptime-form-destinations"

const isKind = (value: string): value is Form["kind"] => MonitorKind.literals.some((kind) => kind === value)
const kindOf = (raw: string | undefined): Form["kind"] => (raw !== undefined && isKind(raw) ? raw : "http")

export const init = (route: FormRoute, context: PageContext): Return => {
	const editingId = Option.getOrNull(
		Option.flatMap(Option.fromNullishOr(route.search.monitorId), monitorIdFromUrl),
	)
	const model: Model = {
		search: route.search,
		editingId,
		existing: Keyed.idle(),
		form: emptyForm({ kind: kindOf(route.search.kind), serviceName: route.search.serviceName ?? "" }),
		isSaving: false,
		saveFailure: null,
		isTesting: false,
		testResult: null,
		testFailure: null,
		services: [],
		timeZones: [],
		destinations: null,
		destinationMenu: Menu.init(DESTINATION_MENU_ID),
		isAdmin: false,
		isSessionLoaded: false,
	}
	const common = [FetchFormServices(), ReadFormTimeZones(), FetchFormSession({ orgId: context.orgId })]
	if (editingId === null) return { model, commands: common }
	const key = requestKey(context.orgId, "uptimeMonitors.retrieve", { monitorId: editingId })
	return Option.match(Keyed.request(model.existing, key, "Load"), {
		onNone: () => ({ model, commands: common }),
		onSome: (existing) => ({
			model: { ...model, existing },
			commands: [...common, FetchExistingMonitor({ key, monitorId: editingId })],
		}),
	})
}

/** Until a name is typed it follows the target: the URL, `host:port`, or `<type> <hostname>`. */
const named = (form: Form): Form => (form.isNameEdited ? form : { ...form, name: defaultName(form) })

const withForm = (model: Model, patch: Partial<Form>): Return => ({
	model: { ...model, form: named({ ...model.form, ...patch }) },
})

const changedText = (model: Model, field: TextField, value: string): Return =>
	field === "name"
		? { model: { ...model, form: { ...model.form, name: value, isNameEdited: value !== "" } } }
		: withForm(model, { [field]: value })

const mapAssertion = (model: Model, id: number, change: (row: AssertionDraft) => AssertionDraft): Return =>
	withForm(model, { assertions: model.form.assertions.map((row) => (row.id === id ? change(row) : row)) })

const addAssertion = (model: Model): Return =>
	withForm(model, {
		assertions: [
			...model.form.assertions,
			{ id: model.form.nextAssertionId, type: "body", op: "contains", target: "", value: "" },
		],
		nextAssertionId: model.form.nextAssertionId + 1,
	})

const test = (model: Model): Return =>
	model.isTesting || model.form.kind !== "http"
		? { model }
		: {
				model: { ...model, isTesting: true, testFailure: null },
				commands: [TestDraft({ config: wireConfig(model.form) })],
			}

const save = (model: Model): Return =>
	model.isSaving || !model.isAdmin || formIssues(model.form).length > 0
		? { model }
		: {
				model: { ...model, isSaving: true, saveFailure: null },
				commands: [
					SaveDraft({
						editingId: model.editingId,
						payload: wirePayload(model.form, model.editingId !== null),
					}),
				],
			}

const updateDestinationMenu = (model: Model, message: Menu.Message): Return => {
	const result = Menu.update(model.destinationMenu, message)
	const commands = FoldkitCommand.mapMessages(result.commands ?? [], (child) =>
		Message.GotDestinationMenuMessage({ message: child }),
	)
	const next = { ...model, destinationMenu: result.model }
	const picked = result.outMessage?._tag === "SelectedItem" ? result.outMessage.value : null
	const isKnown = (model.destinations ?? []).some((destination) => destination.id === picked)
	return Option.match(isKnown ? decodeDestinationId(picked) : Option.none(), {
		onNone: () => ({ model: next, commands }),
		onSome: (id) =>
			model.form.destinationIds.includes(id)
				? { model: next, commands }
				: {
						model: {
							...next,
							form: { ...next.form, destinationIds: [...next.form.destinationIds, id] },
						},
						commands,
					},
	})
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
					...(loaded === null ? undefined : { form: formFromMonitor(loaded) }),
				},
			}
		},
		UpdatedDestinations: ({ orgId, rows }) =>
			orgId === context.orgId ? { model: { ...model, destinations: rows } } : { model },
		CompletedFetchServices: ({ services }) => ({ model: { ...model, services } }),
		CompletedReadTimeZones: ({ zones }) => ({ model: { ...model, timeZones: zones } }),
		CompletedFetchSession: ({ orgId, isAdmin }) =>
			orgId === context.orgId ? { model: { ...model, isAdmin, isSessionLoaded: true } } : { model },
		PickedKind: ({ kind }) =>
			model.editingId !== null
				? { model }
				: { model: { ...model, form: named({ ...model.form, kind }), testResult: null } },
		ChangedText: ({ field, value }) => changedText(model, field, value),
		ChangedMethod: ({ method }) => withForm(model, { method }),
		ChangedRecordType: ({ recordType }) => withForm(model, { recordType }),
		ChangedScheduleMode: ({ mode }) => withForm(model, { scheduleMode: mode }),
		ChangedEveryUnit: ({ unit }) => withForm(model, { everyUnit: unit }),
		ChangedGraceUnit: ({ unit }) => withForm(model, { graceUnit: unit }),
		PickedInterval: ({ seconds }) => withForm(model, { intervalSeconds: seconds }),
		AddedAssertion: () => addAssertion(model),
		RemovedAssertion: ({ id }) =>
			withForm(model, { assertions: model.form.assertions.filter((row) => row.id !== id) }),
		ChangedAssertionType: ({ id, type }) =>
			mapAssertion(model, id, (row) => ({
				...row,
				type,
				op: ASSERTION_OPS[type][0]?.value ?? "",
				value: type === "status" ? "2xx" : type === "latency" ? "2000" : "",
				target: "",
			})),
		ChangedAssertion: ({ id, part, value }) =>
			mapAssertion(model, id, (row) => ({ ...row, [part]: value })),
		RemovedDestination: ({ id }) =>
			withForm(model, {
				destinationIds: model.form.destinationIds.filter((existing) => existing !== id),
			}),
		GotDestinationMenuMessage: ({ message: child }) => updateDestinationMenu(model, child),
		ClickedTest: () => test(model),
		CompletedTest: ({ result }) =>
			Result.match(result, {
				onSuccess: (testResult): Return => ({
					model: { ...model, isTesting: false, testResult, testFailure: null },
				}),
				onFailure: (testFailure): Return => ({
					model: { ...model, isTesting: false, testResult: null, testFailure },
				}),
			}),
		ClickedSave: () => save(model),
		CompletedSave: ({ result }) =>
			Result.match(result, {
				onSuccess: (monitor): Return => ({
					model: { ...model, isSaving: false },
					outMessage: PageOutMessage.RequestedNavigation({
						url: monitorHref(monitor.id),
						isReplace: true,
						toast: {
							type: "success",
							title: model.editingId === null ? "Monitor created" : "Changes saved",
							description: "",
						},
					}),
				}),
				// Inline beside the action bar, never a toast over its buttons.
				onFailure: (saveFailure): Return => ({ model: { ...model, isSaving: false, saveFailure } }),
			}),
	})
