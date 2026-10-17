import type { Effect } from "effect"
import type { DatasetIdentity, DatasetSummary } from "../contract.ts"
import type { TelemetryRows } from "./telemetry/rows.ts"

/** What a fixture endpoint handler sees: the wire-decoded request parts and its dataset. */
export interface EndpointRequest {
	readonly dataset: Dataset
	readonly payload: unknown
	readonly params: unknown
	readonly query: unknown
	/** Adds an entry to this capture's call log (execute-batch logs one per warehouse query). */
	readonly record: (tag: string, payload: unknown) => void
}

/**
 * A canned endpoint answer in its ENCODED (wire JSON) form: the server decodes it with the
 * endpoint's success schema, so a fixture that drifts from the domain schema fails loudly.
 * Fail with one of the endpoint's declared errors to answer with it.
 */
export type EndpointHandler = (request: EndpointRequest) => Effect.Effect<unknown, unknown>

/** Electric shapes the web app syncs (`apps/web/src/lib/collections/*`), by `shape=` name. */
export type SyncedTableName =
	| "api_keys"
	| "dashboards"
	| "alert_rules"
	| "alert_rule_states"
	| "alert_incidents"
	| "alert_destinations"
	| "alert_destinations_v2"
	| "investigation_v2"

/** A Postgres row as Electric would read it: timestamps as epoch-ms numbers or ISO strings, jsonb as values. */
export type SyncedRow = Readonly<Record<string, unknown>>

/**
 * Everything both frontends see during a parity run. The same dataset feeds the legacy app and
 * the Foldkit app, so any visual or behavioral difference is a UI difference.
 */
export interface Dataset extends DatasetSummary {
	/** `null` = signed out: every authenticated endpoint answers 401 like the real API. */
	readonly identity: DatasetIdentity | null
	/** Canned answers keyed `"<group>.<endpoint>"`; they win over the generic defaults. */
	readonly endpoints: Readonly<Record<string, EndpointHandler>>
	readonly synced: Partial<Record<SyncedTableName, ReadonlyArray<SyncedRow>>>
	/** Raw warehouse rows, all stamped with `identity.orgId` (or none for an empty org). */
	readonly telemetry: TelemetryRows
}
