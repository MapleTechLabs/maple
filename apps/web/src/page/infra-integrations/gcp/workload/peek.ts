import {
	gcpStatementTextPrefix,
	type GcpStatement,
	type GcpTracedStatement,
} from "../../../../components/infra/gcp/cloud-sql-signals"
import type { TimeWindow } from "../../../../data/time-range"
import { AppRoute, hrefOf } from "../../../../route"
import type { StatementSpansInput } from "../data"

// `GcpQueryPeekSheet`'s subject: the statement `search.peek` names, where it sits in the table and
// what the traces know of it.

export type QueryPeek = Readonly<{
	statement: GcpStatement
	traced: GcpTracedStatement | undefined
	/** The instance's databases the traces queried; the spans are looked up in these. */
	databases: ReadonlyArray<string>
	index: number
	count: number
}>

/** The peek on the page on screen; a hash no statement has means the sheet is closed. */
export const resolveQueryPeek = (
	statements: ReadonlyArray<GcpStatement>,
	traced: ReadonlyMap<string, GcpTracedStatement>,
	databases: ReadonlyArray<string>,
	queryHash: string | undefined,
): QueryPeek | null => {
	const index = queryHash === undefined ? -1 : statements.findIndex((row) => row.queryHash === queryHash)
	const statement = statements[index]
	if (statement === undefined) return null
	return { statement, traced: traced.get(statement.queryHash), databases, index, count: statements.length }
}

/** The request limits of `GcpCloudSqlStatementSpansRequest`. */
const MAX_DATABASES = 32
const MAX_QUERY_KEYS = 16

/** The spans read of a traced statement; null when the traces never recorded it. */
export const statementSpansInput = (peek: QueryPeek, window: TimeWindow): StatementSpansInput | null => {
	const queryKeys = peek.traced?.queryKeys ?? []
	if (queryKeys.length === 0 || peek.databases.length === 0) return null
	return {
		startTime: window.startTime,
		endTime: window.endTime,
		databases: peek.databases.slice(0, MAX_DATABASES),
		queryKeys: queryKeys.slice(0, MAX_QUERY_KEYS),
	}
}

type TimeSearch = Readonly<{ startTime?: string; endTime?: string; timePreset?: string }>

/**
 * The Traces list narrowed to the statement: its callers' spans whose text contains its start. A
 * superset of its spans (the text is matched up to the first placeholder), the panel's own list
 * being the exact one.
 */
export const statementTracesHref = (peek: QueryPeek, timeSearch: TimeSearch): string => {
	const prefix = gcpStatementTextPrefix(peek.statement.querystring)
	const traced = peek.traced
	// Only a complete list of callers narrows: `services` holds the busiest when there are more.
	const services =
		traced === undefined || traced.serviceCount > traced.services.length ? [] : traced.services
	return hrefOf(
		AppRoute.Traces({
			search: {
				...timeSearch,
				// A query's span is never a trace's root: filter every span.
				rootOnly: false,
				services: services.length === 0 ? undefined : [...services],
				attributeFilters:
					prefix === null
						? undefined
						: [
								{
									key: "db.query.text",
									value: prefix,
									matchMode: "contains",
									or: [{ key: "db.statement", value: prefix, matchMode: "contains" }],
								},
							],
			},
		}),
	)
}
