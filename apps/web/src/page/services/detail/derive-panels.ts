import type { DependencyBundle } from "./model-tabs"
import { Array as Arr, Order } from "effect"

// Pure halves of the Overview panels (the dependency strip).

export type DependencyKind = "service" | "database" | "http" | "messaging" | "rpc"

export type StripTarget = Readonly<{ id: string; kind: DependencyKind; name: string; estimatedCalls: number }>

/** The "Talks to" chips: every downstream target, busiest first. */
export const stripTargets = (bundle: DependencyBundle): ReadonlyArray<StripTarget> =>
	Arr.sort(
		[
			...Arr.flatMap(bundle.serviceEdges, (edge): ReadonlyArray<StripTarget> =>
				edge.targetService === ""
					? []
					: [
							{
								id: `service:${edge.targetService}`,
								kind: "service",
								name: edge.targetService,
								estimatedCalls: edge.estimatedCallCount,
							},
						],
			),
			...Arr.flatMap(bundle.dbEdges, (edge): ReadonlyArray<StripTarget> =>
				edge.dbSystem === ""
					? []
					: [
							{
								id: `database:${edge.dbSystem}:${edge.dbNamespace}`,
								kind: "database",
								name: edge.dbNamespace
									? `${edge.dbSystem} · ${edge.dbNamespace}`
									: edge.dbSystem,
								estimatedCalls: edge.estimatedCallCount,
							},
						],
			),
			...Arr.flatMap(bundle.externalEdges, (edge): ReadonlyArray<StripTarget> =>
				edge.targetName === ""
					? []
					: [
							{
								id: `${edge.targetType}:${edge.targetName}`,
								kind: edge.targetType,
								name: edge.targetName,
								estimatedCalls: edge.estimatedCallCount,
							},
						],
			),
		],
		Order.flip(Order.mapInput(Order.Number, (target: StripTarget) => target.estimatedCalls)),
	)
