/**
 * How a failure reading a connected repository reaches a model: GitHub reads (source code, pull
 * requests) and the repository sandbox share one mapping, so the same cause reads the same way
 * whichever tool hit it.
 */
import { Schema } from "effect"
import {
	IntegrationsNotConnectedError,
	IntegrationsPersistenceError,
	IntegrationsUpstreamError,
} from "@maple/domain/http"
import { SandboxRunCheckoutPending, SandboxRunUnavailable } from "@maple/domain/sandbox"
import type { SandboxError } from "effect-agent/sandbox"
import {
	VcsSourceFileNotFoundError,
	VcsSourceRefNotFoundError,
	VcsSourceRepositoryNotFoundError,
} from "@maple/backend/services/integrations/vcs/VcsSourceService"
import { McpInvalidInputError, McpNotReadyError, McpQueryError, McpUnavailableError } from "../tools/types"

export type VcsLookupError =
	| IntegrationsNotConnectedError
	| IntegrationsPersistenceError
	| IntegrationsUpstreamError
	| VcsSourceRepositoryNotFoundError
	| VcsSourceFileNotFoundError
	| VcsSourceRefNotFoundError

export type SourceToolError = McpInvalidInputError | McpNotReadyError | McpUnavailableError | McpQueryError

const isVcsLookupError = Schema.is(
	Schema.Union([
		IntegrationsNotConnectedError,
		IntegrationsPersistenceError,
		IntegrationsUpstreamError,
		VcsSourceRepositoryNotFoundError,
		VcsSourceFileNotFoundError,
		VcsSourceRefNotFoundError,
	]),
)
const isCheckoutPending = Schema.is(SandboxRunCheckoutPending)
const isSandboxUnavailable = Schema.is(SandboxRunUnavailable)

/** The checkout wait already spent 90s; a clone that outlived it usually lands within a minute more. */
export const CHECKOUT_RETRY_AFTER_SECONDS = 60

const GITHUB_APP_UNAVAILABLE = new McpUnavailableError({
	message: "Maple's GitHub App is not set up on this deployment, so no repository can be read.",
	capability: "github_app",
})

/**
 * A missing GitHub App reaches here as a generic `IntegrationsUpstreamError`: the provider's
 * `GithubAppError` is flattened on the way and carries no field for it, so its message is the
 * only signal.
 */
const isGithubAppMissing = (error: IntegrationsUpstreamError): boolean =>
	error.message.startsWith("GitHub App is not configured")

export const fromVcsLookupError =
	(operation: string) =>
	(error: VcsLookupError): SourceToolError => {
		switch (error._tag) {
			case "@maple/api/vcs/VcsSourceRepositoryNotFoundError":
				return new McpInvalidInputError({ message: error.message, parameter: "repository" })
			case "@maple/api/vcs/VcsSourceRefNotFoundError":
				return new McpInvalidInputError({ message: error.message, parameter: "ref" })
			case "@maple/api/vcs/VcsSourceFileNotFoundError":
				return new McpInvalidInputError({ message: error.message, parameter: "path" })
			case "@maple/http/errors/IntegrationsNotConnectedError":
				return new McpUnavailableError({
					message: "No source repository is connected to this organization.",
					capability: "source_repository",
				})
			case "@maple/http/errors/IntegrationsUpstreamError":
				return isGithubAppMissing(error)
					? GITHUB_APP_UNAVAILABLE
					: new McpQueryError({ message: error.message, pipeName: operation, cause: error })
			case "@maple/http/errors/IntegrationsPersistenceError":
				return new McpQueryError({ message: error.message, pipeName: operation, cause: error })
		}
	}

/**
 * The sandbox's failures. The port flattens a checkout it could not resolve or start into a
 * `SandboxSpawnError`, so the reason is read from the error's `cause`: the VCS error, or the
 * sandbox Worker's own answer.
 */
export const fromSandboxError =
	(operation: string) =>
	(error: SandboxError): SourceToolError => {
		switch (error._tag) {
			case "SandboxTimeoutError":
				return new McpInvalidInputError({
					message:
						"The command exceeded its wall-clock limit. Narrow the search (path, glob, a tighter pattern) or the command.",
				})
			case "SandboxOutputLimitError":
				return new McpInvalidInputError({
					message: `${error.stream} exceeded ${Math.round(error.limit / 1024)} KiB. Narrow the pattern, add a glob or path, or read a smaller range.`,
				})
			case "SandboxUnsupportedRequestError":
				return error.feature === "runtime"
					? new McpUnavailableError({ message: error.message, capability: "repository_sandbox" })
					: new McpInvalidInputError({ message: error.message })
			case "SandboxSpawnError": {
				const cause = error.cause
				if (isCheckoutPending(cause))
					return new McpNotReadyError({
						message: error.message,
						retryAfterSeconds: CHECKOUT_RETRY_AFTER_SECONDS,
					})
				if (isSandboxUnavailable(cause))
					return new McpUnavailableError({
						message: error.message,
						capability: "repository_sandbox",
					})
				if (isVcsLookupError(cause)) return fromVcsLookupError(operation)(cause)
				return new McpQueryError({ message: error.message, pipeName: operation, cause: error })
			}
			case "SandboxExitError":
				return new McpQueryError({ message: error.message, pipeName: operation, cause: error })
		}
	}
