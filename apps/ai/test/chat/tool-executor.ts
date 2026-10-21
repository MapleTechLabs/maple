import { Effect } from "effect"
import type { McpToolExecutorApi } from "../../src/mcp/dispatcher"

/** Spread into a test executor that only answers tool calls: it warms no repositories. */
export const noRepositoryWarmup: Omit<McpToolExecutorApi, "execute"> = {
	prepareRepository: () => Effect.void,
	prepareConnectedRepositories: () => Effect.void,
}
