import { HttpApi, OpenApi } from "effect/http-api"
import { AiModelsInternalApiGroup } from "./ai-models"
import { AiSessionsInternalApiGroup } from "./ai-sessions"
import { AiTriageApiGroup } from "./ai-triage"
import { BillingApiGroup } from "./billing"
import { CodeReviewApiGroup } from "./code-review"
import { DemoApiGroup } from "./demo"
import { DigestApiGroup } from "./digest"
import { ErrorsApiGroup } from "./errors"
import { IntegrationsApiGroup } from "./integrations"
import { OrgClickHouseSettingsApiGroup } from "./org-clickhouse-settings"
import {
	OrganizationCreationApiGroup,
	OrganizationRegionApiGroup,
	OrganizationsApiGroup,
} from "./organizations"
import { QueryEngineApiGroup } from "./query-engine"
import { SessionReplaysInternalApiGroup } from "./session-replay"
import { ApiSchemaErrors, ApiUnexpectedErrors } from "./api-boundary"

/**
 * The dashboard's private transport.
 *
 * Deliberately a separate `HttpApi` from `MapleApi` rather than another group
 * inside it, so the groups here carry session-only authorization without
 * loosening it for anything else. Nothing here appears in the API reference.
 *
 * What belongs here is transport whose request and response shapes are allowed
 * to change with the UI — raw SQL, generic query documents, dashboard-builder
 * facet discovery, infrastructure drill-downs — plus the dashboard-only product
 * workflows (checkout and billing controls, digest subscriptions, demo seeding,
 * AI-triage settings, the error-issue workflow, integration and code-review
 * settings, organization setup, BYO ClickHouse configuration) that were never
 * public API and lived under `/api` until the v1 API was retired. Nothing here is a stable
 * public contract, and nothing here should be promoted to `/v2` without a
 * deliberate redesign of its shape first. See `docs/http-api-migration.md`.
 *
 * `billingPublic` deliberately stays on `MapleApi`: the plan catalog is served
 * unauthenticated so a token-settle gap renders prices instead of a 401, which
 * session-only authorization would defeat.
 *
 * It shares `MapleApi`'s error envelope (`api-boundary.ts`), which `apps/web` decodes.
 */
export class MapleInternalApi extends HttpApi.make("MapleInternalApi")
	.add(AiModelsInternalApiGroup)
	.add(AiSessionsInternalApiGroup)
	.add(AiTriageApiGroup)
	.add(BillingApiGroup)
	.add(CodeReviewApiGroup)
	.add(DemoApiGroup)
	.add(DigestApiGroup)
	.add(ErrorsApiGroup)
	.add(IntegrationsApiGroup)
	.add(OrgClickHouseSettingsApiGroup)
	.add(OrganizationsApiGroup)
	.add(OrganizationCreationApiGroup)
	.add(OrganizationRegionApiGroup)
	.add(QueryEngineApiGroup)
	.add(SessionReplaysInternalApiGroup)
	.middleware(ApiSchemaErrors)
	.middleware(ApiUnexpectedErrors)
	.annotateMerge(
		OpenApi.annotations({
			title: "Maple Internal API",
			version: "1.0.0",
			description:
				"Private dashboard transport. Not public API, not documented, not stable — do not build against it.",
		}),
	) {}
