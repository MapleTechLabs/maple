import { AWS_INFRA_KIND_IDS } from "@maple/domain/aws-infra"
import { GCP_INFRA_SERVICE_IDS } from "@maple/domain/gcp-infra"
import { InfraSurfaceLiteral } from "@maple/domain/http"
import { Schema } from "effect"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { InfraSearch } from "../../../route/search"
import * as Frame from "../kit/frame"
import * as InstallModal from "../kit/install-modal"

// `/infra`: the overview, one summary per source.

export const SOURCE_IDS = ["hosts", "containers", "kubernetes", "cloudflare", "railway", "supabase", "planetscale", "gcp", "aws"] as const
export const SourceId = Schema.Literals(SOURCE_IDS)
export type SourceId = typeof SourceId.Type

const FleetScope = Schema.Literals(["saturated", "elevated", "stale"])
const GcpService = Schema.Literals(GCP_INFRA_SERVICE_IDS)

/** `FindingTarget`. */
export const FindingTarget = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("hosts"), scope: FleetScope }),
	Schema.Struct({ kind: Schema.Literal("host"), hostName: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("containers"), scope: FleetScope }),
	Schema.Struct({ kind: Schema.Literal("pods"), scope: Schema.Literals(["saturated", "elevated", "unbounded"]) }),
	Schema.Struct({ kind: Schema.Literal("zone"), zoneName: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("railway"), serviceId: Schema.String, environmentId: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("supabase"), projectRef: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("planetscale"), database: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("gcp"), service: GcpService, keys: Schema.Array(Schema.String) }),
	Schema.Struct({ kind: Schema.Literal("gcpService"), service: GcpService }),
	Schema.Struct({
		kind: Schema.Literal("aws"),
		resourceKind: Schema.Literals(AWS_INFRA_KIND_IDS),
		name: Schema.String,
		cluster: Schema.String,
		region: Schema.String,
		account: Schema.String,
	}),
])
export type FindingTarget = typeof FindingTarget.Type

export const Finding = Schema.Struct({
	key: Schema.String,
	source: SourceId,
	tone: Schema.Literals(["crit", "warn", "stale"]),
	title: Schema.String,
	subject: Schema.optionalKey(Schema.String),
	detail: Schema.String,
	target: FindingTarget,
})
export type Finding = typeof Finding.Type

export const HealthSegment = Schema.Struct({
	key: Schema.Literals(["ok", "elevated", "saturated", "unbounded", "idle"]),
	count: Schema.Number,
})
export type HealthSegment = typeof HealthSegment.Type

export const SourceSummary = Schema.Struct({
	resources: Schema.String,
	segments: Schema.Array(HealthSegment),
	headline: Schema.String,
	headlineTone: Schema.Literals(["neutral", "warn", "crit"]),
	findings: Schema.Array(Finding),
})
export type SourceSummary = typeof SourceSummary.Type

/** One source's read: its summary, `null` when it answered with nothing readable. */
export const SourceReading = Schema.Struct({
	summary: Schema.NullOr(SourceSummary),
})
export type SourceReading = typeof SourceReading.Type

export const SourceSlot = KeyedSchema(SourceReading, LoadFailure)

export const Model = Schema.Struct({
	search: InfraSearch,
	frame: Frame.Model,
	/** `useInfraSurfaces(window)`: the presence probe over the page's window. */
	presence: KeyedSchema(Schema.Array(InfraSurfaceLiteral), LoadFailure),
	sources: Schema.Struct({
		hosts: SourceSlot,
		containers: SourceSlot,
		kubernetes: SourceSlot,
		cloudflare: SourceSlot,
		railway: SourceSlot,
		supabase: SourceSlot,
		planetscale: SourceSlot,
		gcp: SourceSlot,
		aws: SourceSlot,
	}),
	install: InstallModal.Model,
})
export type Model = typeof Model.Type
