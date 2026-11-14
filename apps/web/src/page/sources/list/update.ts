import * as Policy from "@maple/domain/policy"
import { Option, Result } from "effect"
import * as Keyed from "@maple/views/data/keyed"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { RESUME_COPY, sourcesListKey, sourcesUsageKey } from "../kit/data"
import { isClerkAuthEnabled } from "../../../platform/auth-mode"
import {
	FetchSourcesList,
	FetchSourcesUsage,
	ReadSourcesClock,
	ReadSourcesGrants,
	ResumeSource,
} from "./command"
import { Message } from "./message"
import type { Model } from "./model"

type Return = PageReturn<Model, Message>

/** `Supersede` after a write: it re-reads even while an earlier read is still in flight. */
const loadList = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return =>
	Option.match(Keyed.requestFor(model.list, sourcesListKey(context.orgId), mode), {
		onNone: () => ({ model }),
		onSome: (list) => ({
			model: { ...model, list },
			commands: [FetchSourcesList({ key: list.key, refresh: mode !== "Load" })],
		}),
	})

const loadUsage = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const key = sourcesUsageKey(context.orgId)
	return Option.match(Keyed.request(model.usage, key, mode), {
		onNone: () => ({ model }),
		onSome: (usage) => ({
			model: { ...model, usage },
			commands: [FetchSourcesUsage({ key, refresh: mode === "Refresh" })],
		}),
	})
}

/** The list and its volumes, read side by side; a retry re-reads the volumes only if they are missing. */
const load = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const list = loadList(model, context, mode)
	const usage = loadUsage(list.model, context, "Load")
	return { model: usage.model, commands: [...(list.commands ?? []), ...(usage.commands ?? [])] }
}

export const init = (_route: unknown, context: PageContext): Return => {
	const loaded = load(
		{
			nowMs: null,
			grants: isClerkAuthEnabled ? [] : Policy.allPermissions,
			list: Keyed.idle(),
			usage: Keyed.idle(),
			search: "",
			resuming: null,
		},
		context,
		"Load",
	)
	return {
		model: loaded.model,
		commands: [
			ReadSourcesClock(),
			...(isClerkAuthEnabled ? [ReadSourcesGrants()] : []),
			...(loaded.commands ?? []),
		],
	}
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		ReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		CompletedReadGrants: ({ grants }) => ({ model: { ...model, grants } }),
		CompletedFetchList: ({ key, result }) => ({
			model: { ...model, list: Keyed.accept(model.list, key, result) },
		}),
		CompletedFetchUsage: ({ key, result }) => ({
			model: { ...model, usage: Keyed.accept(model.usage, key, result) },
		}),
		ClickedRetry: () => load(model, context, "Refresh"),
		ChangedSearch: ({ value }) => ({ model: { ...model, search: value } }),
		ClickedResume: ({ id }) =>
			model.resuming !== null
				? { model }
				: { model: { ...model, resuming: id }, commands: [ResumeSource({ id })] },
		// The list is read again on success, so the row leaves "Not sending" once it sends.
		CompletedResume: ({ result }) =>
			Result.match(result, {
				onFailure: (failure) => ({
					model: { ...model, resuming: null },
					outMessage: PageOutMessage.RequestedToast({
						type: "error",
						title: RESUME_COPY.error,
						description: failure.message,
					}),
				}),
				onSuccess: () => ({
					...loadList({ ...model, resuming: null }, context, "Supersede"),
					outMessage: PageOutMessage.RequestedToast({
						type: "success",
						title: RESUME_COPY.success,
						description: "",
					}),
				}),
			}),
	})
