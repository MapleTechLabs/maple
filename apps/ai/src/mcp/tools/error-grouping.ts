import type { McpToolRegistrar } from "./types"
import { Effect, Option, Schema, Array as Arr, String as Str } from "effect"
import type { ErrorIssueFingerprintGrouping } from "@maple/domain/http"
import { ErrorGroupingService } from "@maple/backend/services/errors/ErrorGroupingService"
import { ErrorIssueMergeService } from "@maple/backend/services/errors/ErrorIssueMergeService"
import { CurrentMcpTenant } from "../tenant"
import { resolveActorId } from "../lib/resolve-actor"
import { warehouseReadToMcpHandlers } from "../lib/map-warehouse-error"
import * as P from "../lib/params"
import { doc, type NextCall } from "../lib/tool-doc"
import { issueIdParam, issueNotFound, persistenceFailed, validationFailed } from "./error-issue-shared"
import { McpInvalidInputError } from "./types"

const SOURCE_WORDS = {
	primary: "the issue's own fingerprint",
	merge: "folded in by a merge",
	rekey: "carried over by a version re-key",
	group: "joined by the grouping key",
} satisfies Record<ErrorIssueFingerprintGrouping["source"], string>

/** The rule that keyed a fingerprint, in words a model can check against its frames and message. */
export const describeRule = (fingerprint: ErrorIssueFingerprintGrouping): string => {
	switch (fingerprint.rule) {
		case null:
			return "not keyed: no recent sample, so it groups with nothing"
		case "custom":
			return `custom: the error's maple.fingerprint key${fingerprint.customKey === null ? "" : ` "${fingerprint.customKey}"`}`
		case "span":
			return "span: no exception recorded, keyed on the failing span"
		case "org-rule":
			return `org-rule: the org's grouping rule ${fingerprint.orgRule ?? "(unnamed)"}`
		case "chunk-load":
			return "chunk-load: every chunk the service failed to load, grouped together"
		case "type-message":
			return "type-message: same error type and message"
		case "type-function":
			return `type-function: same type, first named function ${Option.getOrElse(Arr.head(fingerprint.frames), () => "(unknown)")}`
		case "frames":
			return "frames: generic error type, keyed on these frames and the message"
	}
}

const frameList = (frames: ReadonlyArray<string>) => (frames.length === 0 ? "none" : Arr.join(frames, " > "))

