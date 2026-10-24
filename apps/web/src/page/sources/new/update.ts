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
import { type DataIntegration, initEmbedded, isDataIntegration } from "../../integrations/embed"
import type { Message as IntegrationMessage } from "../../integrations/message"
import type { Model as IntegrationModel } from "../../integrations/model"
import * as Integrations from "../../integrations/update"
import { Message } from "./message"
import { canContinue, type FlowSpec, flowOf, nextStage, previousStage } from "../../integrations/flow"
import type { Model } from "./model"

type Return = PageReturn<Model, Message>
type Cmd = Command.Command<Message, never, Resources>
type NewRoute = Extract<AppRoute, { readonly _tag: "SourcesNew" }>

const navigate = (url: string): PageOutMessage =>
	PageOutMessage.RequestedNavigation({ url, isReplace: false })

/** Step 2's form, fresh for each platform pick. */
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
	const next = refresh
		? Option.some(Keyed.supersede(model.list, key))
		: Keyed.request(model.list, key, "Load")
	return Option.match(next, {
		onNone: () => ({ model }),
		onSome: (list) => ({
			model: { ...model, list },
			commands: [FetchSourcesList({ key: list.key ?? key, refresh })],
		}),
	})
}

/** `?integration=` when it names a data integration and no push platform is picked. */
const integrationOf = (route: NewRoute): DataIntegration | null => {
	const raw = route.search.integration
	return route.search.platform === undefined && raw !== undefined && isDataIntegration(raw) ? raw : null
}

/** The integrations module's step, lifted: its Commands answer as `GotIntegrationsMessage`. */
const liftIntegrations = (model: Model, step: PageReturn<IntegrationModel, IntegrationMessage>): Return => {
	const lifted: Return = {
		model: { ...model, integrations: step.model },
		commands: Command.mapMessages(step.commands ?? [], (message) =>
			Message.GotIntegrationsMessage({ message }),
		),
	}
	return step.outMessage === undefined ? lifted : { ...lifted, outMessage: step.outMessage }
}

/** Both steps' Commands; the second's outMessage wins, else the first's (a connect toast). */
const merge = (first: Return, second: Return): Return => {
	const merged: Return = { ...second, commands: [...(first.commands ?? []), ...(second.commands ?? [])] }
	const outMessage = second.outMessage ?? first.outMessage
	return outMessage === undefined ? merged : { ...merged, outMessage }
}

export const init = (route: NewRoute, context: PageContext): Return => {
	const platform = route.search.platform ?? null
	const integration = integrationOf(route)
	const embedded = initEmbedded(integration, context)
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
			integration,
			integrations: embedded.model,
			hasAddedTarget: false,
			stage: "connect",
		},
		platform,
	)
	const lifted = liftIntegrations(model, embedded)
	// An integration's step reads the list too: once connected it links to the source it made.
	return platform === null && integration === null
		? lifted
		: merge(lifted, readList(lifted.model, context, false))
}

export const routeChanged = (model: Model, route: NewRoute, context: PageContext): Return => {
	const platform = route.search.platform ?? null
	const integration = integrationOf(route)
	const entered: Return =
		integration === model.integration
			? { model }
			: liftIntegrations(
					{ ...model, integration, stage: "connect" },
					Integrations.routeChanged(
						model.integrations,
						{ search: integration === null ? {} : { integration } },
						context,
					),
				)
	if (platform === model.platform)
		return integration === null || integration === model.integration
			? entered
			: merge(entered, readList(entered.model, context, false))
	const next = withForm(
		{ ...entered.model, list: platform === null ? Keyed.idle() : entered.model.list },
		platform,
	)
	if (model.created !== null) return { ...entered, model: next }
	// Back to the picker clears the form's list; an integration's step reads it again.
	if (platform === null)
		return integration === null
			? { ...entered, model: next }
			: merge(entered, readList(next, context, false))
	return merge(entered, readList(next, context, true))
}

/** The chosen integration's place in the flow, or null on the picker and push platforms. */
export const flowSpecOf = (model: Model): FlowSpec | null =>
	model.integration === null
		? null
		: flowOf(model.integrations, model.integration, { hasAddedTarget: model.hasAddedTarget })

