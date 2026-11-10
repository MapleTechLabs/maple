/**
 * The infra tools' `kind` parameters. list_infra lists kinds (plural) and inspect_infra names one
 * entity (singular); each accepts the other spelling, since models carry one over to the other.
 */
import { InfraEntityKind, InfraKind } from "@maple/domain/mcp-outputs"
import { Schema, SchemaTransformation, Array as Arr } from "effect"

/** The kinds list_infra lists and the entities inspect_infra names: the outputs' own literals. */
export const INFRA_KINDS = InfraKind.literals
export const ENTITY_KINDS = InfraEntityKind.literals

/** Kinds read from a connected integration's polled metrics rather than a collector. */
export const PROVIDER_KINDS = [
	"cloudflare_zones",
	"cloudflare_workers",
	"railway_services",
	"planetscale_databases",
] as const satisfies ReadonlyArray<InfraKind>
export type ProviderKind = (typeof PROVIDER_KINDS)[number]

/** Kinds a collector reports (hostmetrics, kubeletstats, docker_stats). */
export type CollectorKind = Exclude<InfraKind, ProviderKind>

export const isProviderKind = (kind: string): kind is ProviderKind =>
	Arr.some(PROVIDER_KINDS, (provider) => provider === kind)

const TO_ENTITY = {
	hosts: "host",
	pods: "pod",
	nodes: "node",
	workloads: "workload",
	containers: "container",
	host: "host",
	pod: "pod",
	node: "node",
	workload: "workload",
	container: "container",
	cloudflare_zones: "cloudflare_zone",
	cloudflare_workers: "cloudflare_worker",
	railway_services: "railway_service",
	planetscale_databases: "planetscale_database",
	cloudflare_zone: "cloudflare_zone",
	cloudflare_worker: "cloudflare_worker",
	railway_service: "railway_service",
	planetscale_database: "planetscale_database",
} as const satisfies Record<InfraKind | InfraEntityKind, InfraEntityKind>

const TO_KIND = {
	hosts: "hosts",
	pods: "pods",
	nodes: "nodes",
	workloads: "workloads",
	containers: "containers",
	host: "hosts",
	pod: "pods",
	node: "nodes",
	workload: "workloads",
	container: "containers",
	cloudflare_zones: "cloudflare_zones",
	cloudflare_workers: "cloudflare_workers",
	railway_services: "railway_services",
	planetscale_databases: "planetscale_databases",
	cloudflare_zone: "cloudflare_zones",
	cloudflare_worker: "cloudflare_workers",
	railway_service: "railway_services",
	planetscale_database: "planetscale_databases",
} as const satisfies Record<InfraKind | InfraEntityKind, InfraKind>

const EITHER = Schema.Literals([...INFRA_KINDS, ...ENTITY_KINDS])

/** A list_infra kind; the singular is read as its plural. */
export const optionalInfraKind = (description: string) =>
	Schema.optional(
		EITHER.annotate({ description }).pipe(
			Schema.decodeTo(
				InfraKind,
				SchemaTransformation.transform({ decode: (kind) => TO_KIND[kind], encode: (kind) => kind }),
			),
		),
	)

/** An inspect_infra kind; the plural is read as its singular. */
export const entityKind = (description: string) =>
	EITHER.annotate({ description }).pipe(
		Schema.decodeTo(
			InfraEntityKind,
			SchemaTransformation.transform({ decode: (kind) => TO_ENTITY[kind], encode: (kind) => kind }),
		),
	)
