import type { V2AwsConnection, V2AwsIntegration } from "@maple/domain/http/v2"
import { countLabel } from "@maple/ui/lib/format"
import { Option } from "effect"
import { metricStreamOf, selectionOf } from "./aws"
import { awsConditionOf, fold } from "./derive"
import type { FlowSpec, LiveHealth } from "./flow"
import type { Model } from "./model"

// AWS in the connect flow: a read-only role, then regions and services, then the metric stream.
// The role goes first: the stream is only asked for once Maple can see the account.

export const awsStatusOf = (model: Model): V2AwsIntegration | null =>
	fold(
		model.statuses.aws,
		(data): V2AwsIntegration | null => data,
		() => null,
	)

export type AwsFlowConnection =
	| { readonly _tag: "none" }
	/** Made in this visit, before the status read that lists it. */
	| { readonly _tag: "loading" }
	| { readonly _tag: "found"; readonly connection: V2AwsConnection }

/**
 * The connection the flow works on: the one made or set up in this visit, else the newest one,
 * so a setup left half done resumes. The account form ("Connect another account") shows none.
 */
export const awsFlowConnection = (model: Model): AwsFlowConnection => {
	const status = awsStatusOf(model)
	const card = model.awsCard
	if (status === null || card.isAdding) return { _tag: "none" }
	if (card.flowId !== null) {
		const made = status.connections.find((connection) => connection.id === card.flowId)
		return made === undefined ? { _tag: "loading" } : { _tag: "found", connection: made }
	}
	const newest = status.connections.at(-1)
	return newest === undefined ? { _tag: "none" } : { _tag: "found", connection: newest }
}

/** "2 regions, 5 services" once the pick can be streamed, else null. The defaults count as a pick. */
export const awsChosenLabel = (model: Model, connection: V2AwsConnection): string | null => {
	const selection = selectionOf(connection, model.awsCard.selection)
	return Option.isNone(metricStreamOf(selection))
		? null
		: `${countLabel(selection.regions.length, "region")}, ${countLabel(selection.namespaces.length, "service")}`
}

const liveOf = (connection: V2AwsConnection | null, nowMs: number): LiveHealth => {
	if (connection === null) return "pending"
	switch (awsConditionOf(connection, nowMs)) {
		case "receiving":
			return "healthy"
		case "failing":
		case "not-receiving":
		case "stopped":
			return "attention"
		default:
			return "pending"
	}
}

export const awsFlow = (model: Model): FlowSpec => {
	const flow = awsFlowConnection(model)
	const connection = flow._tag === "found" ? flow.connection : null
	const isVerified = connection !== null && connection.verified_at !== null
	const chosen = isVerified ? awsChosenLabel(model, connection) : null
	const live = liveOf(connection, model.nowMs)
	return {
		stages: ["connect", "choose", "live"],
		connected: isVerified ? `Role in ${connection.account_id}` : null,
		chosen,
		live,
		hint: {
			connect: model.awsCard.isCreating
				? "Building the role stack for this account."
				: connection === null
					? "Enter the account ID to build its role stack."
					: isVerified
						? "Role works. Next, choose what to stream."
						: "Keep this tab open. Continue unlocks when the role answers.",
			choose:
				chosen === null
					? "Pick at least one region and one service."
					: `${chosen} picked. Next, deploy the stream that sends them.`,
			live:
				live === "healthy"
					? "Live. Metrics keep streaming on their own."
					: "Saved. Safe to leave: Maple keeps checking and shows progress on the source page.",
		},
	}
}
