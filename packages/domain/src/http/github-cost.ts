import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Schema } from "effect"
import { VcsInstallationId } from "../vcs"
import { SessionAuthorization } from "./current-tenant"
import { HttpTaggedError } from "./error-policy"
import { CloudCostDisabledError } from "./query-engine"

/**
 * Whether a GitHub installation can supply cost. `user_account`: GitHub has a billing report for
 * organizations only. `inactive`: the installation is suspended or was uninstalled.
 */
export const GithubCostInstallationState = Schema.Literals(["available", "added", "user_account", "inactive"])
export type GithubCostInstallationState = typeof GithubCostInstallationState.Type

/** One of the org's GitHub App installations, as the Cost page's Add source dialog lists it. */
export class GithubCostInstallation extends Schema.Class<GithubCostInstallation>("GithubCostInstallation")({
	installationId: VcsInstallationId,
	accountLogin: Schema.String,
	state: GithubCostInstallationState,
	/** Where the account accepts the App's permissions in GitHub. */
	settingsUrl: Schema.String,
}) {}

export class GithubCostInstallations extends Schema.Class<GithubCostInstallations>("GithubCostInstallations")(
	{ installations: Schema.Array(GithubCostInstallation) },
) {}

export class GithubCostSourceAdded extends Schema.Class<GithubCostSourceAdded>("GithubCostSourceAdded")({
	accountLogin: Schema.String,
}) {}

export class GithubCostSourceRemoved extends Schema.Class<GithubCostSourceRemoved>("GithubCostSourceRemoved")(
	{ removed: Schema.Boolean },
) {}

// The Cost page shows these to the person adding the source, so each carries a public body.

export class GithubCostForbiddenError extends HttpTaggedError<GithubCostForbiddenError>()(
	"@maple/http/github-cost/GithubCostForbiddenError",
	{ message: Schema.String },
	{
		status: 403,
		code: "github_cost_forbidden",
		title: "Permission required",
		retry: "never",
		recovery: "request_access",
		exposure: "public_message",
	},
) {}

/** The database or GitHub could not be reached; its own text can carry internals, so it stays server-side. */
export class GithubCostUnavailableError extends HttpTaggedError<GithubCostUnavailableError>()(
	"@maple/http/github-cost/GithubCostUnavailableError",
	{ message: Schema.String, cause: Schema.optionalKey(Schema.String) },
	{
		status: 503,
		code: "github_cost_unavailable",
		title: "GitHub cost sources are temporarily unavailable",
		message: "GitHub's billing report could not be read right now. Try again in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

/** The org has no such GitHub installation. */
export class GithubCostInstallationNotFoundError extends HttpTaggedError<GithubCostInstallationNotFoundError>()(
	"@maple/http/github-cost/GithubCostInstallationNotFoundError",
	{ message: Schema.String },
	{
		status: 404,
		code: "github_cost_installation_not_found",
		title: "GitHub installation not found",
		retry: "never",
		recovery: "refresh",
		exposure: "public_message",
	},
) {}

/**
 * The installation cannot supply cost as it stands: a user account, a suspended installation, an
 * organization without a billing report, or one Maple can no longer act for. The message says which.
 */
export class GithubCostNotReadyError extends HttpTaggedError<GithubCostNotReadyError>()(
	"@maple/http/github-cost/GithubCostNotReadyError",
	{ message: Schema.String },
	{
		status: 409,
		code: "github_cost_not_ready",
		title: "GitHub billing cannot be read yet",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

/** The organization has not let Maple read its billing report, which it lifts in its GitHub App settings. */
export class GithubCostPermissionMissingError extends HttpTaggedError<GithubCostPermissionMissingError>()(
	"@maple/http/github-cost/GithubCostPermissionMissingError",
	{ message: Schema.String },
	{
		status: 409,
		code: "github_cost_permission_missing",
		title: "GitHub has not granted access to billing",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

const installationParams = { installationId: VcsInstallationId }

/**
 * GitHub cost sources read through the GitHub App installations the org already has. Adding one
 * makes the source, removing deletes it; the installation itself is not touched.
 */
export class GithubCostApiGroup extends HttpApiGroup.make("githubCost")
	.add(
		HttpApiEndpoint.get("list", "/", {
			success: GithubCostInstallations,
			error: [GithubCostUnavailableError, CloudCostDisabledError],
		}),
	)
	.add(
		HttpApiEndpoint.put("add", "/:installationId", {
			params: installationParams,
			success: GithubCostSourceAdded,
			error: [
				GithubCostUnavailableError,
				GithubCostForbiddenError,
				GithubCostInstallationNotFoundError,
				GithubCostNotReadyError,
				GithubCostPermissionMissingError,
				CloudCostDisabledError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.delete("remove", "/:installationId", {
			params: installationParams,
			success: GithubCostSourceRemoved,
			error: [GithubCostUnavailableError, GithubCostForbiddenError],
		}),
	)
	.prefix("/internal/cost/github")
	.middleware(SessionAuthorization) {}
