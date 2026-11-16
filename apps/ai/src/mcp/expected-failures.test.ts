import { describe, expect, it } from "vitest"
import { Duration, String as Str } from "effect"
import { IntegrationsPersistenceError, IntegrationsUpstreamError } from "@maple/domain/http"
import { SandboxRunCheckoutFailed, SandboxRunCheckoutPending } from "@maple/domain/sandbox"
import {
	SandboxExitError,
	SandboxImplementation,
	SandboxOutputLimitError,
	SandboxSpawnError,
	SandboxTimeoutError,
	SandboxUnsupportedRequestError,
	type SandboxError,
} from "@maple/backend/services/sandbox/contract"
import { VcsSourceRefNotFoundError } from "@maple/backend/services/integrations/vcs/VcsSourceService"
import { isAnticipatedMcpFailure } from "./expected-failures"
import { fromSandboxError } from "./lib/source-errors"

const implementation = new SandboxImplementation({ isolation: "isolated", identity: "test" })
const spawn = (cause: unknown): SandboxError =>
	new SandboxSpawnError({ implementation, command: "git", message: "never started", cause })

const SANDBOX_FAILURES: ReadonlyArray<readonly [string, SandboxError]> = [
	[
		"an invented SHA",
		spawn(
			new VcsSourceRefNotFoundError({ repository: "o/r", ref: Str.repeat(40)("a"), message: "no ref" }),
		),
	],
	["a clone still running", spawn(new SandboxRunCheckoutPending({ message: "cloning" }))],
	[
		"a clone that failed",
		spawn(new SandboxRunCheckoutFailed({ message: "Cloning o/r failed (exit 128)" })),
	],
	[
		"a GitHub rate limit on the checkout lookup",
		spawn(
			new IntegrationsUpstreamError({ message: "GitHub rate limited (retry after 60s)", status: 403 }),
		),
	],
	[
		"a GitHub outage on the checkout lookup",
		spawn(new IntegrationsUpstreamError({ message: "Get commit failed: 502", status: 502 })),
	],
	["a lost database connection", spawn(new IntegrationsPersistenceError({ message: "Connection closed" }))],
	["a timeout", new SandboxTimeoutError({ implementation, maxWallTime: Duration.seconds(30) })],
	[
		"too much output",
		new SandboxOutputLimitError({ implementation, stream: "stdout", limit: 1024, observed: 2048 }),
	],
	[
		"a bad mount",
		new SandboxUnsupportedRequestError({
			implementation,
			feature: "mounts",
			message: "bad mount source",
		}),
	],
	[
		"no sandbox runtime",
		new SandboxUnsupportedRequestError({ implementation, feature: "runtime", message: "no runtime" }),
	],
	["a command that exited", new SandboxExitError({ implementation, exitCode: 2, message: "exit 2" })],
]

describe("isAnticipatedMcpFailure", () => {
	// The span and the model must agree: what the model is told to fix or retry is not a server error.
	// A missing capability (no sandbox runtime) is told to the model too, but stays an Error span.
	it.each(SANDBOX_FAILURES)("agrees with the model-facing mapping for %s", (_, error) => {
		const shownToModel = fromSandboxError("sandbox_exec")(error)._tag
		expect(isAnticipatedMcpFailure(error)).toBe(
			shownToModel === "@maple/mcp/errors/McpInvalidInputError" ||
				shownToModel === "@maple/mcp/errors/McpNotReadyError",
		)
	})

	it("treats a call to a tool that does not exist as the client's mistake", () => {
		const unknownTool = { _tag: "ProtocolError", code: -32602, message: "Tool 'tools/list' not found" }
		const internal = { _tag: "ProtocolError", code: -32603, message: "Internal error" }
		expect([isAnticipatedMcpFailure(unknownTool), isAnticipatedMcpFailure(internal)]).toEqual([
			true,
			false,
		])
	})
})
