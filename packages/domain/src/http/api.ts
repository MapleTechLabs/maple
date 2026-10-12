import { HttpApi, OpenApi } from "effect/http-api"
import { AuthApiGroup, AuthPublicApiGroup } from "./auth"
import { BillingPublicApiGroup } from "./billing"
import { EmailPublicApiGroup } from "./digest"
import { ApiSchemaErrors, ApiUnexpectedErrors } from "./api-boundary"

/**
 * The unversioned `/api` surface: routes whose URLs live in clients we cannot
 * redeploy, so they never move. CLI device login and session (installed CLIs),
 * MCP OAuth consent, password login, the unauthenticated plan catalog, and email
 * unsubscribe. Not a versioned API: public resources belong in `/v2`, dashboard
 * transport in `/internal`. Not published in the API reference.
 */
export class MapleApi extends HttpApi.make("MapleApi")
	.add(AuthPublicApiGroup)
	.add(AuthApiGroup)
	.add(BillingPublicApiGroup)
	.add(EmailPublicApiGroup)
	.middleware(ApiSchemaErrors)
	.middleware(ApiUnexpectedErrors)
	.annotateMerge(
		OpenApi.annotations({
			title: "Maple unversioned API",
			version: "1.0.0",
			description:
				"Authentication protocols and unauthenticated helpers at stable /api URLs. Not public API.",
		}),
	) {}
