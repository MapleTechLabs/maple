import { Effect, Schema } from "effect"
import {
	V2AlertDestinationDeleteResponse,
	V2AlertDestinationMutationResponse,
	V2AlertDestinationTestResult,
	V2AlertRuleMutationResponse,
	V2AlertRuleTestResult,
} from "@maple/domain/http/v2"
import type { Dataset, EndpointHandler, SyncedRow } from "../../dataset.ts"
import { epochMs, iso, num, str, strings } from "./synthetic.ts"

/**
 * The alert writes the pages send (enable/disable, create, edit, dry run, destination toggle, test,
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
		thresholds: [
			{
				severity,
				value: threshold,
				upper: null,
				recovery_value: null,
				destination_ids: destinationIds,
			},
		],
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

/** A created rule: the payload's name, signal and threshold under a fixed new id. */
const createRule: EndpointHandler = (request) => {
	const payload = record(request.payload)
	const row: SyncedRow = {
		id: "0199a002-0000-7000-8000-0000000000ff",
		name: str(payload, "name") ?? "",
		severity: str(payload, "severity") ?? "warning",
		signal_type: str(payload, "signal_type") ?? "error_rate",
		comparator: str(payload, "comparator") ?? "gt",
		threshold: num(payload, "threshold") ?? 0,
		window_minutes: num(payload, "window_minutes") ?? 5,
		created_at: request.dataset.now,
	}
	return Effect.sync(() => ruleWire(request.dataset, row, {}))
}

/** A dry run: the payload's comparator and threshold, evaluated healthy against the fixture. */
const testRule: EndpointHandler = (request) => {
	const rule = record(record(request.payload).rule)
	const threshold = num(rule, "threshold") ?? 0
	return Effect.sync(() =>
		Schema.encodeUnknownSync(V2AlertRuleTestResult)({
			object: "alert_rule.test_result",
			status: "healthy",
			value: threshold / 2,
			sample_count: 312,
			threshold,
			threshold_upper: null,
			comparator: str(rule, "comparator") ?? "gt",
			reason: "ui-parity: within threshold",
		}),
	)
}

const updateDestination: EndpointHandler = (request) => {
	const row = destinationRow(request.dataset, idOf(request))
	const payload = record(request.payload)
	return row === undefined
		? Effect.fail(new Error("alert destination not seeded"))
		: Effect.sync(() => {
				const patch: Record<string, unknown> = {}
				if ("enabled" in payload) patch.enabled = payload.enabled
				if (typeof payload.name === "string") patch.name = payload.name
				return destinationWire(request.dataset, row, patch)
			})
}

/** A created destination: the payload's type and name with a fixed new id. */
const createDestination: EndpointHandler = (request) => {
	const payload = record(request.payload)
	const type = str(payload, "type") ?? "webhook"
	const row: SyncedRow = {
		id: "0199a001-0000-7000-8000-0000000000ff",
		name: str(payload, "name") ?? "",
		type,
		enabled: true,
		config_json: { summary: str(payload, "url") ?? type, channelLabel: null },
		last_tested_at: null,
		last_test_error: null,
		created_at: request.dataset.now,
	}
	return Effect.sync(() => destinationWire(request.dataset, row, {}))
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
	"alertRules.create": createRule,
	"alertRules.test": testRule,
	"alertDestinations.update": updateDestination,
	"alertDestinations.create": createDestination,
	"alertDestinations.test": testDestination,
	"alertDestinations.delete": deleteDestination,
} satisfies Readonly<Record<string, EndpointHandler>>