/** Connect's answer is in: the source exists (WarpStream: a target was added in this visit). */
export const isIntegrationConnected = (model: Model): boolean =>
	(flowSpecOf(model)?.connected ?? null) !== null

/** `FirstDataStatus`'s `latest`: the polled source, else the one the create answered. */
export const latestOf = (model: Model): V2Source | null =>
	model.created === null
		? null
		: Option.getOrElse(AsyncData.getData(model.firstData.data), () => model.created?.source ?? null)

export const isReceiving = (model: Model): boolean => {
	const latest = latestOf(model)
	return latest !== null && latest.last_used_at !== null
}

const readCreated = (
	model: Model,
	context: PageContext,
	source: V2Source,
	mode: Keyed.RequestMode,
): Return => {
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
	step: {
		readonly model: Child
		readonly commands?: ReadonlyArray<Command.Command<ChildMessage, never, Resources>>
	},
	set: (child: Child) => Model,
	wrap: (message: ChildMessage) => Message,
): Return => ({ model: set(step.model), commands: Command.mapMessages(step.commands ?? [], wrap) })

/** Polls on while nothing has arrived, success or failure (`enabled: !receiving`). */
const pollUnlessReceiving = (step: Return): Return =>
	step.model.created === null || isReceiving(step.model) || step.model.firstData.key === null
		? step
		: {
				...step,
				commands: [...(step.commands ?? []), WaitFirstDataPoll({ key: step.model.firstData.key })],
			}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		ClickedPushPlatform: ({ platform }) => ({
			model,
			outMessage: navigate(hrefOf(Routes.SourcesNew({ search: { platform } }))),
		}),
		ClickedIntegration: ({ integration }) => ({
			model,
			outMessage: navigate(hrefOf(Routes.SourcesNew({ search: { integration } }))),
		}),
		GotIntegrationsMessage: ({ message: child }) => {
			const integration = model.integration
			const added = child._tag === "CompletedSave" && !child.isEdit && child.failure === null
			const step = liftIntegrations(
				added && integration === "warpstream" ? { ...model, hasAddedTarget: true } : model,
				Integrations.update(model.integrations, child, context),
			)
			// A connect just finished or a target was added: its source is new, so read the list again.
			return integration !== null &&
				(added || (!isIntegrationConnected(model) && isIntegrationConnected(step.model)))
				? merge(step, readList(step.model, context, true))
				: step
		},
		ChangedName: ({ value }) => ({ model: { ...model, name: value } }),
		ToggledAdvanced: () => ({ model: { ...model, isAdvancedOpen: !model.isAdvancedOpen } }),
		GotRulesMessage: ({ message: inner }) =>
			delegate(
				Rules.update(model.rules, inner),
				(rules) => ({ ...model, rules }),
				(child) => Message.GotRulesMessage({ message: child }),
			),
		ClickedBack: () => ({ model, outMessage: navigate(hrefOf(Routes.SourcesNew({ search: {} }))) }),
		ClickedContinue: () => {
			const spec = flowSpecOf(model)
			const next = spec === null ? null : nextStage(spec, model.stage)
			return spec === null || next === null || !canContinue(spec, model.stage)
				? { model }
				: { model: { ...model, stage: next } }
		},
		ClickedStepBack: () => {
			const spec = flowSpecOf(model)
			const previous = spec === null ? null : previousStage(spec, model.stage)
			return previous === null
				? { model, outMessage: navigate(hrefOf(Routes.SourcesNew({ search: {} }))) }
				: { model: { ...model, stage: previous } }
		},
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
					return {
						model: read.model,
						commands: [...(refreshed.commands ?? []), ...(read.commands ?? [])],
					}
				},
			}),
		CompletedFetchList: ({ key, result }) => ({
			model: { ...model, list: Keyed.accept(model.list, key, result) },
		}),
		CompletedFetchSource: ({ key, result }) =>
			key !== model.firstData.key
				? { model }
				: pollUnlessReceiving({
						model: { ...model, firstData: Keyed.accept(model.firstData, key, result) },
					}),
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
