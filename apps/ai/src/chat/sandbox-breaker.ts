/**
 * Stops a turn from spending its time on a repository sandbox that has already failed it.
 *
 * A sandbox call that finds the clone still running waits 90 s, and a container in trouble held
 * calls for minutes before failing. Models retried either way, and reviews ran out their pass on
 * sandbox calls. Per turn and per repository: once the sandbox is unavailable, or the checkout
 * missed two waits, further sandbox calls for that repository are refused at once.
 */
import type { SandboxError } from "@yielded/agent/sandbox"
import { Effect, Ref } from "effect"
import type { McpToolExecutorApi } from "../mcp/dispatcher"
import { fromSandboxError } from "../mcp/lib/source-errors"
import type { McpToolResult } from "../mcp/tools/types"

/** Two missed clone waits is three minutes gone; the checkout will not land in time to matter. */
export const MAX_CHECKOUT_WAITS = 2

interface RepositoryState {
	readonly missedWaits: number
	readonly down: boolean
}

const UP: RepositoryState = { missedWaits: 0, down: false }

const isSandboxTool = (name: string): boolean => name.startsWith("sandbox_")

/** The sandbox tools name their repository as `owner/name`; GitHub treats it case-insensitively. */
const repositoryOf = (input: unknown): string | undefined =>
	typeof input === "object" &&
	input !== null &&
	"repository" in input &&
	typeof input.repository === "string"
		? input.repository.trim().toLowerCase()
		: undefined

const refused = (repository: string): McpToolResult => ({
	isError: true,
	content: [
		{
			type: "text",
			text: `Unavailable: the repository sandbox for ${repository} already failed in this run, so it is not called again. Read the code with read_source_file and search_source_code instead.`,
		},
	],
	failureCategory: "unavailable",
})

const next = (state: RepositoryState, result: McpToolResult): RepositoryState => {
	if (result.isError !== true) return UP
	if (result.failureCategory === "unavailable") return { ...state, down: true }
	if (result.failureCategory === "not_ready") {
		const missedWaits = state.missedWaits + 1
		return { missedWaits, down: missedWaits >= MAX_CHECKOUT_WAITS }
	}
	return state
}

export const withSandboxBreaker = (executor: McpToolExecutorApi): Effect.Effect<McpToolExecutorApi> =>
	Effect.map(Ref.make<ReadonlyMap<string, RepositoryState>>(new Map()), (states) => {
		const update = (repository: string, f: (state: RepositoryState) => RepositoryState) =>
			Ref.update(states, (all) => new Map(all).set(repository, f(all.get(repository) ?? UP)))

		const execute: McpToolExecutorApi["execute"] = (tenant, name, input, surface) => {
			const repository = isSandboxTool(name) ? repositoryOf(input) : undefined
			if (repository === undefined) return executor.execute(tenant, name, input, surface)
			return Effect.gen(function* () {
				if ((yield* Ref.get(states)).get(repository)?.down === true) return refused(repository)
				const result = yield* executor.execute(tenant, name, input, surface)
				yield* update(repository, (state) => next(state, result))
				return result
			})
		}

		// The kickoff's own clone: a sandbox that could not even start it is down for the turn.
		const prepareRepository: McpToolExecutorApi["prepareRepository"] = (tenant, target) =>
			executor
				.prepareRepository(tenant, target)
				.pipe(
					Effect.tapError((error: SandboxError) =>
						fromSandboxError("prepare")(error)._tag === "@maple/mcp/errors/McpUnavailableError"
							? update(target.repository.trim().toLowerCase(), (state) => ({
									...state,
									down: true,
								}))
							: Effect.void,
					),
				)

		return { ...executor, execute, prepareRepository }
	})
