// SPA-side wrapper around the shared local query client. The shared client
// (`@maple/query-engine/local`) is environment-agnostic and takes an explicit
// base URL; here we resolve it from the page origin so the same build works
// same-origin (`--offline` / dev proxy) or remotely from `local.maple.dev`.
import { LocalQueryUnreachable, runLocalQuery, type LocalQueryRow } from "@maple/query-engine/local"
import type { CompiledQuery, CompiledQueryInput } from "@maple/query-engine/ch"
import { Effect, type Option } from "effect"
import { localApiBase, LOCAL_ORG_ID } from "./constants"
import type { TimeBounds } from "./time"

function executeLocalQuery(sql: string, signal?: AbortSignal): Promise<ReadonlyArray<LocalQueryRow>> {
	return runLocalQuery(sql, localApiBase(), signal)
}

/**
 * `CH.compile` is Effect-returning, so hooks hand us the effect. Resolving it
 * here keeps every hook a one-liner, and a compile failure rejects the promise
 * the same way a query failure does.
 */
const resolve = <T>(compiled: CompiledQueryInput<T>): Promise<CompiledQuery<T>> =>
	Effect.isEffect(compiled) ? Effect.runPromise(compiled) : Promise.resolve(compiled)

/**
 * Pass TanStack's `signal` through: chDB runs one query at a time, so an
 * abandoned query that keeps running delays every query queued behind it.
 */
export async function executeLocalCompiledQuery<T>(
	compiled: CompiledQueryInput<T>,
	signal?: AbortSignal,
): Promise<ReadonlyArray<T>> {
	const query = await resolve(compiled)
	const rows = await executeLocalQuery(query.sql, signal)
	return Effect.runPromise(query.decodeRows(rows))
}

export async function executeLocalCompiledFirstRow<T>(
	compiled: CompiledQueryInput<T>,
	signal?: AbortSignal,
): Promise<Option.Option<T>> {
	const query = await resolve(compiled)
	const rows = await executeLocalQuery(query.sql, signal)
	return Effect.runPromise(query.decodeFirstRow(rows))
}

/** The org + window params nearly every local query compiles with. */
export function localParams(bounds: TimeBounds): { orgId: string; startTime: string; endTime: string } {
	return { orgId: LOCAL_ORG_ID, startTime: bounds.startTime, endTime: bounds.endTime }
}

/** An infinite query's first page param: no cursor yet, typed as the cursor it will become. */
export const noCursor = <Cursor>(): Cursor | undefined => undefined

/** A key-stable form of bounds for query keys. */
export function boundsKey(bounds: TimeBounds): string {
	return `${bounds.startTime}/${bounds.endTime}`
}

/**
 * Only a request that never got an answer is worth retrying. A 400 (bad or
 * read-only SQL) or a decode failure fails the same way every time.
 */
export function shouldRetryLocalQuery(failureCount: number, error: unknown): boolean {
	return failureCount < 2 && error instanceof LocalQueryUnreachable
}
