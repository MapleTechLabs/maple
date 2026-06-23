// SPA-side wrapper around the shared `executeLocalQuery` client. The shared
// client (`@maple/query-engine/local`) is environment-agnostic and takes an
// explicit base URL; here we resolve it from the page origin so the same build
// works whether it's served same-origin by the binary (`--offline` / dev proxy)
// or remotely from `local.maple.dev`. Hooks import `executeLocalQuery` from here
// instead of the shared package so they never have to thread the base URL.
import { executeLocalQuery as run } from "@maple/query-engine/local"
import type { CompiledQuery } from "@maple/query-engine/ch"
import { Effect, type Option } from "effect"
import { localApiBase } from "./constants"

function executeLocalQuery<T = Record<string, unknown>>(sql: string, signal?: AbortSignal): Promise<T[]> {
	return run<T>(sql, localApiBase(), signal)
}

export async function executeLocalCompiledQuery<T>(
	compiled: CompiledQuery<T>,
	signal?: AbortSignal,
): Promise<ReadonlyArray<T>> {
	const rows = await executeLocalQuery(compiled.sql, signal)
	return Effect.runPromise(compiled.decodeRows(rows))
}

export async function executeLocalCompiledFirstRow<T>(
	compiled: CompiledQuery<T>,
	signal?: AbortSignal,
): Promise<Option.Option<T>> {
	const rows = await executeLocalQuery(compiled.sql, signal)
	return Effect.runPromise(compiled.decodeFirstRow(rows))
}
