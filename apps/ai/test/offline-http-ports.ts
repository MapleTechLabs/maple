/** Offline graph fixtures. Every external operation fails rather than reaching a real service. */
import { Effect, Layer, Option } from "effect"
import { fakeChatSessionsLayer } from "@maple/backend/platform/chat-sessions-fake"
import { envPorts } from "@maple/backend/platform/env-ports"
import {
	MapleDbConnection,
	McpToolsRateLimit,
	SecurityAuditWorkflowStarter,
} from "@maple/backend/platform/bindings"
import { WorkersAiGateway } from "../src/platform/WorkersAiHttpClient"

const rejectIO = () => Effect.die("Unexpected external I/O in an offline graph")

export const offlinePorts = Layer.mergeAll(
	Layer.succeed(WorkersAiGateway, Option.none()),
	Layer.succeed(SecurityAuditWorkflowStarter, { create: rejectIO, cancel: rejectIO }),
	Layer.succeed(McpToolsRateLimit, { limit: rejectIO }),
	Layer.succeed(MapleDbConnection, Option.none()),
	fakeChatSessionsLayer(() => ({})),
	envPorts({
		TINYBIRD_HOST: "https://warehouse.invalid",
		TINYBIRD_TOKEN: "offline",
		MAPLE_ROOT_PASSWORD: "offline-benchmark-only",
		MAPLE_INGEST_KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
		MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
	}),
)
