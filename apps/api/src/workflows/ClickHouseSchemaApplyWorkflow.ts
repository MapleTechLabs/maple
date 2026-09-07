/**
 * The schema-apply Workflow, in alchemy's form: yielded from the api Worker's
 * init, which binds it as `ClickHouseSchemaApplyWorkflow`, registers the
 * physical workflow and exports the class from the generated entry. It applies
 * Maple's ClickHouse schema to a customer's BYO cluster, chunking heavy
 * backfills across durable steps so they never hit the Worker request budget.
 */
import { layerPg } from "@/platform/DatabasePgLive"
import { withPgConnectionScope } from "@/platform/pg-connection-scope"
import { mapleDbConnectionLayer } from "@/platform/pg-connection-source"
import { MapleDb } from "@maple/infra/cloudflare"
import { eventTelemetry } from "@maple/infra/worker-telemetry"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect, Layer } from "effect"
import {
	runClickHouseSchemaApply,
	type SchemaApplyWorkflowPayload,
} from "./ClickHouseSchemaApplyWorkflow.run"

// Deliberately not `maple-api`: background work sharing the request-facing
// service's name skewed its percentiles (p99 32s, 2026-09-04).
const schemaApplyTelemetry = eventTelemetry({ serviceName: "maple-schema-apply" })

export default class ClickHouseSchemaApplyWorkflow extends Cloudflare.Workflow<ClickHouseSchemaApplyWorkflow>()(
	"ClickHouseSchemaApplyWorkflow",
	Effect.gen(function* () {
		// Init: the application database, bound to the host Worker under `MAPLE_DB`
		// (a run reads it off its env through `mapleDbConnectionLayer`).
		yield* MapleDb("api")
		return Effect.fn("ClickHouseSchemaApplyWorkflow")(function* (payload: SchemaApplyWorkflowPayload) {
			const env = yield* Cloudflare.WorkerEnvironment
			return yield* withPgConnectionScope(runClickHouseSchemaApply(payload)).pipe(
				// `Database` over one Postgres connection for the run, released with it,
				// and the run's own telemetry, flushed when alchemy closes the run's scope.
				// The Workflow class IS the entry point these layers belong to.
				// oxlint-disable-next-line effecttsgo/strict-effect-provide
				Effect.provide(
					Layer.mergeAll(layerPg, schemaApplyTelemetry).pipe(
						Layer.provideMerge(mapleDbConnectionLayer(env)),
					),
				),
			)
		})
	}),
) {}
