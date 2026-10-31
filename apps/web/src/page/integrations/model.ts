import {
	BillingCustomer,
	CloudflareIntegrationStatus,
	GithubIntegrationStatus,
	HazelIntegrationStatus,
	LinearIntegrationStatus,
	RailwayIntegrationStatus,
	SupabaseIntegrationStatus,
} from "@maple/domain/http"
import {
	V2AwsIntegration,
	V2ChatConnectorList,
	V2GcpIntegration,
	V2PlanetScaleDatabaseList,
	V2PlanetScaleIntegration,
	V2ScrapeTarget,
} from "@maple/domain/http/v2"
import { Schema } from "effect"
import { KeyedSchema } from "../../data/keyed"
import { LoadFailure } from "../../data/load-failure"
import { IntegrationsSearch } from "../../route/search"
import * as Dialog from "../../ui/dialog"
import { ChatCardModel } from "./chat"
import { CloudflareCardModel } from "./cloudflare"
import { GithubCardModel } from "./github"
import { PrometheusCardModel } from "./prometheus"
import { RailwayCardModel } from "./railway"
import { PlanetscaleCardModel } from "./planetscale"
import { GcpCardModel } from "./gcp"
import { AwsCardModel } from "./aws"
import { SupabaseCardModel } from "./supabase"
import { ConnectModel } from "./connect"

// `/integrations`: the hub and every integration's page.

const keyed = <A, AI>(schema: Schema.Codec<A, AI>) => KeyedSchema(schema, LoadFailure)

/** The status reads the hub and the headers share (`useIntegrationOverviews`'s atoms). */
export const Statuses = Schema.Struct({
	cloudflare: keyed(CloudflareIntegrationStatus),
	railway: keyed(RailwayIntegrationStatus),
	planetscale: keyed(V2PlanetScaleIntegration),
	planetscaleDatabases: keyed(V2PlanetScaleDatabaseList),
	gcp: keyed(V2GcpIntegration),
	aws: keyed(V2AwsIntegration),
	supabase: keyed(SupabaseIntegrationStatus),
	hazel: keyed(HazelIntegrationStatus),
	linear: keyed(LinearIntegrationStatus),
	github: keyed(GithubIntegrationStatus),
	chat: keyed(V2ChatConnectorList),
	scrapeTargets: keyed(Schema.Array(V2ScrapeTarget)),
})
export type Statuses = typeof Statuses.Type

export const Model = Schema.Struct({
	search: IntegrationsSearch,
	/** The clock at entry, for the relative "synced 5m ago" labels. */
	nowMs: Schema.Number,
	statuses: Statuses,
	/** `useMapleCustomer` (the settings nav's Data platform gate under Clerk). */
	customer: keyed(BillingCustomer),
	/** `useIsOrgAdmin()`: the session's roles (`false` until it loads under Clerk). */
	isAdmin: Schema.Boolean,
	/** The OAuth popup flow of the page's integration (`IntegrationConnectProvider`). */
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
})
export type Model = typeof Model.Type
