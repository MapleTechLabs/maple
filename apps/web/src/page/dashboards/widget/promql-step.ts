import { formatWarehouseDateTime } from "@maple/query-engine/datetime"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { discoverPromql } from "@maple/web-data/warehouse/promql-chart"
import {
	Array as Arr,
	Clock,
	Duration,
	Effect,
	Option,
	Record as Rec,
	Result,
	Schema,
	String as Str,
} from "effect"
import { Command } from "foldkit"
import type { PageContext } from "../../contract"
import { Message } from "./message"
import type { Model } from "./model"
import {
	isRunnablePromql,
	promqlContextOf,
	promqlSuggestionsOf,
	type PromqlDraft,
	type PromqlState,
} from "./promql"
import { type PromqlCompletionContext, promqlParseError } from "./promql-complete"
import { DISCOVERY_PAGE, discoveryKey, discoveryRequestsFor } from "./promql-suggest"
import { planPreview, type Return } from "./update"

export const PROMQL_TEXTAREA_ID = "widget-editor-promql"

/** How long typing must pause before the query is parsed. */
const PARSE_DELAY = Duration.millis(250)
/** The window names and values are discovered over. */
const DISCOVERY_WINDOW_MS = 24 * 60 * 60 * 1000

export const DelayPromqlParse = Command.define("DelayWidgetPromqlParse", {
	args: { seq: Schema.Number },
	messages: [Message.ElapsedPromqlParseDelay],
	execute: ({ seq }) => Effect.as(Effect.sleep(PARSE_DELAY), Message.ElapsedPromqlParseDelay({ seq })),
})

/** The textarea's caret, read after the browser applied an edit or a move. */
export const ReadPromqlCaret = Command.define("ReadWidgetPromqlCaret", {
	args: { id: Schema.String, opens: Schema.Boolean },
	messages: [Message.GotPromqlCaret],
	execute: ({ id, opens }) =>
		Effect.sync(() => {
			const element = document.getElementById(id)
			const caret = element instanceof HTMLTextAreaElement ? element.selectionStart : 0
			return Message.GotPromqlCaret({ caret, opens })
		}),
})

/** Editing continues after a pick: the caret lands after the inserted text. */
export const FocusPromqlCaret = Command.define("FocusWidgetPromqlCaret", {
	args: { id: Schema.String, caret: Schema.Number },
	messages: [Message.CompletedFocusPromql],
	execute: ({ id, caret }) =>
		Effect.sync(() => {
			const element = document.getElementById(id)
			if (element instanceof HTMLTextAreaElement) {
				element.focus()
				element.setSelectionRange(caret, caret)
			}
			return Message.CompletedFocusPromql()
		}),
})

/** Label names or one label's values over the last 24 h, for the autocomplete. */
export const FetchPromqlDiscovery = Command.define("FetchWidgetPromqlDiscovery", {
	args: {
		key: Schema.String,
		label: Schema.optional(Schema.String),
		match: Schema.optional(Schema.String),
	},
	messages: [Message.CompletedFetchPromqlDiscovery],
	execute: ({ key, label, match }) =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			return yield* discoverPromql({
				startTime: formatWarehouseDateTime(now - DISCOVERY_WINDOW_MS),
				endTime: formatWarehouseDateTime(now),
				...(label === undefined ? undefined : { label }),
				...(match === undefined ? undefined : { match }),
				limit: DISCOVERY_PAGE,
			})
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchPromqlDiscovery({ key, result })),
		),
})

type Commands = NonNullable<Return["commands"]>

type PromqlMessage = Extract<
	Message,
	{
		readonly _tag:
			| "ChangedPromql"
			| "ChangedPromqlLegend"
			| "ChangedPromqlMinStep"
			| "ElapsedPromqlParseDelay"
			| "GotPromqlCaret"
			| "PressedPromqlKey"
			| "ReleasedPromqlKey"
			| "ClickedPromqlEditor"
			| "BlurredPromqlEditor"
			| "PickedPromqlSuggestion"
			| "CompletedFocusPromql"
			| "CompletedFetchPromqlDiscovery"
	}
