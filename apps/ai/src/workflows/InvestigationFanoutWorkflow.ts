/**
 * The investigation fan-out Workflow, in alchemy's form: yielded from the AI
 * Worker's init, which binds it as `InvestigationFanoutWorkflow`, registers the
 * physical workflow and exports the class from the generated entry. N lens
 * agents run in parallel, then one validator promotes a single cause and
 * records why each rival lost.
 *
 * The api and alerting Workers bind the same physical workflow cross-script
 * under this class name — see `@maple/domain/investigation-fanout`.
 */
import { ChatSessionObject } from "../chat/ChatSession"
import { MCP_ANTICIPATED_ERROR_IDENTIFIERS } from "../mcp/expected-failures"
import { layerPg } from "@maple/backend/platform/DatabasePgLive"
import { withPgConnectionScope } from "@maple/backend/platform/pg-connection-scope"
import { mapleDbConnectionLayer } from "@maple/backend/platform/pg-connection-source"
import { MapleDb } from "@maple/infra/cloudflare"
import { eventTelemetry } from "@maple/infra/worker-telemetry"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect, Layer } from "effect"
import {
	runInvestigationFanout,
	type InvestigationFanoutWorkflowPayload,
} from "./InvestigationFanoutWorkflow.run"

// Deliberately not `maple-api`: background work sharing the request-facing
// service's name skewed its percentiles (p99 32s, 2026-09-04). The MCP
// identifiers keep an anticipated tool-call 400 out of error tracking.
const fanoutTelemetry = eventTelemetry({
	serviceName: "maple-investigations",
	anticipatedErrorIdentifiers: MCP_ANTICIPATED_ERROR_IDENTIFIERS,
})

export default class InvestigationFanoutWorkflow extends Cloudflare.Workflow<InvestigationFanoutWorkflow>()(
	"InvestigationFanoutWorkflow",
	Effect.gen(function* () {
		// Init: the chat Durable Object a run seeds its transcript into, yielded
		// here so the run gets the typed stubs of the class the Worker hosts, and
		// the application database, bound to the host Worker under `MAPLE_DB`.
		const chatSessions = yield* ChatSessionObject
		// `"ai"` is the HOST this workflow runs on, which is what picks the
		// Hyperdrive config `MAPLE_DB` binds on this script. Naming api's here
		// bound a second, differently-resolved `MAPLE_DB` on maple-ai — harmless
		// only while both consumers resolve to the same config.
		yield* MapleDb("ai")
		return Effect.fn("InvestigationFanoutWorkflow")(function* (
			payload: InvestigationFanoutWorkflowPayload,
		) {
			const env = yield* Cloudflare.WorkerEnvironment
			return yield* withPgConnectionScope(runInvestigationFanout(payload, { chatSessions })).pipe(
				// `Database` over one Postgres connection for the run, released with it,
				// and the run's own telemetry, flushed when alchemy closes the run's scope.
				// The Workflow class IS the entry point these layers belong to.
				// oxlint-disable-next-line effecttsgo/strict-effect-provide
				Effect.provide(
					Layer.mergeAll(layerPg, fanoutTelemetry).pipe(
						Layer.provideMerge(mapleDbConnectionLayer(env)),
					),
				),
			)
		})
	}),
) {}
