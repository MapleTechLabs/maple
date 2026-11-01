import type { V2Recommendation } from "@maple/domain/http/v2"
import { Option, Result } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Keyed from "../../data/keyed"
import type { LoadFailure } from "../../data/load-failure"
import { requestKey } from "../../data/request-key"
import type { Resources } from "../../platform/resources"
import type { AppRoute } from "../../route"
import * as CopyButton from "../../ui/copy-button"
import { type PageContext, PageOutMessage, type PageReturn } from "../contract"
import {
	CreateMapping,
	DismissRecommendation,
	FetchAttributeMappings,
	FetchRecommendations,
	ReadRecommendationClock,
	ReopenRecommendation,
} from "./command"
import { Message } from "./message"
import type { Model } from "./model"

type Return = PageReturn<Model, Message>
type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>
type RecommendationRoute = Extract<AppRoute, { readonly _tag: "Recommendation" }>

const LIST_QUERY = { query: { limit: 100 } }

/** Requests the list (and the mappings when asked) under `mode`. */
const load = (model: Model, context: PageContext, mode: Keyed.ReadMode, withMappings: boolean) => {
	const listKey = requestKey(context.orgId, "instrumentationRecommendations.list", LIST_QUERY)
	const mappingsKey = requestKey(context.orgId, "attributeMappings.list", LIST_QUERY)
	const list = Keyed.requestFor(model.list, listKey, mode)
	const mappings = withMappings ? Keyed.requestFor(model.mappings, mappingsKey, mode) : Option.none()
	const commands: Commands = [
		...Option.toArray(Option.map(list, (slot) => FetchRecommendations({ key: slot.key }))),
		...Option.toArray(Option.map(mappings, (slot) => FetchAttributeMappings({ key: slot.key }))),
	]
	return {
		model: {
			...model,
			list: Option.getOrElse(list, () => model.list),
			mappings: Option.getOrElse(mappings, () => model.mappings),
		},
		commands,
	}
}

export const init = (route: RecommendationRoute, context: PageContext): Return => {
	const loaded = load(
		{
			recommendationKey: route.recommendationKey,
			nowMs: null,
			list: Keyed.idle(),
			mappings: Keyed.idle(),
			busy: null,
			copy: CopyButton.init(),
		},
		context,
		"Load",
		true,
	)
	return { model: loaded.model, commands: [ReadRecommendationClock(), ...loaded.commands] }
}

/** The recommendation the route names, once the list has loaded. */
export const selectedOf = (model: Model): Option.Option<V2Recommendation> =>
	Option.flatMap(AsyncData.getData(model.list.data), (rows) =>
		Option.fromUndefinedOr(rows.find((row) => String(row.id) === model.recommendationKey)),
	)

const errorToast = (title: string, failure: LoadFailure) =>
	PageOutMessage.RequestedToast({ type: "error", title, description: failure.message })

/** The write's outcome: refresh what the write affects, or toast the failure. */
const settle = <A>(
	model: Model,
	context: PageContext,
	result: Result.Result<A, LoadFailure>,
	options: Readonly<{ error: string; withMappings: boolean; success?: (value: A) => string }>,
): Return =>
	Result.match(result, {
		onFailure: (failure) => ({
			model: { ...model, busy: null },
			outMessage: errorToast(options.error, failure),
		}),
		onSuccess: (value) => {
			const refreshed = load({ ...model, busy: null }, context, "Supersede", options.withMappings)
			if (options.success === undefined) return refreshed
			const outMessage = PageOutMessage.RequestedToast({
				type: "success",
				title: options.success(value),
				description: "",
			})
			return { ...refreshed, outMessage }
		},
	})

const startWrite = (
	model: Model,
	busy: NonNullable<Model["busy"]>,
	command: (issue: V2Recommendation) => Option.Option<Commands[number]>,
): Return =>
	model.busy !== null
		? { model }
		: Option.match(Option.flatMap(selectedOf(model), command), {
				onNone: () => ({ model }),
				onSome: (next) => ({ model: { ...model, busy }, commands: [next] }),
			})

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		ReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		CompletedFetchList: ({ key, result }) => ({
			model: { ...model, list: Keyed.accept(model.list, key, result) },
		}),
		CompletedFetchMappings: ({ key, result }) => ({
			model: { ...model, mappings: Keyed.accept(model.mappings, key, result) },
		}),
		ClickedRetry: () => load(model, context, "Refresh", false),
		ClickedApply: () =>
			startWrite(model, "apply", (issue) =>
				issue.kind !== "rename" || issue.canonical_key === null
					? Option.none()
					: Option.some(
							CreateMapping({
								payload: {
									name: `Rename ${issue.source_key} → ${issue.canonical_key}`,
									source_context: "span",
									source_key: issue.source_key,
									target_key: issue.canonical_key,
									operation: "copy",
								},
							}),
						),
			),
		ClickedDismiss: () =>
			startWrite(model, "dismiss", (issue) => Option.some(DismissRecommendation({ id: issue.id }))),
		ClickedReopen: () =>
			startWrite(model, "reopen", (issue) => Option.some(ReopenRecommendation({ id: issue.id }))),
		CompletedApply: ({ result }) =>
			settle(model, context, result, {
				error: "Couldn't create mapping",
				withMappings: true,
				success: (mapping) => `Mapping created: ${mapping.source_key} → ${mapping.target_key}`,
			}),
		CompletedDismiss: ({ result }) =>
			settle(model, context, result, { error: "Couldn't dismiss recommendation", withMappings: false }),
		CompletedReopen: ({ result }) =>
			settle(model, context, result, { error: "Couldn't reopen recommendation", withMappings: false }),
		GotCopyMessage: ({ message: inner }) => {
			const next = CopyButton.update(model.copy, inner)
			// `useCopy`'s toast: on by default for `<CopyButton label="Mapping">`.
			const isCurrent = "generation" in inner && inner.generation === model.copy.generation
			const toast =
				isCurrent && inner._tag === "SucceededCopy"
					? {
							outMessage: PageOutMessage.RequestedToast({
								type: "success",
								title: "Mapping copied",
								description: "",
							}),
						}
					: isCurrent && inner._tag === "FailedCopy"
						? {
								outMessage: PageOutMessage.RequestedToast({
									type: "error",
									title: "Couldn't copy mapping",
									description: "",
								}),
							}
						: {}
			return {
				model: { ...model, copy: next.model },
				commands: Command.mapMessages(next.commands ?? [], (message) =>
					Message.GotCopyMessage({ message }),
				),
				...toast,
			}
		},
	})
