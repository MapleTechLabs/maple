import type { V2Source } from "@maple/domain/http/v2"
import type { PushSourcePlatform } from "@maple/domain/primitives"
import { Option, Result } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Keyed from "../../../data/keyed"
import type { Resources } from "../../../platform/resources"
import { type AppRoute, AppRoute as Routes, hrefOf } from "../../../route"
import * as CopyButton from "../../../ui/copy-button"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { sourceRetrieveKey, sourcesListKey } from "../kit/data"
import { defaultSourceName } from "../kit/platforms"
import * as Rules from "../kit/rules"
import * as Setup from "../kit/setup"
import { CreateSource, FetchCreatedSource, FetchSourcesList, WaitFirstDataPoll } from "./command"
import { Message } from "./message"
import type { Model } from "./model"

type Return = PageReturn<Model, Message>
type Cmd = Command.Command<Message, never, Resources>
type NewRoute = Extract<AppRoute, { readonly _tag: "SourcesNew" }>

const navigate = (url: string): PageOutMessage => PageOutMessage.RequestedNavigation({ url, isReplace: false })

/** Step 2's form, fresh: legacy mounts a new `CreateSourceForm` per platform pick. */
const withForm = (model: Model, platform: PushSourcePlatform | null): Model => ({
	...model,
	platform,
	name: platform === null ? "" : defaultSourceName(platform),
	isAdvancedOpen: false,
	rules: Rules.init(null),
	isSaving: false,
})

/** The form's list read; `refresh` when it mounts again in the same visit (the atom was dropped). */
const readList = (model: Model, context: PageContext, refresh: boolean): Return => {
	const key = sourcesListKey(context.orgId)
	const next = refresh ? Option.some(Keyed.supersede(model.list, key)) : Keyed.request(model.list, key, "Load")
	return Option.match(next, {
		onNone: () => ({ model }),
		onSome: (list) => ({
			model: { ...model, list },
			commands: [FetchSourcesList({ key: list.key ?? key, refresh })],
		}),
	})
}

export const init = (route: NewRoute, context: PageContext): Return => {
	const platform = route.search.platform ?? null
	const model = withForm(
		{
			platform: null,
			name: "",
			isAdvancedOpen: false,
			rules: Rules.init(null),
			isSaving: false,
			list: Keyed.idle(),
			created: null,
			firstData: Keyed.idle(),
			setup: Setup.init("opentelemetry"),
			tokenCopy: CopyButton.init(),
		},
		platform,
	)
	return platform === null ? { model } : readList(model, context, false)
}

export const routeChanged = (model: Model, route: NewRoute, context: PageContext): Return => {
	const platform = route.search.platform ?? null
	if (platform === model.platform) return { model }
	const next = withForm({ ...model, list: platform === null ? Keyed.idle() : model.list }, platform)
	return platform === null || model.created !== null ? { model: next } : readList(next, context, true)
}

/** `FirstDataStatus`'s `latest`: the polled source, else the one the create answered. */
export const latestOf = (model: Model): V2Source | null =>
	model.created === null
		? null
		: Option.getOrElse(AsyncData.getData(model.firstData.data), () => model.created?.source ?? null)

export const isReceiving = (model: Model): boolean => {
	const latest = latestOf(model)
	return latest !== null && latest.last_used_at !== null
}

const readCreated = (model: Model, context: PageContext, source: V2Source, mode: Keyed.RequestMode): Return => {
	const key = sourceRetrieveKey(context.orgId, source.id)
	return Option.match(Keyed.request(model.firstData, key, mode), {
		onNone: () => ({ model }),
		onSome: (firstData) => ({
			model: { ...model, firstData },
			commands: [FetchCreatedSource({ key, id: source.id, refresh: mode === "Refresh" })],
		}),
	})
}

const submit = (model: Model): Return => {
	const outcome = Rules.rulesOutcome(model.rules)
	const name = model.name.trim()
	if (model.platform === null || model.isSaving || name.length === 0 || !outcome.valid) return { model }
	const command: Cmd = CreateSource({
		name,
		platform: model.platform,
		rules: outcome.payload,
		expiry: model.rules.expiry,
	})
	return { model: { ...model, isSaving: true }, commands: [command] }
}

const delegate = <Child, ChildMessage>(
	step: { readonly model: Child; readonly commands?: ReadonlyArray<Command.Command<ChildMessage, never, Resources>> },
	set: (child: Child) => Model,
	wrap: (message: ChildMessage) => Message,
): Return => ({ model: set(step.model), commands: Command.mapMessages(step.commands ?? [], wrap) })

/** Polls on while nothing has arrived, success or failure (`enabled: !receiving`). */
const pollUnlessReceiving = (step: Return): Return =>
	step.model.created === null || isReceiving(step.model) || step.model.firstData.key === null
		? step
		: { ...step, commands: [...(step.commands ?? []), WaitFirstDataPoll({ key: step.model.firstData.key })] }

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		ClickedPushPlatform: ({ platform }) => ({
			model,
			outMessage: navigate(hrefOf(Routes.SourcesNew({ search: { platform } }))),
		}),
		ClickedPullPlatform: ({ platform }) => ({
			model,
			outMessage: navigate(hrefOf(Routes.Integrations({ search: { integration: platform } }))),
		}),
		ChangedName: ({ value }) => ({ model: { ...model, name: value } }),
		ToggledAdvanced: () => ({ model: { ...model, isAdvancedOpen: !model.isAdvancedOpen } }),
		GotRulesMessage: ({ message: inner }) =>
			delegate(
				Rules.update(model.rules, inner),
				(rules) => ({ ...model, rules }),
				(child) => Message.GotRulesMessage({ message: child }),
			),
		ClickedBack: () => ({ model, outMessage: navigate(hrefOf(Routes.SourcesNew({ search: {} }))) }),
		SubmittedForm: () => submit(model),
		CompletedCreate: ({ result }) =>
			Result.match(result, {
				onFailure: (failure) => ({
					model: { ...model, isSaving: false },
					outMessage: PageOutMessage.RequestedToast({
						type: "error",
						title: "Failed to create source",
						description: failure.message,
					}),
				}),
				onSuccess: ({ secret, ...source }) => {
					const refreshed = readList({ ...model, isSaving: false }, context, true)
					const created: Model = {
						...refreshed.model,
						created: { source, secret },
						setup: Setup.init(source.platform),
					}
					const read = readCreated(created, context, source, "Load")
					return { model: read.model, commands: [...(refreshed.commands ?? []), ...(read.commands ?? [])] }
				},
			}),
		CompletedFetchList: ({ key, result }) => ({ model: { ...model, list: Keyed.accept(model.list, key, result) } }),
		CompletedFetchSource: ({ key, result }) =>
			key !== model.firstData.key
				? { model }
				: pollUnlessReceiving({ model: { ...model, firstData: Keyed.accept(model.firstData, key, result) } }),
		ElapsedPoll: ({ key }) =>
			key !== model.firstData.key || model.created === null || isReceiving(model)
				? { model }
				: readCreated(model, context, model.created.source, "Refresh"),
		GotSetupMessage: ({ message: inner }) =>
			delegate(
				Setup.update(model.setup, inner),
				(setup) => ({ ...model, setup }),
				(child) => Message.GotSetupMessage({ message: child }),
			),
		GotTokenCopyMessage: ({ message: inner }) =>
			delegate(
				CopyButton.update(model.tokenCopy, inner),
				(tokenCopy) => ({ ...model, tokenCopy }),
				(child) => Message.GotTokenCopyMessage({ message: child }),
			),
	})
