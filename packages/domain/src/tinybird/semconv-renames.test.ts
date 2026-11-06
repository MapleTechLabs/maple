import { describe, expect, it } from "vitest"
import * as CH from "@maple-dev/effect-orm/expr"
import { compile } from "@maple-dev/effect-orm/sql"
import {
	DEPLOYMENT_ENV_SQL,
	MESSAGING_DESTINATION_SQL,
	deploymentEnvExpr,
	messagingDestinationExpr,
} from "./semconv-renames"
import { latestSnapshotStatements } from "../generated/clickhouse-schema"
import { Array as Arr, Option, String as Str } from "effect"

describe("semconv rename coalescing", () => {
	// Byte-identity is load-bearing, not cosmetic: the service-map and
	// service-overview routes union an MV branch with a raw-`traces` branch, and
	// the two only merge if both sides compute the same grouping key.
	it("compiles byte-identically from the DSL expressions the read side uses", () => {
		const mapColumn = (name: string) => {
			const column = CH.dynamicColumn<Record<string, string>>(name)
			return { get: (key: string) => CH.mapGet(column, key) }
		}
		expect(compile(deploymentEnvExpr(mapColumn("ResourceAttributes")).toFragment())).toBe(
			DEPLOYMENT_ENV_SQL,
		)
		expect(compile(messagingDestinationExpr(mapColumn("SpanAttributes")).toFragment())).toBe(
			MESSAGING_DESTINATION_SQL,
		)
	})

	// The regression this guards: an MV that reads only the deprecated key
	// materializes an EMPTY environment for any service instrumented with an OTel
	// SDK new enough to have adopted the rename — and the rollups are what the
	// dashboards read. See ClickHouse migration 0020.
	it("leaves no materialized view reading a deprecated key on its own", () => {
		const bare = Arr.map(
			Arr.filter(
				Arr.filter(
					Arr.filter(latestSnapshotStatements, (statement) =>
						Str.includes("CREATE MATERIALIZED VIEW")(statement),
					),
					(statement) => Str.includes("SpanAttributes['messaging.destination']")(statement),
				),
				(statement) => !Str.includes(MESSAGING_DESTINATION_SQL)(statement),
			),
			(statement) =>
				Option.getOrUndefined(
					Option.flatMap(Str.match(/VIEW IF NOT EXISTS (\w+)/)(statement), (match) =>
						Option.fromNullishOr(match[1]),
					),
				),
		)
		expect(bare).toEqual([])
	})

	it("is the only way a materialized view extracts DeploymentEnv", () => {
		const offenders = Arr.map(
			Arr.filter(
				Arr.filter(
					Arr.filter(latestSnapshotStatements, (statement) =>
						Str.includes("CREATE MATERIALIZED VIEW")(statement),
					),
					(statement) => Str.includes("AS DeploymentEnv")(statement),
				),
				(statement) => !Str.includes(`${DEPLOYMENT_ENV_SQL} AS DeploymentEnv`)(statement),
			),
			(statement) =>
				Option.getOrUndefined(
					Option.flatMap(Str.match(/VIEW IF NOT EXISTS (\w+)/)(statement), (match) =>
						Option.fromNullishOr(match[1]),
					),
				),
		)
		expect(offenders).toEqual([])
	})
})
