import { toQueryBuilderMetricType } from "@maple/query-model"
import type { WhereClauseAutocompleteValues } from "../../../lib/query-builder/where-clause-autocomplete"
import { Command } from "foldkit"
import type { TimeWindow } from "../../../data/time-range"
import type { WhereFieldMessage } from "../where-field"
import type { WhereValuesRequest } from "../where-field-command"
import { type ActiveKeyKind, updateWhereFields, type WhereFieldSpec } from "../where-field-update"
import { QueryChange } from "./change"
import type { QueryDraft } from "./draft"
import { Message, type Model, OutMessage } from "./panel-message"

// `WhereClauseEditor` inside a `QueryPanel`: one `WhereFields` field per query, keyed by query id.

/** What the host knows that the panel needs to complete a where clause. */
export type PanelInputs = Readonly<{
	queryOf: (queryId: string) => QueryDraft | undefined
	/** `autocompleteValues[query.dataSource]`, metric-scoped keys included. */
	baseValuesOf: (query: QueryDraft) => WhereClauseAutocompleteValues
	orgId: string
	/** The provider's window once it is active; span and resource values are not asked for before. */
	window: TimeWindow | null
}>

export const whereTextareaId = (queryId: string): string => `where-${queryId}`

/** The read for one active key, or none where the key needs no read. */
const requestOf = (
	query: QueryDraft,
	kind: ActiveKeyKind,
	attributeKey: string,
	window: TimeWindow | null,
): WhereValuesRequest | null => {
	if (query.dataSource === "metrics") {
		const metricType = toQueryBuilderMetricType(query.metricType)
		return kind === "attr" && query.metricName !== "" && metricType !== null
			? { _tag: "Metric", attributeKey, metricName: query.metricName, metricType }
			: null
	}
	if (query.dataSource === "product_events" || window === null) return null
	const range = { startTime: window.startTime, endTime: window.endTime, attributeKey }
	return kind === "attr" ? { _tag: "Span", ...range } : { _tag: "Resource", ...range }
}

/** A query's where field over the host's values (`useMetricScopedAutocomplete` included). */
export const whereSpecOf = (
	query: QueryDraft,
	values: WhereClauseAutocompleteValues,
	window: TimeWindow | null,
): WhereFieldSpec => ({
	expression: query.whereClause,
	textareaId: whereTextareaId(query.id),
	dataSource: query.dataSource,
	values,
	requestOf: (kind, attributeKey) => requestOf(query, kind, attributeKey, window),
})

/** The where fields' step; an applied suggestion leaves as the query's where-clause edit. */
export const whereStep = (model: Model, message: WhereFieldMessage, inputs: PanelInputs) => {
	const next = updateWhereFields(model.whereFields, message, {
		specOf: (queryId) => {
			const query = inputs.queryOf(queryId)
			return query === undefined
				? undefined
				: whereSpecOf(query, inputs.baseValuesOf(query), inputs.window)
		},
		orgId: inputs.orgId,
	})
	const commands = Command.mapMessages(next.commands ?? [], (inner) =>
		Message.GotWhereField({ message: inner }),
	)
	const updated = { ...model, whereFields: next.fields }
	return next.change === undefined
		? { model: updated, commands }
		: {
				model: updated,
				commands,
				outMessage: OutMessage.ChangedQuery({
					queryId: next.change.fieldId,
					change: QueryChange.SetText({ field: "whereClause", value: next.change.expression }),
				}),
			}
}