export function registerErrorGroupingTools(server: McpToolRegistrar) {
	server.define({
		name: "explain_error_grouping",
		title: "Explain Error Grouping",
		description:
			"Explain why an error issue holds the fingerprints it does: for each one, how it got there (the issue's own, a merge, a version re-key, or the grouping key) and which rule keyed it, with the message signature and the stack frames read and skipped. Use it when an issue looks like it mixes unrelated bugs.",
		parameters: Schema.Struct({ issue_id: issueIdParam() }),
		untrustedOutput: true,
		hints: { readOnly: true },
		phrases: ["Checking how errors were grouped"],
		handler: Effect.fn("McpTool.explainErrorGrouping")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "maple.issue.id": params.issue_id })
			const grouping = yield* ErrorGroupingService
			const result = yield* grouping.explainIssue(tenant.orgId, params.issue_id).pipe(
				Effect.catchTags({
					"@maple/http/errors/ErrorIssueNotFoundError": issueNotFound,
					"@maple/http/errors/ErrorPersistenceError": persistenceFailed("explain_error_grouping"),
					...warehouseReadToMcpHandlers("explain_error_grouping"),
				}),
			)
			return {
				issueId: params.issue_id,
				fingerprints: result.fingerprints,
				truncated: result.truncated,
			}
		}),
		render: (output) => {
			const detachable = Arr.filter(output.fingerprints, (fp) => fp.source === "group" && !fp.pinned)
			const detachNext = Arr.map(Arr.take(detachable, 1), (fp): NextCall =>
				doc.next(
					"detach_error_fingerprint",
					{ issue_id: output.issueId, fingerprint: fp.fingerprintHash },
					"only if this grouped fingerprint is a different bug",
				),
			)
			return {
				title: `Grouping for ${output.fingerprints.length} fingerprint${output.fingerprints.length === 1 ? "" : "s"}`,
				scope: [["Issue", output.issueId]],
				untrusted: true,
				blocks: Arr.flatMap(output.fingerprints, (fp) => [
					doc.heading(fp.fingerprintHash),
					doc.fields([
						["Source", SOURCE_WORDS[fp.source]],
						["Rule", describeRule(fp)],
						["Type", fp.exceptionType],
						["Message", fp.messageSignature],
						["Frames read", frameList(fp.frames)],
						["Frames skipped", frameList(fp.skippedFrames)],
						["Pinned", fp.pinned ? "yes, never grouped again" : "no"],
						["Sampled", fp.sampledAt ?? "no sample"],
					]),
				]),
				notices: output.truncated
					? ["More fingerprints than one call explains; the rest are left out."]
					: [],
				next: [
					...detachNext,
					doc.next(
						"list_similar_error_issues",
						{ issue_id: output.issueId },
						"find duplicates split off",
					),
				],
			}
		},
	})

	server.define({
		name: "list_similar_error_issues",
		title: "List Similar Error Issues",
		description:
			"List open issues that may be the same bug as this one: same service and error type, with a similar message, most similar first. These are suggestions only; check that each shares the root cause before merging it.",
		parameters: Schema.Struct({ issue_id: issueIdParam() }),
		untrustedOutput: true,
		hints: { readOnly: true },
		phrases: ["Looking for duplicate issues"],
		handler: Effect.fn("McpTool.listSimilarErrorIssues")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "maple.issue.id": params.issue_id })
			const grouping = yield* ErrorGroupingService
			const result = yield* grouping.similarIssues(tenant.orgId, params.issue_id).pipe(
				Effect.catchTags({
					"@maple/http/errors/ErrorIssueNotFoundError": issueNotFound,
					"@maple/http/errors/ErrorPersistenceError":
						persistenceFailed("list_similar_error_issues"),
				}),
			)
			yield* Effect.annotateCurrentSpan("result.rowCount", result.issues.length)
			return { issueId: params.issue_id, issues: result.issues }
		}),
		render: (output) => {
			const scope: ReadonlyArray<readonly [string, string]> = [["Issue", output.issueId]]
			if (output.issues.length === 0) {
				return {
					title: "No similar issues",
					scope,
					empty: { message: "No open issue of the same service and type has a similar message." },
					blocks: [],
				}
			}
			return {
				title: `${output.issues.length} similar issue${output.issues.length === 1 ? "" : "s"}`,
				scope,
				untrusted: true,
				blocks: [
					doc.table(
						["Id", "Similarity", "Service", "Error", "State", "Events", "Last seen"],
						Arr.map(output.issues, (issue) => [
							issue.id,
							`${Math.round(issue.similarity * 100)}%`,
							issue.serviceName,
							issue.errorLabel,
							issue.workflowState,
							String(issue.occurrenceCount),
							issue.lastSeenAt,
						]),
					),
					doc.text(
						"Similar text is not proof of one bug: compare stacks and causes (error_detail, list_error_issue_events) before merging.",
					),
				],
				next: Arr.map(Arr.take(output.issues, 1), (issue): NextCall =>
					doc.next(
						"merge_error_issues",
						{ issue_id: output.issueId, merge_issue_ids: [issue.id] },
						"only after confirming the same root cause",
					),
				),
			}
		},
	})

	server.define({
		name: "detach_error_fingerprint",
		title: "Detach Error Fingerprint",
		description:
			"Split one fingerprint off an error issue that the grouping key put there by mistake. Only fingerprints joined by the grouping key detach (source `group` in explain_error_grouping); one folded in by a merge is unmerged from the dashboard instead, and the issue's own fingerprint stays. The detached fingerprint is pinned, so its next occurrence opens an issue of its own.",
		parameters: Schema.Struct({
			issue_id: issueIdParam("The issue holding the fingerprint, from list_error_issues"),
			fingerprint: P.text("The fingerprint to split off, from explain_error_grouping"),
		}),
		hints: { readOnly: false, destructive: false, idempotent: false },
		phrases: ["Detaching a fingerprint"],
		handler: Effect.fn("McpTool.detachErrorFingerprint")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const fingerprintHash = Str.trim(params.fingerprint)
			if (fingerprintHash.length === 0) {
				return yield* new McpInvalidInputError({
					message: "fingerprint is empty. Use a fingerprint from explain_error_grouping.",
					parameter: "fingerprint",
				})
			}
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "maple.issue.id": params.issue_id })
			const actorId = yield* resolveActorId(tenant)
			const merges = yield* ErrorIssueMergeService
			const issue = yield* merges
				.detachFingerprint(tenant.orgId, actorId, params.issue_id, fingerprintHash)
				.pipe(
					Effect.catchTags({
						"@maple/http/errors/ErrorIssueNotFoundError": issueNotFound,
						"@maple/http/errors/ErrorValidationError": validationFailed("fingerprint"),
						"@maple/http/errors/ErrorPersistenceError":
							persistenceFailed("detach_error_fingerprint"),
					}),
				)
			return {
				id: issue.id,
				detachedFingerprintHash: fingerprintHash,
				fingerprintHashes: [...issue.fingerprintHashes],
				occurrenceCount: issue.occurrenceCount,
				workflowState: issue.workflowState,
				serviceName: issue.serviceName,
			}
		}),
		render: (output) => ({
			title: `Detached ${output.detachedFingerprintHash}`,
			blocks: [
				doc.fields([
					["Issue", output.id],
					["Detached", output.detachedFingerprintHash],
					["Fingerprints left", String(output.fingerprintHashes.length)],
					["Occurrences", String(output.occurrenceCount)],
					["State", output.workflowState],
					["Service", output.serviceName],
				]),
				doc.text(
					"The detached fingerprint is pinned: its next occurrence opens an issue of its own.",
				),
			],
		}),
	})
}
