import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { Schema } from "effect"
import {
	AgentFeedbackImpact,
	AgentFeedbackKind,
	AgentFeedbackPersistenceError,
	AgentFeedbackSource,
	AgentType,
} from "../agent-feedback"
import { AuthorizationV2 } from "./auth"
import { ListOf, ListQuery, Timestamp, wireExample } from "./envelopes"
import { V2ParameterInvalid } from "./errors"
import { publicError } from "./public-error"
import { AgentFeedbackPublicId } from "./resource-ids"

const isNotBlank = Schema.makeFilter((value: string) => value.trim().length > 0, {
	description: "Must contain a non-whitespace character",
})

const boundedText = (max: number) => Schema.String.check(isNotBlank, Schema.isMaxLength(max))

const optionalLabel = boundedText(200)

const agentFeedbackExample = {
	id: "afb_YofPTrK9782DWwcnXhpcCw",
	object: "agent_feedback",
	kind: "bug",
	impact: "degraded",
	summary: "search_traces ignores the environment filter",
	reason: "I was narrowing slow checkout traces to production for a user; results included staging spans, so I had to filter them by hand.",
	details:
		"Called search_traces with environment=production; 4 of 20 results had deployment.environment=staging.",
	related_to: "search_traces",
	agent: { type: "coding_agent", name: "claude-code", model: "claude-opus-5-5", version: "2.3.0" },
	source: "mcp",
	created_at: "2026-09-28T09:10:00.000Z",
} as const

export const V2AgentFeedbackAgent = Schema.Struct({
	type: AgentType,
	name: Schema.NullOr(Schema.String).annotate({
		description: "The agent or client name, e.g. `claude-code`, `cursor`, `codex`.",
	}),
	model: Schema.NullOr(Schema.String).annotate({
		description: "The model driving the agent, e.g. `claude-opus-5-5`.",
	}),
	version: Schema.NullOr(Schema.String).annotate({ description: "The agent or client version." }),
}).annotate({ identifier: "AgentFeedbackAgent", title: "Agent feedback agent" })

export const V2AgentFeedback = Schema.Struct({
	id: AgentFeedbackPublicId,
	object: Schema.Literal("agent_feedback").annotate({
		description: 'The object type, always `"agent_feedback"`.',
	}),
	kind: AgentFeedbackKind,
	impact: Schema.NullOr(AgentFeedbackImpact),
	summary: Schema.String,
	reason: Schema.String.annotate({
		description: "Why the agent sent this: what it was trying to do and what got in the way.",
	}),
	details: Schema.NullOr(Schema.String),
	related_to: Schema.NullOr(Schema.String).annotate({
		description: "The MCP tool, API endpoint, or page the feedback concerns.",
	}),
	agent: V2AgentFeedbackAgent,
	source: AgentFeedbackSource.annotate({
		description:
			"`mcp` when sent through the `send_maple_feedback` tool, `api` when sent to this endpoint.",
	}),
	created_at: Timestamp,
}).annotate({
	identifier: "AgentFeedback",
	title: "Agent Feedback",
	description:
		"Feedback about Maple sent by an agent: a bug it hit, a capability it missed, docs that misled it. Read by the Maple team.",
	examples: [wireExample(agentFeedbackExample)],
})
export type V2AgentFeedback = Schema.Schema.Type<typeof V2AgentFeedback>

export const V2AgentFeedbackCreateParams = Schema.Struct({
	kind: AgentFeedbackKind,
	impact: Schema.optionalKey(AgentFeedbackImpact),
	summary: boundedText(200).annotate({
		description: "One line: what happened or what is wanted.",
		examples: ["search_traces ignores the environment filter"],
	}),
	reason: boundedText(4000).annotate({
		description:
			"Why you are sending this: what you were trying to do, what got in the way, and why it matters.",
	}),
	details: Schema.optionalKey(
		boundedText(10000).annotate({
			description: "Reproduction steps, expected versus actual behaviour, the request you sent.",
		}),
	),
	related_to: Schema.optionalKey(
		optionalLabel.annotate({
			description: "The MCP tool, API endpoint, or page the feedback concerns.",
			examples: ["search_traces", "POST /v2/traces/search"],
		}),
	),
	agent: Schema.Struct({
		type: AgentType,
		name: Schema.optionalKey(optionalLabel.annotate({ examples: ["claude-code"] })),
		model: Schema.optionalKey(optionalLabel.annotate({ examples: ["claude-opus-5-5"] })),
		version: Schema.optionalKey(optionalLabel.annotate({ examples: ["2.3.0"] })),
	}).annotate({ description: "Who is sending this." }),
}).annotate({
	identifier: "AgentFeedbackCreateParams",
	title: "Agent feedback",
	examples: [
		{
			kind: "bug",
			impact: "degraded",
			summary: agentFeedbackExample.summary,
			reason: agentFeedbackExample.reason,
			related_to: "search_traces",
			agent: { type: "coding_agent", name: "claude-code", model: "claude-opus-5-5" },
		},
	],
})
export type V2AgentFeedbackCreateParams = Schema.Schema.Type<typeof V2AgentFeedbackCreateParams>

const persistence = publicError(AgentFeedbackPersistenceError)

const AgentFeedbackList = ListOf(V2AgentFeedback).annotate({
	identifier: "AgentFeedbackList",
	title: "Agent feedback list",
})

export class V2AgentFeedbackApiGroup extends HttpApiGroup.make("agentFeedback")
	.add(
		HttpApiEndpoint.post("create", "/", {
			payload: V2AgentFeedbackCreateParams,
			success: V2AgentFeedback,
			error: [persistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "createAgentFeedback",
				summary: "Send feedback",
				description:
					"Sends feedback about Maple from an agent to the Maple team: say what kind it is, which agent is sending it, and why. Needs no scope: any API key of the organization can send feedback.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("list", "/", {
			query: ListQuery,
			success: AgentFeedbackList,
			error: [V2ParameterInvalid.schema, persistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listAgentFeedback",
				summary: "List feedback",
				description:
					"Feedback agents in this organization have sent, newest first. Needs no scope: any API key of the organization can list it.",
			}),
		),
	)
	.prefix("/v2/agent_feedback")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "Agent Feedback",
			description: "Feedback about Maple from agents: bugs, missing capabilities, misleading docs.",
		}),
	) {}
