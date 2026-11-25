import type { V2AwsConnection, V2AwsIntegration } from "@maple/domain/http/v2"
import { countLabel } from "@maple/ui/lib/format"
import { Option, Array as Arr } from "effect"
import {
	AWS_CONDITION_LABEL,
	type AwsConnectionCondition,
	awsConditionOf,
} from "../../../integrations/derive"
import {
	attentionOr,
	type CardStatus,
	CONNECT,
	fold,
	type IntegrationOverview,
	isoMs,
	lastSyncOf,
	maxMs,
	NOT_CONNECTED,
	unavailableOverview,
	unavailableStatus,
} from "../../../integrations/overview"
import type { ProviderModule } from "../../../integrations/provider"
import { AWS_STATUS_READ, type AwsCardModel, AwsMessage, initAwsCard } from "./aws"
import { awsFlow } from "./flow-aws"
import { enterAws, isAwsPending, isAwsStreaming, statusArrived, update } from "./update-aws"
import { awsCard } from "./view-aws"
import { awsFlowView } from "./view-flow-aws"

// AWS's part of `/integrations` and `/sources/new`: the account form, each connection's setup,
// checks, metric stream and modules, and the stacks left to clean up after a removal.

/** A metric stream delivers about every minute. */
const AWS_WATCH_MS = 60_000

/** Worst first: a connection's own condition and the integration's worst follow this order. */
const AWS_CONDITION_RANK: ReadonlyArray<AwsConnectionCondition> = [
	"failing",
	"not-receiving",
	"stopped",
	"setup",
	"outdated",
	"metrics-off",
	"waiting",
	"receiving",
]

const worstAwsCondition = (connections: ReadonlyArray<V2AwsConnection>, nowMs: number) => {
	const conditions = Arr.map(connections, (connection) => awsConditionOf(connection, nowMs))
	return Option.getOrElse(
		Arr.findFirst(AWS_CONDITION_RANK, (condition) => conditions.includes(condition)),
		(): AwsConnectionCondition => "receiving",
	)
}

export const AWS: ProviderModule<V2AwsIntegration, AwsCardModel, AwsMessage> = {
	id: "aws",
	statusRead: AWS_STATUS_READ,
	init: initAwsCard,
	update,
	onEnter: enterAws,
	onStatus: statusArrived,
	subscriptions: [
		// Connections still waiting for their stack are checked again while one's setup is open.
		{
			everyMs: 10_000,
			isActive: (model, env) => env.isShown && isAwsPending(model, env.status),
			tick: AwsMessage.TickedAwsPending(),
		},
		{
			everyMs: AWS_WATCH_MS,
			isActive: (_model, env) => env.isShown && isAwsStreaming(env.status),
			tick: AwsMessage.TickedAwsWatch(),
		},
	],
	card: (h, model, timeZone, focusId) => [awsCard(h, model, timeZone, focusId)],
	flow: (model) => awsFlow(model),
	flowView: (h, model, stage, timeZone) => awsFlowView(h, model, stage, timeZone),
	cardStatus: (slot, { nowMs }) =>
		fold(
			slot,
			(status): CardStatus => {
				if (status.connections.length === 0) return NOT_CONNECTED
				const worst = worstAwsCondition(status.connections, nowMs)
				return worst === "receiving"
					? { label: countLabel(status.connections.length, "account"), variant: "ok" }
					: {
							label: AWS_CONDITION_LABEL[worst],
							variant: worst === "failing" || worst === "not-receiving" ? "crit" : "warn",
						}
			},
			unavailableStatus,
		),
	overview: (slot, { nowMs }) =>
		fold(
			slot,
			(status): IntegrationOverview => {
				if (status.connections.length === 0) return CONNECT
				const conditions = Arr.map(status.connections, (connection) =>
					awsConditionOf(connection, nowMs),
				)
				const failing = Arr.filter(conditions, (condition) => condition === "failing").length
				const worst = worstAwsCondition(status.connections, nowMs)
				const issue =
					worst === "failing"
						? `${countLabel(failing, "account")} failing`
						: worst === "receiving"
							? null
							: AWS_CONDITION_LABEL[worst]
				// A stack not deployed yet, or a first delivery on its way, is setup in progress, not a failure.
				const health: Pick<IntegrationOverview & { kind: "connected" }, "health" | "stateLabel"> =
					worst === "setup" || worst === "waiting"
						? { health: "pending", stateLabel: AWS_CONDITION_LABEL[worst] }
						: attentionOr(issue)
				const receiving = Arr.filter(conditions, (condition) => condition === "receiving").length
				const accounts = countLabel(status.connections.length, "account")
				return {
					kind: "connected",
					...health,
					context:
						status.connections.length === 1 ? (status.connections[0]?.account_id ?? null) : null,
					stat: conditions.includes("setup")
						? accounts
						: `${receiving} of ${accounts} sending metrics`,
					lastSync: lastSyncOf(
						maxMs(
							Arr.map(status.connections, (connection) =>
								isoMs(connection.metrics_last_received_at),
							),
						),
						"last data",
					),
					issue,
				}
			},
			unavailableOverview,
		),
}
