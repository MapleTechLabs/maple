/**
 * The investigation fan-out Workflow, in alchemy's form: yielded from the api
 * Worker's init, which binds it as `InvestigationFanoutWorkflow`, registers the
 * physical workflow and exports the class from the generated entry. N lens
 * agents run in parallel, then one validator promotes a single cause and
 * records why each rival lost.
 */
import ChatSessionObject from "@/chat/ChatSession"
import { MCP_ANTICIPATED_ERROR_IDENTIFIERS } from "@/mcp/expected-failures"
import { layerPg } from "@/platform/DatabasePgLive"
import { withPgConnectionScope } from "@/platform/pg-connection-scope"
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
		// here so the run gets the typed stubs of the class the Worker hosts.
		const chatSessions = yield* ChatSessionObject
		return Effect.fn("InvestigationFanoutWorkflow")(function* (
			payload: InvestigationFanoutWorkflowPayload,
		) {
			return yield* runInvestigationFanout(payload, { chatSessions }).pipe(
				// `Database` over one Postgres connection for the run, released with it,
				// and the run's own telemetry, flushed when alchemy closes the run's scope.
				// The Workflow class IS the entry point these layers belong to.
				// oxlint-disable-next-line effecttsgo/strict-effect-provide
				Effect.provide(Layer.mergeAll(layerPg, fanoutTelemetry)),
				withPgConnectionScope,
			)
		})
	}),
) {}
