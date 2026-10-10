/**
 * The infra tools' `kind` parameters. list_infra lists kinds (plural) and inspect_infra names one
 * entity (singular); each accepts the other spelling, since models carry one over to the other.
 */
import { Schema, SchemaTransformation } from "effect"

export const INFRA_KINDS = ["hosts", "pods", "nodes", "workloads", "containers"] as const
export const ENTITY_KINDS = ["host", "pod", "node", "workload", "container"] as const

type InfraKind = (typeof INFRA_KINDS)[number]
type EntityKind = (typeof ENTITY_KINDS)[number]

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
} as const satisfies Record<InfraKind | EntityKind, EntityKind>

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
} as const satisfies Record<InfraKind | EntityKind, InfraKind>

const EITHER = Schema.Literals([...INFRA_KINDS, ...ENTITY_KINDS])

/** A list_infra kind; the singular is read as its plural. */
export const optionalInfraKind = (description: string) =>
	Schema.optional(
		EITHER.annotate({ description }).pipe(
			Schema.decodeTo(
				Schema.Literals(INFRA_KINDS),
				SchemaTransformation.transform({ decode: (kind) => TO_KIND[kind], encode: (kind) => kind }),
			),
		),
	)

/** An inspect_infra kind; the plural is read as its singular. */
export const entityKind = (description: string) =>
	EITHER.annotate({ description }).pipe(
		Schema.decodeTo(
			Schema.Literals(ENTITY_KINDS),
			SchemaTransformation.transform({ decode: (kind) => TO_ENTITY[kind], encode: (kind) => kind }),
		),
	)
