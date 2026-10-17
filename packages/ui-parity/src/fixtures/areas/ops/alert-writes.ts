import { Effect, Schema } from "effect"
import {
	V2AlertDestinationDeleteResponse,
	V2AlertDestinationMutationResponse,
	V2AlertDestinationTestResult,
	V2AlertRuleMutationResponse,
} from "@maple/domain/http/v2"
import type { Dataset, EndpointHandler, SyncedRow } from "../../dataset.ts"
import { epochMs, iso, num, str, strings } from "./synthetic.ts"

/**
 * The alert writes the pages send (enable/disable, create, edit, destination toggle, test,
 * delete). Nothing is persisted: each answers what the server would return for the seeded row,
 * so the call log carries the request and both apps render the same success path.
 */

const record = (value: unknown): Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {}

const bool = (value: Readonly<Record<string, unknown>>, key: string): boolean | undefined =>
	typeof value[key] === "boolean" ? value[key] : undefined

const userOf = (dataset: Dataset): string => dataset.identity?.userId ?? "user_parity_ada"

const idOf = (request: { readonly params: unknown }): string | undefined => str(record(request.params), "id")

const nowIso = (dataset: Dataset) => iso(epochMs(dataset.now))

const ruleWire = (dataset: Dataset, row: SyncedRow, patch: Readonly<Record<string, unknown>>) => {
	const threshold = num(row, "threshold") ?? 0
	const severity = str(row, "severity") ?? "warning"
	const destinationIds = strings(row, "destination_ids_json")
	return Schema.encodeUnknownSync(V2AlertRuleMutationResponse)({
		id: str(row, "id"),
		object: "alert_rule",
		name: str(row, "name") ?? "",
		notes: str(row, "notes") ?? null,
		notification_template: null,
		enabled: bool(row, "enabled") ?? true,
		severity,
		thresholds: [{ severity, value: threshold, upper: null, recovery_value: null, destination_ids: destinationIds }],
		service_names: strings(row, "service_names_json"),
		exclude_service_names: strings(row, "exclude_service_names_json"),
		environments: strings(row, "environments_json"),
		tags: strings(row, "tags_json"),
		group_by: null,
		signal_type: str(row, "signal_type") ?? "error_rate",
		comparator: str(row, "comparator") ?? "gt",
		threshold,
		threshold_upper: null,
		window_minutes: num(row, "window_minutes") ?? 5,
		minimum_sample_count: num(row, "minimum_sample_count") ?? 0,
		consecutive_breaches_required: num(row, "consecutive_breaches_required") ?? 1,
		breaches_out_of: null,
		consecutive_healthy_required: num(row, "consecutive_healthy_required") ?? 1,
		renotify_interval_minutes: num(row, "renotify_interval_minutes") ?? 60,
		apdex_threshold_ms: null,
		query_builder_draft: null,
		raw_query_sql: null,
		raw_query_reducer: null,
		destination_ids: destinationIds,
		no_data_behavior: str(row, "no_data_behavior") ?? "skip",
		alert_on_no_data: false,
		last_evaluation_error: null,
		last_evaluated_at: null,
		last_scheduled_at: null,
		created_at: str(row, "created_at") ?? nowIso(dataset),
		updated_at: nowIso(dataset),
		created_by: str(row, "created_by") ?? userOf(dataset),
		updated_by: userOf(dataset),
		...patch,
	})
}

const destinationRow = (dataset: Dataset, id: string | undefined) =>
	(dataset.synced.alert_destinations_v2 ?? []).find((row) => row.id === id)

const destinationWire = (dataset: Dataset, row: SyncedRow, patch: Readonly<Record<string, unknown>>) => {
	const config = record(row.config_json)
	return Schema.encodeUnknownSync(V2AlertDestinationMutationResponse)({
		id: str(row, "id"),
		object: "alert_destination",
		name: str(row, "name") ?? "",
		type: str(row, "type") ?? "webhook",
		enabled: bool(row, "enabled") ?? true,
		summary: str(config, "summary") ?? "",
		channel_label: str(config, "channelLabel") ?? null,
		member_user_ids: null,
		last_tested_at: str(row, "last_tested_at") ?? null,
		last_test_error: str(row, "last_test_error") ?? null,
		created_at: str(row, "created_at") ?? nowIso(dataset),
		updated_at: nowIso(dataset),
		...patch,
	})
}

const updateRule: EndpointHandler = (request) => {
	const row = (request.dataset.synced.alert_rules ?? []).find((rule) => rule.id === idOf(request))
	const payload = record(request.payload)
	return row === undefined
		? Effect.fail(new Error("alert rule not seeded"))
		: Effect.sync(() =>
				ruleWire(request.dataset, row, "enabled" in payload ? { enabled: payload.enabled } : {}),
			)
}

const updateDestination: EndpointHandler = (request) => {
	const row = destinationRow(request.dataset, idOf(request))
	const payload = record(request.payload)
	return row === undefined
		? Effect.fail(new Error("alert destination not seeded"))
		: Effect.sync(() =>
				destinationWire(request.dataset, row, {
					...("enabled" in payload ? { enabled: payload.enabled } : {}),
					...(typeof payload.name === "string" ? { name: payload.name } : {}),
				}),
			)
}

const testDestination: EndpointHandler = () =>
	Effect.sync(() =>
		Schema.encodeUnknownSync(V2AlertDestinationTestResult)({
			object: "alert_destination.test_result",
			success: true,
			message: "Test notification sent",
		}),
	)

const deleteDestination: EndpointHandler = (request) =>
	Effect.sync(() =>
		Schema.encodeUnknownSync(V2AlertDestinationDeleteResponse)({
			id: idOf(request),
			object: "alert_destination",
			deleted: true,
		}),
	)

export const alertWriteEndpoints = {
	"alertRules.update": updateRule,
	"alertDestinations.update": updateDestination,
	"alertDestinations.test": testDestination,
	"alertDestinations.delete": deleteDestination,
} satisfies Readonly<Record<string, EndpointHandler>>
