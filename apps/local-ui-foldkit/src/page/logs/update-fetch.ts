import { Result } from "effect"
import { accept } from "../../data/slot"
import { type PageContext, PageOutMessage } from "../contract"
import type { Message } from "./message"
import type { Model } from "./model"
import { loadMoreIfAtEnd } from "./stream"
import { settleRefresh, type UpdateReturn } from "./update"

type FetchMessage = Extract<
	Message,
	{ readonly _tag: "SucceededFetchLogs" | "FailedFetchLogs" | "SucceededFetchPatterns" | "FailedFetchPatterns" }
>

/** An empty list renders `SignalEmptyState`, which reads the shared signal presence. */
const withPresence = (step: UpdateReturn, isEmpty: boolean): UpdateReturn =>
	isEmpty ? { ...step, outMessage: PageOutMessage.RequestedSignalPresence() } : step

/** The active mode's main query answered. */
export const updateFetch = (model: Model, message: FetchMessage, context: PageContext): UpdateReturn => {
	if (message._tag === "SucceededFetchLogs") {
		const isCurrent = model.logs.key === message.key
		const next = settleRefresh({
			...model,
			logs: accept(model.logs, message.key, Result.succeed(message.data)),
			logsUpdatedAtMs: isCurrent ? message.fetchedAtMs : model.logsUpdatedAtMs,
		})
		const isEmpty = isCurrent && message.data.pages.every((page) => page.length === 0)
		return withPresence(loadMoreIfAtEnd(next, context), isEmpty)
	}
	if (message._tag === "FailedFetchLogs")
		return { model: settleRefresh({ ...model, logs: accept(model.logs, message.key, Result.fail(message.failure)) }) }
	if (message._tag === "SucceededFetchPatterns") {
		const isCurrent = model.patterns.key === message.key
		const next = settleRefresh({
			...model,
			patterns: accept(model.patterns, message.key, Result.succeed(message.data)),
			patternsUpdatedAtMs: isCurrent ? message.fetchedAtMs : model.patternsUpdatedAtMs,
		})
		return withPresence({ model: next }, isCurrent && message.data.patterns.length === 0)
	}
	return { model: settleRefresh({ ...model, patterns: accept(model.patterns, message.key, Result.fail(message.failure)) }) }
}