>

const withDraft = (model: Model, change: (draft: PromqlDraft) => PromqlDraft): Model =>
	model.promql === null
		? model
		: { ...model, promql: { ...model.promql, draft: change(model.promql.draft) } }

/** The min step input: empty is auto, anything else at least one second. */
const minStepOf = (value: string): number | null => {
	const parsed = Number(value)
	return value === "" || !Number.isFinite(parsed) ? null : Math.max(1, parsed)
}

/** The dashboard's variable names, which complete as `$name`. */
export const promqlVariablesOf = (model: Model): ReadonlyArray<string> =>
	Arr.map(model.document?.variables ?? [], (variable) => variable.name)

/** Keys that move the caret without an edit: the list follows the caret after them. */
const CARET_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"])

/** The discovery read the open list needs, asked once per editor session. */
const askDiscovery = (promql: PromqlState): Readonly<{ promql: PromqlState; commands: Commands }> => {
	const context = promqlContextOf(promql)
	const requests = context === null ? [] : discoveryRequestsFor(context, promql.discovery, promql.isSettled)
	const missing = Arr.filter(
		requests,
		(request) => !Arr.contains(promql.discovery.requested, discoveryKey(request)),
	)
	return {
		promql: {
			...promql,
			discovery: {
				...promql.discovery,
				requested: [...promql.discovery.requested, ...Arr.map(missing, discoveryKey)],
			},
		},
		commands: Arr.map(missing, (request) =>
			FetchPromqlDiscovery({ key: discoveryKey(request), ...request }),
		),
	}
}

