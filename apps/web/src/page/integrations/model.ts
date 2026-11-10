import * as Policy from "@maple/domain/policy"
import {
	BillingCustomer,
	CloudflareIntegrationStatus,
	GithubIntegrationStatus,
	LinearIntegrationStatus,
	RailwayIntegrationStatus,
	SearchConsoleIntegrationStatus,
	SupabaseIntegrationStatus,
} from "@maple/domain/http"
import {
	V2AwsIntegration,
	V2ChatConnectorList,
	V2DataSource,
	V2GcpIntegration,
	V2PlanetScaleDatabaseList,
	V2PlanetScaleIntegration,
	V2ScrapeTarget,
} from "@maple/domain/http/v2"
import { Schema } from "effect"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import { IntegrationsSearch } from "../../route/search"
import * as Dialog from "@maple/views/ui/dialog"
import { ChatCardModel } from "./chat"
import { CloudflareCardModel } from "../infra-integrations/cloudflare/integration/cloudflare"
import { GithubCardModel } from "./github"
import { PrometheusCardModel } from "./prometheus"
import { RailwayCardModel } from "../infra-integrations/railway/integration/railway"
import { PlanetscaleCardModel } from "../infra-integrations/planetscale/integration/planetscale"
import { GcpCardModel } from "../infra-integrations/gcp/integration/gcp"
import { AwsCardModel } from "../infra-integrations/aws/integration/aws"
import { SupabaseCardModel } from "../infra-integrations/supabase/integration/supabase"
import { SearchConsoleCardModel } from "./search-console"
import { ConnectModel } from "./connect"
import { HubFilter } from "./catalog"

const keyed = <A, AI>(schema: Schema.Codec<A, AI>) => KeyedSchema(schema, LoadFailure)

/** The status reads the hub and the headers share. */
export const Statuses = Schema.Struct({
	cloudflare: keyed(CloudflareIntegrationStatus),
	railway: keyed(RailwayIntegrationStatus),
	planetscale: keyed(V2PlanetScaleIntegration),
	planetscaleDatabases: keyed(V2PlanetScaleDatabaseList),
	gcp: keyed(V2GcpIntegration),
	aws: keyed(V2AwsIntegration),
	supabase: keyed(SupabaseIntegrationStatus),
	linear: keyed(LinearIntegrationStatus),
	github: keyed(GithubIntegrationStatus),
	searchConsole: keyed(SearchConsoleIntegrationStatus),
	chat: keyed(V2ChatConnectorList),
	scrapeTargets: keyed(Schema.Array(V2ScrapeTarget)),
	/** The org's data sources, read only while the `dataSources` flag is on. */
	dataSources: keyed(Schema.Array(V2DataSource)),
})
export type Statuses = typeof Statuses.Type

export const Model = Schema.Struct({
	search: IntegrationsSearch,
	/** The clock at entry, for the relative "synced 5m ago" labels. */
	nowMs: Schema.Number,
	statuses: Statuses,
	/** The billing customer: the settings nav's Data platform gate under Clerk. */
	customer: keyed(BillingCustomer),
	/** The session's grants (empty until it loads under Clerk). */
	grants: Schema.Array(Policy.PermissionName),
	/** The org's `dataSources` rollout flag, read with the session (the settings rail's tab). */
	hasDataSources: Schema.Boolean,
	filter: HubFilter,
	/** The OAuth popup flow of the page's integration. */
	connect: ConnectModel,
	/** The page's disconnect confirmation and its in-flight flag (one integration shows at a time). */
	disconnect: Schema.Struct({ dialog: Dialog.Model, isPending: Schema.Boolean }),
	chatCard: ChatCardModel,
	githubCard: GithubCardModel,
	cloudflareCard: CloudflareCardModel,
	prometheusCard: PrometheusCardModel,
	railwayCard: RailwayCardModel,
	planetscaleCard: PlanetscaleCardModel,
	gcpCard: GcpCardModel,
	awsCard: AwsCardModel,
	supabaseCard: SupabaseCardModel,
	searchConsoleCard: SearchConsoleCardModel,
})
export type Model = typeof Model.Type

/** The viewer may connect, disconnect and change integrations (`integrations:manage`). */
export const canManage = (model: Pick<Model, "grants">): boolean =>
	Policy.has(model.grants, "integrations:manage")
