import { DateTime, Effect, Predicate, Schema } from "effect"
import { ErrorIssueNotFoundError, ErrorsByTypeRequest } from "@maple/domain/http"
import { V2ErrorIssue, V2ErrorIssueDetail } from "@maple/domain/http/v2"
import { ErrorIssueId } from "@maple/domain/primitives"
import { CH, formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"
import { Queries } from "@maple/query-engine/registry"
import { runQueryDefinition } from "@maple/query-engine/runtime"
import type { Dataset, EndpointHandler } from "../../fixtures/dataset.ts"
import { fixtureUuid } from "../../fixtures/identity.ts"
import { parityOrgId, type FixtureWarehouse } from "../warehouse.ts"

/**
 * Error issues live in Postgres in prd, one row per fingerprint the errors tick has seen. The
 * fixture seeds those rows from the warehouse's own `errorsByType` fingerprints, so hub rankings
 * and issue links agree with the warehouse; the detail's charts run the read model's CH queries.
 */

const DAY_MS = 24 * 3_600_000
const decodeIssueId = Schema.decodeUnknownSync(ErrorIssueId)
const encodeIssue = Schema.encodeUnknownEffect(V2ErrorIssue)
const encodeDetail = Schema.encodeUnknownEffect(V2ErrorIssueDetail)

/** The dataset's issues, newest first: the latest is in triage, the rest are being worked. */
const WORKFLOW = ["triage", "in_progress", "todo"] as const
const SEVERITY = ["critical", "high", "medium"] as const

const windowOf = (dataset: Dataset) => {
	const endMs = parseWarehouseDateTime(dataset.now)
	return { startTime: formatWarehouseDateTime(endMs - DAY_MS), endTime: formatWarehouseDateTime(endMs) }
}

const issueRows = (warehouse: FixtureWarehouse, dataset: Dataset) =>
	Effect.gen(function* () {
		const tenant = warehouse.tenantOf(parityOrgId(dataset.identity?.orgId ?? "org_parity_signed_out"))
		const window = windowOf(dataset)
		const rows = yield* runQueryDefinition(
			warehouse.executor,
			Queries.errorsByType,
			tenant,
			new ErrorsByTypeRequest(window),
		)
		return yield* Effect.forEach(rows, (row, index) =>
			Effect.gen(function* () {
				const sample = yield* warehouse.executor.compiledQuery(
					tenant,
					CH.compile(CH.errorIssueSampleTracesQuery({ limit: 1 }), {
						orgId: tenant.orgId,
						fingerprintHash: row.fingerprintHash,
						...window,
					}),
					{ profile: "list", context: "errorIssueSampleTraces" },
				)
				const state = WORKFLOW[Math.min(index, WORKFLOW.length - 1)] ?? "todo"
				return {
					id: decodeIssueId(fixtureUuid(4, index + 1)),
					object: "error_issue" as const,
					kind: "error" as const,
					fingerprint_hash: row.fingerprintHash,
					service_name: sample[0]?.serviceName ?? "",
					exception_type: row.errorLabel,
					exception_message: row.sampleMessage,
					error_label: row.errorLabel,
					top_frame: "",
					workflow_state: state,
					priority: index + 1,
					severity: SEVERITY[Math.min(index, SEVERITY.length - 1)] ?? "medium",
					severity_source: "detector" as const,
					source_ref: null,
					assigned_actor: null,
					lease_holder: null,
					lease_expires_at: null,
					claimed_at: null,
					notes: null,
					first_seen_at: DateTime.formatIso(row.firstSeen),
					last_seen_at: DateTime.formatIso(row.lastSeen),
					occurrence_count: row.count,
					resolved_at: null,
					last_resolved_at: null,
					last_regressed_at: null,
					regression_count: 0,
					resolved_versions: [],
					snooze_until: null,
					archived_at: null,
					has_open_incident: index === 0,
					comment_count: 0,
					open_pull_request_count: 0,
					merged_pull_request_count: 0,
				}
			}),
		)
	})

export type SeededIssue = Effect.Success<ReturnType<typeof issueRows>>[number]

const OPEN_STATES: ReadonlyArray<string> = ["triage", "regressed", "todo", "in_progress", "in_review"]
const str = (value: unknown, key: string): string | undefined => {
	const field = Predicate.hasProperty(value, key) ? value[key] : undefined
	return typeof field === "string" ? field : undefined
}
const toWarehouse = (iso: string | undefined, fallback: string) =>
	iso === undefined ? fallback : formatWarehouseDateTime(parseWarehouseDateTime(iso))

/** `list` filters the hub sends: fingerprint ranking, view state, service and kind. */
const matches = (query: unknown) => (issue: SeededIssue) => {
	const state = str(query, "state")
	const service = str(query, "service_name")
	const workflow = str(query, "workflow_state")
	const kind = str(query, "kind")
	return (
		(state === undefined || OPEN_STATES.includes(issue.workflow_state) === (state === "open")) &&
		(service === undefined || issue.service_name === service) &&
		(workflow === undefined || issue.workflow_state === workflow) &&
		(kind === undefined || issue.kind === kind)
	)
}

const ranked = (issues: ReadonlyArray<SeededIssue>, query: unknown) => {
	const hashes = str(query, "fingerprint_hash")
	if (hashes === undefined) return issues
	return hashes
		.split(",")
		.map((hash) => hash.trim())
		.flatMap((hash) => issues.filter((issue) => issue.fingerprint_hash === hash))
}

const list = (data: ReadonlyArray<unknown>) => ({ object: "list", data, has_more: false, next_cursor: null })

export const errorIssueEndpoints = (
	warehouse: FixtureWarehouse,
): Readonly<Record<string, EndpointHandler>> => {
	// Seeded once per dataset, like the Postgres rows they stand in for.
	const seeded = new Map<string, Effect.Effect<ReadonlyArray<SeededIssue>, unknown>>()
	const issuesOf = (dataset: Dataset) => {
		const existing = seeded.get(dataset.name)
		if (existing !== undefined) return existing
		const cached = Effect.runSync(Effect.cached(issueRows(warehouse, dataset)))
		seeded.set(dataset.name, cached)
		return cached
	}
	const find = (dataset: Dataset, params: unknown) =>
		Effect.gen(function* () {
			const id = str(params, "id") ?? str(params, "issueId")
			const issue = (yield* issuesOf(dataset)).find((candidate) => candidate.id === id)
			if (issue === undefined || id === undefined)
				return yield* new ErrorIssueNotFoundError({
					message: "Issue not found",
					issueId: decodeIssueId(id ?? fixtureUuid(4, 0)),
				})
			return issue
		})
	return {
		"errorIssues.list": ({ dataset, query }) =>
			Effect.gen(function* () {
				const issues = ranked(yield* issuesOf(dataset), query).filter(matches(query))
				return list(yield* Effect.forEach(issues, (issue) => encodeIssue(issue)))
			}),
		"errorIssues.serviceCounts": ({ dataset }) =>
			Effect.map(issuesOf(dataset), (issues) => {
				const open = issues.filter((issue) => OPEN_STATES.includes(issue.workflow_state))
				const services = [...new Set(open.map((issue) => issue.service_name))].sort()
				return list(
					services.map((name) => ({
						service_name: name,
						open_count: open.filter((issue) => issue.service_name === name).length,
					})),
				)
			}),
		"errorIssues.retrieve": ({ dataset, params, query }) =>
			Effect.gen(function* () {
				const issue = yield* find(dataset, params)
				const fallback = windowOf(dataset)
				const tenant = warehouse.tenantOf(
					parityOrgId(dataset.identity?.orgId ?? "org_parity_signed_out"),
				)
				const bucket = str(query, "bucket_seconds")
				const params_ = {
					orgId: tenant.orgId,
					fingerprintHash: issue.fingerprint_hash,
					startTime: toWarehouse(str(query, "start_time"), fallback.startTime),
					endTime: toWarehouse(str(query, "end_time"), fallback.endTime),
				}
				const limit = Number(str(query, "sample_limit") ?? "25")
				const options = (context: string) => ({ profile: "aggregation" as const, context })
				const [timeseries, samples, environments] = yield* Effect.all([
					warehouse.executor.compiledQuery(
						tenant,
						CH.compile(CH.errorIssueTimeseriesQuery(), {
							...params_,
							bucketSeconds: Number(bucket ?? "3600"),
						}),
						options("errorIssueTimeseries"),
					),
					warehouse.executor.compiledQuery(
						tenant,
						CH.compile(CH.errorIssueSampleTracesQuery({ limit }), params_),
						options("errorIssueSampleTraces"),
					),
					warehouse.executor.compiledQuery(
						tenant,
						CH.compile(CH.errorIssueEnvironmentsQuery(), params_),
						options("errorIssueEnvironments"),
					),
				])
				return yield* encodeDetail({
					...issue,
					timeseries: timeseries.map((row) => ({
						bucket: DateTime.formatIso(row.bucket),
						count: row.count,
					})),
					sample_traces: samples.map((row) => ({
						trace_id: row.traceId,
						span_id: row.spanId,
						service_name: row.serviceName,
						timestamp: DateTime.formatIso(row.timestamp),
						exception_message: row.exceptionMessage,
						duration_micros: row.durationMicros,
					})),
					incidents: [],
					environments: environments.map((row) => ({ name: row.name, count: row.count })),
				})
			}),
	}
}