const NAME_TAIL = /^[A-Za-z0-9_:.]*/
// A duration stops before a subquery's `:` step.
const DURATION_TAIL = /^[A-Za-z0-9_]*/
const QUOTED_TAIL = { '"': /^(?:\\.|[^\\"\n])*/, "'": /^(?:\\.|[^\\'\n])*/, "`": /^[^`]*/ }

/** Where a pick's replacement ends: through the rest of the word (or quoted value) under the caret. */
const replaceEnd = (query: string, caret: number, context: PromqlCompletionContext): number => {
	const after = Str.slice(caret)(query)
	// A quoted value runs to its first unescaped quote; an escaped one is part of the value.
	const tail =
		context.kind === "labelValue" && context.quote !== null
			? context.quote === "'"
				? QUOTED_TAIL["'"]
				: context.quote === "`"
					? QUOTED_TAIL["`"]
					: QUOTED_TAIL['"']
			: context.kind === "duration"
				? DURATION_TAIL
				: NAME_TAIL
	return caret + Option.match(Str.match(tail)(after), { onNone: () => 0, onSome: ([text]) => text.length })
}

/** The reads the open list needs; once typing has paused they include the narrowed metric prefix. */
const withPromql = (model: Model, promql: PromqlState, commands: Commands = []): Return => {
	const asked = askDiscovery(promql)
	return { model: { ...model, promql: asked.promql }, commands: [...commands, ...asked.commands] }
}

/** The highlighted (or picked) suggestion written over what the caret had typed. */
const accept = (model: Model, promql: PromqlState, index: number): Return => {
	const context = promqlContextOf(promql)
	const suggestion = promqlSuggestionsOf(promql, promqlVariablesOf(model))[index]
	if (context === null || suggestion === undefined)
		return { model: { ...model, promql: { ...promql, completion: null } } }
	const query = promql.draft.query
	const next =
		Str.slice(0, context.from)(query) +
		suggestion.insert +
		Str.slice(replaceEnd(query, promql.caret, context))(query)
	const caret = context.from + suggestion.insert.length
	const seq = promql.parseSeq + 1
	return withPromql(
		model,
		{
			...promql,
			draft: { ...promql.draft, query: next },
			caret,
			parseSeq: seq,
			isSettled: false,
			// A call keeps the list open on its first argument.
			completion: Str.endsWith("(")(suggestion.insert) ? { activeIndex: 0 } : null,
		},
		[FocusPromqlCaret({ id: PROMQL_TEXTAREA_ID, caret }), DelayPromqlParse({ seq })],
	)
}

const pressed = (model: Model, promql: PromqlState, key: string): Return => {
	const count = promqlSuggestionsOf(promql, promqlVariablesOf(model)).length
	const active = promql.completion?.activeIndex ?? 0
	switch (key) {
		case " ":
			return { model, commands: [ReadPromqlCaret({ id: PROMQL_TEXTAREA_ID, opens: true })] }
		case "ArrowDown":
		case "ArrowUp": {
			const step = key === "ArrowDown" ? 1 : -1
			const activeIndex = count === 0 ? 0 : (active + step + count) % count
			return { model: { ...model, promql: { ...promql, completion: { activeIndex } } } }
		}
		case "Enter":
		case "Tab":
			return accept(model, promql, active)
		default:
			return { model: { ...model, promql: { ...promql, completion: null } } }
	}
}

const promqlEditorStep = (model: Model, promql: PromqlState, message: PromqlMessage): Return => {
	switch (message._tag) {
		case "ChangedPromql": {
			const seq = promql.parseSeq + 1
			return {
				model: {
					...model,
					promql: {
						...promql,
						draft: { ...promql.draft, query: message.value },
						parseSeq: seq,
						isSettled: false,
					},
				},
				commands: [
					DelayPromqlParse({ seq }),
					ReadPromqlCaret({ id: PROMQL_TEXTAREA_ID, opens: true }),
				],
			}
		}
		case "ElapsedPromqlParseDelay":
			return message.seq !== promql.parseSeq
				? { model }
				: withPromql(model, {
						...promql,
						parseError: promqlParseError(promql.draft.query),
						isSettled: true,
					})
		case "GotPromqlCaret": {
			const isOpen = message.opens || promql.completion !== null
			return withPromql(model, {
				...promql,
				caret: message.caret,
				completion: isOpen ? { activeIndex: 0 } : null,
			})
		}
		case "PressedPromqlKey":
			return pressed(model, promql, message.key)
		case "ReleasedPromqlKey":
			return promql.completion !== null && CARET_KEYS.has(message.key)
				? { model, commands: [ReadPromqlCaret({ id: PROMQL_TEXTAREA_ID, opens: false })] }
				: { model }
		case "ClickedPromqlEditor":
			return { model, commands: [ReadPromqlCaret({ id: PROMQL_TEXTAREA_ID, opens: false })] }
		case "BlurredPromqlEditor":
			return { model: { ...model, promql: { ...promql, completion: null } } }
		case "PickedPromqlSuggestion":
			return accept(model, promql, message.index)
		case "CompletedFetchPromqlDiscovery": {
			// A failed read completes nothing rather than retrying on every keystroke.
			const values = Result.isSuccess(message.result) ? message.result.success : []
			// A full page of metrics may send the typed prefix for the names past it.
			return withPromql(model, {
				...promql,
				discovery: {
					...promql.discovery,
					entries: Rec.set(promql.discovery.entries, message.key, values),
				},
			})
		}
		default:
			return { model }
	}
}

export const promqlStep = (model: Model, message: PromqlMessage): Return => {
	switch (message._tag) {
		case "ChangedPromqlLegend":
			return { model: withDraft(model, (draft) => ({ ...draft, legendFormat: message.value })) }
		case "ChangedPromqlMinStep":
			return {
				model: withDraft(model, (draft) => ({ ...draft, minStepSeconds: minStepOf(message.value) })),
			}
		default:
			return model.promql === null ? { model } : promqlEditorStep(model, model.promql, message)
	}
}

/** The draft taken as the opened one, so a discarded or saved draft no longer reads as dirty. */
export const savedPromql = (model: Model): PromqlState | null =>
	model.promql === null ? null : { ...model.promql, initial: model.promql.draft }

/** Run preview in PromQL: the draft is staged and the preview re-planned, unless the query does not parse. */
export const runPromqlPreview = (model: Model, context: PageContext): Return =>
	model.promql === null || !isRunnablePromql(model.promql)
		? { model }
		: planPreview({ ...model, promql: { ...model.promql, staged: model.promql.draft } }, context)
