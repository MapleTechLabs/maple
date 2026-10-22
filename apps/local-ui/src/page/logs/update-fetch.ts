import { Option, Result } from "effect"
import { AsyncData } from "foldkit"
import { accept, acceptCached } from "../../data/slot"
import { fetchAfterCache } from "./load"
import { type PageContext, PageOutMessage } from "../contract"
import type { Message } from "./message"
import type { Model } from "./model"
import { loadMoreIfAtEnd } from "./stream"
import { settleRefresh, type UpdateReturn } from "./update"

type FetchMessage = Extract<
	Message,
	{
		readonly _tag:
			| "SucceededFetchLogs"
			| "FailedFetchLogs"
			| "SucceededFetchPatterns"
			| "FailedFetchPatterns"
	}
>

type FoundMessage = Extract<
	Message,
	{
		readonly _tag:
			| "FoundCachedLogs"
			| "FoundCachedPatterns"
			| "FoundCachedServices"
			| "FoundCachedSeverities"
	}
>

/** The cache answered first: show it, then fetch the real rows unless it is fresh. */
export const updateFound = (model: Model, message: FoundMessage, context: PageContext): UpdateReturn => {
	const { key, cached } = message
	const step = (next: Model, which: Parameters<typeof fetchAfterCache>[2]): UpdateReturn => ({
		model: settleRefresh(next),
		commands: next[which].key === key ? fetchAfterCache(next, context, which, cached.isFresh) : [],
	})
	// A cached empty result renders `SignalEmptyState` as a fetched one does.
	if (message._tag === "FoundCachedLogs") {
		if (model.logs.key !== key) return { model }
		const logs = acceptCached(model.logs, key, message.cached, cached.isFresh)
		const shown = loadMoreIfAtEndAfter(
			step({ ...model, logs, logsUpdatedAtMs: cached.updatedAtMs }, "logs"),
			context,
		)
		return withPresence(
			shown,
			Option.exists(AsyncData.getData(logs.data), (data) =>
				data.pages.every((page) => page.length === 0),
			),
		)
	}
	if (message._tag === "FoundCachedPatterns") {
		const patterns = acceptCached(model.patterns, key, message.cached, cached.isFresh)
		const patternsUpdatedAtMs =
			model.patterns.key === key ? cached.updatedAtMs : model.patternsUpdatedAtMs
		const isEmpty =
			model.patterns.key === key &&
			Option.exists(AsyncData.getData(patterns.data), (data) => data.patterns.length === 0)
		return withPresence(step({ ...model, patterns, patternsUpdatedAtMs }, "patterns"), isEmpty)
	}
	if (message._tag === "FoundCachedServices")
		return step(
			{ ...model, services: acceptCached(model.services, key, message.cached, cached.isFresh) },
			"services",
		)
	return step(
		{ ...model, severities: acceptCached(model.severities, key, message.cached, cached.isFresh) },
		"severities",
	)
}

/** A cached page fills the viewport like a fetched one would. */
const loadMoreIfAtEndAfter = (step: UpdateReturn, context: PageContext): UpdateReturn => {
	const more = loadMoreIfAtEnd(step.model, context)
	return { model: more.model, commands: [...(step.commands ?? []), ...(more.commands ?? [])] }
}

/** An empty list renders `SignalEmptyState`, which reads the shared signal presence. */
const withPresence = (step: UpdateReturn, isEmpty: boolean): UpdateReturn =>
	isEmpty ? { ...step, outMessage: PageOutMessage.RequestedSignalPresence() } : step

/** The active mode's main query answered. */
export const updateFetch = (model: Model, message: FetchMessage, context: PageContext): UpdateReturn => {
	if (message._tag === "SucceededFetchLogs") {
		const isCurrent = model.logs.key === message.key
		const next = settleRefresh({
			...model,
			logs: accept(model.logs, message.key, Result.succeed(message.data), message.fetchedAtMs),
			logsUpdatedAtMs: isCurrent ? message.fetchedAtMs : model.logsUpdatedAtMs,
		})
		const isEmpty = isCurrent && message.data.pages.every((page) => page.length === 0)
		return withPresence(loadMoreIfAtEnd(next, context), isEmpty)
	}
	if (message._tag === "FailedFetchLogs")
		return {
			model: settleRefresh({
				...model,
				logs: accept(model.logs, message.key, Result.fail(message.failure)),
			}),
		}
	if (message._tag === "SucceededFetchPatterns") {
		const isCurrent = model.patterns.key === message.key
		const next = settleRefresh({
			...model,
			patterns: accept(model.patterns, message.key, Result.succeed(message.data), message.fetchedAtMs),
			patternsUpdatedAtMs: isCurrent ? message.fetchedAtMs : model.patternsUpdatedAtMs,
		})
		return withPresence({ model: next }, isCurrent && message.data.patterns.length === 0)
	}
	return {
		model: settleRefresh({
			...model,
			patterns: accept(model.patterns, message.key, Result.fail(message.failure)),
		}),
	}
}
