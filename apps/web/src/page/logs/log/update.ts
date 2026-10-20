import { decodeLogKey, encodeLogKey } from "../../../lib/log-key"
import { getLog } from "@maple/web-data/warehouse/logs"
import { Effect, Option, Schema } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Keyed from "../../../data/keyed"
import { toLoadFailure } from "../../../data/load-failure"
import { requestKey } from "../../../data/request-key"
import type { AppRoute } from "../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { copyToast } from "../../kit/clipboard"
import * as LogDetail from "../detail"
import { Message, type Model } from "./model"

type Return = PageReturn<Model, Message>
type LogRoute = Extract<AppRoute, { readonly _tag: "Log" }>
type LogKey = NonNullable<Model["key"]>

/** `keyToInput`: a decoded key carries empty strings for absent context; the query wants none. */
const keyToInput = (key: LogKey) => ({
	timestamp: key.timestamp,
	serviceName: key.serviceName,
	traceId: key.traceId === "" ? undefined : key.traceId,
	spanId: key.spanId === "" ? undefined : key.spanId,
})

/** `getLogResultAtom({ data: keyToInput(key) })`. */
export const FetchLog = Command.define("FetchLogPageLog", {
	args: {
		key: Schema.String,
		timestamp: Schema.String,
		serviceName: Schema.String,
		traceId: Schema.String,
		spanId: Schema.String,
	},
	messages: [Message.CompletedFetchLog],
	execute: ({ key, ...logKey }) =>
		getLog({ data: keyToInput(logKey) }).pipe(
			Effect.map((response) => response.data),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchLog({ key, result })),
		),
})

const requestLog = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const { key } = model
	if (key === null) return { model }
	const fetchKey = requestKey(context.orgId, "getLog", { data: keyToInput(key) })
	return Option.match(Keyed.request(model.log, fetchKey, mode), {
		onNone: () => ({ model }),
		onSome: (log) => ({ model: { ...model, log }, commands: [FetchLog({ ...key, key: fetchKey })] }),
	})
}

export const init = (route: LogRoute, context: PageContext): Return =>
	requestLog(
		{
			logId: route.logId,
			key: decodeLogKey(route.logId),
			log: Keyed.idle(),
			detail: LogDetail.init("log-page", true),
		},
		context,
		"Load",
	)

const liftDetail = (model: Model, result: ReturnType<typeof LogDetail.update>): Return => ({
	model: { ...model, detail: result.model },
	commands: Command.mapMessages(result.commands ?? [], (message) => Message.GotDetailMessage({ message })),
	outMessage:
		result.outMessage?._tag === "Copied"
			? copyToast(result.outMessage.label, result.outMessage.isOk)
			: undefined,
})

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedFetchLog: ({ key, result }) => {
			// Only an awaited answer opens the panels; a stale or repeated one would reset them.
			const isAwaited =
				model.log.key === key &&
				(AsyncData.isLoading(model.log.data) || AsyncData.isRefreshing(model.log.data))
			if (!isAwaited) return { model }
			const log = Keyed.accept(model.log, key, result)
			const next = { ...model, log }
			return Option.match(Option.flatMap(AsyncData.getData(log.data), Option.fromNullishOr), {
				onNone: () => ({ model: next }),
				onSome: (loaded) => liftDetail(next, LogDetail.show(model.detail, loaded, context)),
			})
		},
		ClickedRetry: () => requestLog(model, context, "Refresh"),
		// `openLog`: a log picked from the trace or the context opens its own page.
		GotDetailMessage: ({ message: inner }) =>
			inner._tag === "ClickedLog"
				? {
						model,
						outMessage: PageOutMessage.RequestedNavigation({
							url: `/logs/${encodeLogKey(inner.log)}`,
							isReplace: false,
						}),
					}
				: liftDetail(model, LogDetail.update(model.detail, inner)),
	})
