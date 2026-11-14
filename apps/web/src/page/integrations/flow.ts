import { Schema } from "effect"
import type { DataIntegration } from "../../route/data-integrations"
import { overviewOf } from "./derive"
import type { Model } from "./model"
import { providerModuleOf } from "./provider-modules"
import { gcpFlow } from "../infra-integrations/gcp/integration/flow-gcp"
import { planetscaleFlow } from "../infra-integrations/planetscale/integration/flow-planetscale"
import { prometheusFlow } from "./flow-prometheus"
import { cloudflareFlow } from "../infra-integrations/cloudflare/integration/flow-cloudflare"
import { githubFlow } from "./flow-github"
import { awsFlow } from "../infra-integrations/aws/integration/flow-aws"

// Where a source stands in `/sources/new`'s flow: Connect, Choose data, Go live.
// Each source answers it from its own status; the page frames the steps and owns which one shows.

export const FlowStage = Schema.Literals(["connect", "choose", "live"])
export type FlowStage = typeof FlowStage.Type

export type LiveHealth = "pending" | "healthy" | "attention"

export type FlowSpec = Readonly<{
	/** The steps this source has, in order. Choose data is skipped when the provider scopes it. */
	stages: ReadonlyArray<FlowStage>
	/** Connect's answer once it worked (the account or workspace reached), else null. */
	connected: string | null
	/** Choose data's answer once the choice is valid ("14 services, 2 envs"), else null. */
	chosen: string | null
	live: LiveHealth
	/** The footer's line per step: why Continue is or is not ready. */
	hint: Readonly<Record<FlowStage, string>>
}>

export type FlowContext = Readonly<{
	/** WarpStream targets read as Prometheus ones: added in this visit counts as connected. */
	hasAddedTarget: boolean
}>

const genericFlow = (model: Model, integration: DataIntegration): FlowSpec => {
	const overview = overviewOf(model.statuses, model.nowMs, integration)
	const connected = overview?.kind === "connected" ? (overview.context ?? "Connected") : null
	const live: LiveHealth =
		overview?.kind !== "connected" ? (connected === null ? "pending" : "healthy") : overview.health
	return {
		stages: ["connect", "live"],
		connected,
		chosen: null,
		live,
		hint: {
			connect: connected === null ? "Connect to continue." : "Connected. Next, go live.",
			choose: "",
			live:
				live === "healthy"
					? "Live. Data keeps arriving on its own."
					: "Saved. Safe to leave while it starts.",
		},
	}
}

export const flowOf = (model: Model, integration: DataIntegration, context: FlowContext): FlowSpec => {
	const provider = providerModuleOf(integration)
	if (provider !== undefined) return provider.flow(model)
	switch (integration) {
		case "prometheus":
		case "warpstream":
			return prometheusFlow(model, integration, context)
		case "aws":
			return awsFlow(model)
		case "gcp":
			return gcpFlow(model)
		case "planetscale":
			return planetscaleFlow(model)
		case "cloudflare":
			return cloudflareFlow(model)
		case "github":
			return githubFlow(model)
		default:
			return genericFlow(model, integration)
	}
}

/** The step after `stage` this source has, if any. */
export const nextStage = (spec: FlowSpec, stage: FlowStage): FlowStage | null =>
	spec.stages[spec.stages.indexOf(stage) + 1] ?? null

/** The step before `stage`, or null on the first one (Back leaves for the picker). */
export const previousStage = (spec: FlowSpec, stage: FlowStage): FlowStage | null => {
	const index = spec.stages.indexOf(stage)
	return index > 0 ? (spec.stages[index - 1] ?? null) : null
}

/** Continue is ready when the step has its answer; Go live has no Continue. */
export const canContinue = (spec: FlowSpec, stage: FlowStage): boolean =>
	stage === "connect" ? spec.connected !== null : stage === "choose" ? spec.chosen !== null : false
