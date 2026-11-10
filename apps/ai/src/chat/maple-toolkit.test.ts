/** The Maple toolkit a chat run offers, and what it pins for a review session. */
import { UserId, OrgId } from "@maple/primitives"
import type { TenantContext } from "@maple/domain/http"
import { Effect, Schema } from "effect"
import { assert, describe, it } from "vitest"
import type { McpToolExecutorApi } from "../mcp/dispatcher"
import { noRepositoryWarmup } from "../../test/chat/tool-executor"
import { buildChatToolkit } from "./maple-toolkit"
import { PR_REVIEW_RULESET } from "./permissions"

const orgId = Schema.decodeSync(OrgId)("org_test")
const human = Schema.decodeSync(UserId)("user_test")

const tenantFor = (userId: UserId): TenantContext => ({
	orgId,
	userId,
	roles: [],
	authMode: "self_hosted",
})

describe("buildChatToolkit", () => {
	const recordingExecutor = () => {
		const calls: Array<{ readonly name: string; readonly params: unknown }> = []
		const executor: McpToolExecutorApi = {
			...noRepositoryWarmup,
			execute: (_tenant, name, params) => {
				calls.push({ name, params })
				return Effect.succeed({ content: [{ type: "text" as const, text: `${name} ran` }] })
			},
		}
		return { executor, calls }
	}
	const PULL_REQUEST = { repository: "MapleTechLabs/maple", number: 2175 }

	it("reads the session's pull request whatever repository or number the model passes", async () => {
		const { executor, calls } = recordingExecutor()
		const { handlers } = buildChatToolkit(
			executor,
			tenantFor(human),
			PR_REVIEW_RULESET,
			"chat",
			undefined,
			undefined,
			undefined,
			PULL_REQUEST,
		)

		assert.isDefined(handlers.pr_changed_files)
		assert.isDefined(handlers.pr_file_diff)
		await Effect.runPromise(handlers.pr_changed_files({ description: "files" }, {}))
		await Effect.runPromise(
			handlers.pr_file_diff({ repository: "MapleLabs/Maple", number: 1, paths: ["a.ts"] }, {}),
		)

		assert.deepEqual(calls, [
			{ name: "pr_changed_files", params: { description: "files", ...PULL_REQUEST } },
			{ name: "pr_file_diff", params: { ...PULL_REQUEST, paths: ["a.ts"] } },
		])
	})

	it("leaves every other tool's arguments as the model sent them", async () => {
		const { executor, calls } = recordingExecutor()
		const { handlers } = buildChatToolkit(
			executor,
			tenantFor(human),
			PR_REVIEW_RULESET,
			"chat",
			undefined,
			undefined,
			undefined,
			PULL_REQUEST,
		)
		const read = { repository: "MapleTechLabs/other", ref: "main", path: "a.ts" }

		assert.isDefined(handlers.sandbox_read_file)
		await Effect.runPromise(handlers.sandbox_read_file(read, {}))

		assert.deepEqual(calls, [{ name: "sandbox_read_file", params: read }])
	})
})
