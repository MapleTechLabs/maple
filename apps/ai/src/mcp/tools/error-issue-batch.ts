/**
 * Multi-issue calls: one triage pass used to make a thousand sequential single-issue calls with
 * the same note. Each issue still goes through the single-issue service path and its legality
 * checks; a refusal is reported per id instead of failing the whole call.
 */
import { Effect, Option, Schema } from "effect"
import type { ErrorIssueId } from "@maple/domain/http"
import { issueIdParam } from "./error-issue-shared"
import { McpInvalidInputError } from "./types"

export const MAX_BATCH_ISSUES = 200
/** Small, so a 200-issue call stays inside one invocation's connection pool. */
const BATCH_CONCURRENCY = 4

const decodeIssueId = Schema.decodeUnknownOption(issueIdParam())

export interface IssueBatchResult {
	readonly id: string
	readonly ok: boolean
	readonly fromState?: string
	readonly workflowState?: string
	readonly error?: string
}

/** Dedupes and caps the list; ids that are not issue UUIDs become per-id failures. */
export const decodeIssueIds = (raw: ReadonlyArray<string>, parameter: string) => {
	const unique = Array.from(new Set(raw.map((value) => value.trim()).filter((value) => value !== "")))
	if (unique.length === 0) {
		return Effect.fail(new McpInvalidInputError({ message: `${parameter} is empty.`, parameter }))
	}
	if (unique.length > MAX_BATCH_ISSUES) {
		return Effect.fail(
			new McpInvalidInputError({
				message: `${parameter} has ${unique.length} ids; at most ${MAX_BATCH_ISSUES} per call. Split the list.`,
				parameter,
			}),
		)
	}
	return Effect.succeed(unique.map((value) => ({ raw: value, id: decodeIssueId(value) })))
}

/** Runs `run` for every decoded id and folds each outcome into an `IssueBatchResult`. */
export const runIssueBatch = <E extends { readonly message: string }, R>(
	entries: ReadonlyArray<{ readonly raw: string; readonly id: Option.Option<ErrorIssueId> }>,
	run: (
		id: ErrorIssueId,
	) => Effect.Effect<{ readonly fromState?: string; readonly workflowState: string }, E, R>,
) =>
	Effect.forEach(
		entries,
		(entry): Effect.Effect<IssueBatchResult, never, R> =>
			Option.match(entry.id, {
				onNone: () =>
					Effect.succeed({
						id: entry.raw,
						ok: false,
						error: "Not an issue UUID (use an id from list_error_issues; a fingerprint is not one).",
					}),
				onSome: (id) =>
					run(id).pipe(
						Effect.match({
							onFailure: (error) => ({ id: entry.raw, ok: false, error: error.message }),
							onSuccess: (moved) => ({ id: entry.raw, ok: true, ...moved }),
						}),
					),
			}),
		{ concurrency: BATCH_CONCURRENCY },
	)
