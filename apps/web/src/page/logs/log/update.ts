import { decodeLogKey, encodeLogKey } from "@maple/views/lib/log-key"
import { getLog } from "@maple/web-data/warehouse/logs"
import { Effect, Option, Schema } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Keyed from "@maple/views/data/keyed"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { requestKey } from "@maple/views/data/request-key"
import type { AppRoute } from "../../../route"
import { LOG_PAGE_PATH, logPageHref } from "../log-links"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { copyToast } from "../../kit/clipboard"
import * as LogDetail from "@maple/views/logs/log-sheet"
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
			detail: LogDetail.init("log-page", { isPage: true, logPagePath: LOG_PAGE_PATH }),
		},
		context,
		"Load",
	)

const navigateTo = (url: string) => PageOutMessage.RequestedNavigation({ url, isReplace: false })

/** The panels' asks: a copy toasts, a picked log opens its own page. */
const pageOutMessage = (out: LogDetail.OutMessage | undefined) =>
	out === undefined
		? undefined
		: LogDetail.OutMessage.match(out, {
				Copied: ({ label, isOk }) => copyToast(label, isOk),
				SelectedLog: ({ log }) => navigateTo(logPageHref(encodeLogKey(log))),
				// The page's attributes have no Filter action, and there is no sheet to close.
				ChoseAttributeFilter: () => undefined,
				Closed: () => undefined,
			})

const liftDetail = (model: Model, result: LogDetail.Return): Return => ({
	model: { ...model, detail: result.model },
	commands: Command.mapMessages(result.commands ?? [], (message) => Message.GotDetailMessage({ message })),
	outMessage: pageOutMessage(result.outMessage),
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
		GotDetailMessage: ({ message: inner }) => liftDetail(model, LogDetail.update(model.detail, inner)),
	})
