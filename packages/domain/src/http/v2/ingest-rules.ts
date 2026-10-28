import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { Schema } from "effect"
import {
	INGEST_RULE_LIMITS,
	IngestRuleCondition,
	IngestRuleDetector,
	IngestRuleRedactMethod,
	IngestRuleScope,
	IngestRuleSignal,
	type IngestRuleAction,
} from "../../ingest-rules"
import { IngestRuleId } from "../../primitives"
import {
	IngestRuleForbiddenError,
	IngestRuleNotFoundError,
	IngestRulePersistenceError,
	IngestRuleValidationError,
} from "../ingest-rules"
import { AuthorizationV2 } from "./auth"
import { ListOf, ListQuery, Timestamp, wireExample } from "./envelopes"
import { V2ParameterInvalid } from "./errors"
import { publicErrors } from "./public-error"
import { PublicId, PublicIdPrefixes } from "./public-id"

/** `irule_…` public ID ⇄ internal `IngestRuleId` (raw UUID). */
export const IngestRulePublicId = PublicId(PublicIdPrefixes.ingestRule, IngestRuleId)

const RuleName = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(INGEST_RULE_LIMITS.nameLength),
	Schema.isTrimmed(),
)
const Position = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 10_000 }))

export const V2IngestRuleAction = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("drop"),
		keep_percent: Schema.Number.check(
			Schema.isInt(),
			Schema.isBetween({ minimum: 0, maximum: 100 }),
		).annotate({
			description:
				"Share of matching records kept, 0 to 100. Sampled on trace id, so a trace is kept or dropped whole.",
			examples: [0],
		}),
	}).annotate({ identifier: "IngestRuleDropAction", title: "Drop" }),
	Schema.Struct({
		type: Schema.Literal("redact"),
		keys: Schema.Array(Schema.String).annotate({
			description:
				"Attribute keys whose whole value is redacted. Case-insensitive; `*` matches any run of characters.",
			examples: [["*password*", "http.request.header.authorization"]],
		}),
		detectors: Schema.Array(IngestRuleDetector).annotate({
			description: "Built-in detectors; only the matched text is replaced.",
			examples: [["email", "credit_card"]],
		}),
		patterns: Schema.Array(Schema.String).annotate({
			description:
				"Custom regular expressions (no lookaround or backreferences); only the matched text is replaced.",
			examples: [["ORD-[0-9]+"]],
		}),
		scopes: Schema.Array(IngestRuleScope).annotate({
			description:
				"Where to look: record `attributes`, `resource` attributes, span `events`, log `body`.",
			examples: [["attributes", "body"]],
		}),
		method: IngestRuleRedactMethod.annotate({
			description:
				"`mask` writes `[REDACTED]`, `hash` writes a per-org HMAC (`hash:<hex16>`), `remove` deletes key matches.",
			examples: ["mask"],
		}),
	}).annotate({ identifier: "IngestRuleRedactAction", title: "Redact" }),
]).annotate({ identifier: "IngestRuleAction", title: "Ingest rule action" })
export type V2IngestRuleAction = Schema.Schema.Type<typeof V2IngestRuleAction>

export const toV2IngestRuleAction = (action: IngestRuleAction): V2IngestRuleAction =>
	action._tag === "drop"
		? { type: "drop", keep_percent: action.keepPercent }
		: {
				type: "redact",
				keys: action.keys,
				detectors: action.detectors,
				patterns: action.patterns,
				scopes: action.scopes,
				method: action.method,
			}

export const fromV2IngestRuleAction = (action: V2IngestRuleAction): IngestRuleAction =>
	action.type === "drop"
		? { _tag: "drop", keepPercent: action.keep_percent }
		: {
				_tag: "redact",
				keys: action.keys,
				detectors: action.detectors,
				patterns: action.patterns,
				scopes: action.scopes,
				method: action.method,
			}

const signalsField = Schema.Array(IngestRuleSignal).annotate({
	description: "Signals the rule applies to.",
	examples: [["logs"]],
})
const conditionsField = Schema.Array(IngestRuleCondition).annotate({
	description:
		"All must match. `field` is one of service_name, name, attribute, resource_attribute, body, severity, span_kind, span_status; `attribute` fields take a `key`.",
	examples: [[{ field: "severity", op: "lt", value: "info" }]],
})

const ingestRuleExample = {
	id: "irule_YofPTrK9782DWwcnXhpcCw",
	object: "ingest_rule",
	name: "Drop debug logs",
	enabled: true,
	position: 0,
	signals: ["logs"],
	conditions: [{ field: "severity", op: "lt", value: "info" }],
	action: { type: "drop", keep_percent: 0 },
	created_at: "2026-10-28T12:00:00.000Z",
	updated_at: "2026-10-28T12:00:00.000Z",
} as const

export const V2IngestRule = Schema.Struct({
	id: IngestRulePublicId,
	object: Schema.Literal("ingest_rule").annotate({
		description: 'The object type, always `"ingest_rule"`.',
	}),
	name: Schema.String.annotate({
		description: "Label shown in the dashboard.",
		examples: ["Drop debug logs"],
	}),
	enabled: Schema.Boolean.annotate({
		description: "Disabled rules are skipped at ingest.",
		examples: [true],
	}),
	position: Position.annotate({
		description: "Redact rules run in ascending position; drop rules always run before redact rules.",
		examples: [0],
	}),
	signals: signalsField,
	conditions: conditionsField,
	action: V2IngestRuleAction,
	created_at: Timestamp.annotate({ description: "When the rule was created." }),
	updated_at: Timestamp.annotate({ description: "When the rule was last updated." }),
}).annotate({
	identifier: "IngestRule",
	title: "Ingest Rule",
	description:
		"A rule the ingest gateway applies before telemetry is stored or billed: drop matching records, or redact values in them. Applies to new data within 30 seconds.",
	examples: [wireExample(ingestRuleExample)],
})
export type V2IngestRule = Schema.Schema.Type<typeof V2IngestRule>

export const V2IngestRuleCreateParams = Schema.Struct({
	name: RuleName,
	enabled: Schema.optionalKey(Schema.Boolean),
	position: Schema.optionalKey(Position),
	signals: signalsField,
	conditions: Schema.optionalKey(conditionsField),
	action: V2IngestRuleAction,
}).annotate({
	identifier: "IngestRuleCreateParams",
	title: "Ingest rule create parameters",
	description: "Request body for creating an ingest rule. `position` defaults to after the last rule.",
	examples: [
		wireExample({
			name: "Drop debug logs",
			signals: ["logs"],
			conditions: [{ field: "severity", op: "lt", value: "info" }],
			action: { type: "drop", keep_percent: 0 },
		}),
	],
})
export type V2IngestRuleCreateParams = Schema.Schema.Type<typeof V2IngestRuleCreateParams>

export const V2IngestRuleUpdateParams = Schema.Struct({
	name: Schema.optionalKey(RuleName),
	enabled: Schema.optionalKey(Schema.Boolean),
	position: Schema.optionalKey(Position),
	signals: Schema.optionalKey(signalsField),
	conditions: Schema.optionalKey(conditionsField),
	action: Schema.optionalKey(V2IngestRuleAction),
}).annotate({
	identifier: "IngestRuleUpdateParams",
	title: "Ingest rule update parameters",
	description: "Request body for updating an ingest rule. Omitted fields are left unchanged.",
	examples: [wireExample({ enabled: false })],
})
export type V2IngestRuleUpdateParams = Schema.Schema.Type<typeof V2IngestRuleUpdateParams>

export const V2IngestRuleDeleteResponse = Schema.Struct({
	id: IngestRulePublicId,
	object: Schema.Literal("ingest_rule"),
	deleted: Schema.Literal(true),
}).annotate({
	identifier: "IngestRuleDeleteResponse",
	title: "Ingest rule delete response",
	description: "Confirmation that an ingest rule was deleted.",
	examples: [wireExample({ id: "irule_YofPTrK9782DWwcnXhpcCw", object: "ingest_rule", deleted: true })],
})

const [ruleNotFound, ruleValidation, rulePersistence, ruleForbidden] = publicErrors(
	IngestRuleNotFoundError,
	IngestRuleValidationError,
	IngestRulePersistenceError,
	IngestRuleForbiddenError,
)

const IngestRuleList = ListOf(V2IngestRule).annotate({
	identifier: "IngestRuleList",
	title: "Ingest rule list",
	description: "A cursor-paginated page of ingest rules in position order.",
})

export class V2IngestRulesApiGroup extends HttpApiGroup.make("ingestRules")
	.add(
		HttpApiEndpoint.get("list", "/", {
			query: ListQuery,
			success: IngestRuleList,
			error: [V2ParameterInvalid.schema, rulePersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listIngestRules",
				summary: "List ingest rules",
				description:
					"Returns your organization's ingest rules in position order. Requires the `ingest_rules:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("create", "/", {
			payload: V2IngestRuleCreateParams,
			success: V2IngestRule,
			error: [ruleForbidden, ruleValidation, rulePersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "createIngestRule",
				summary: "Create an ingest rule",
				description:
					"Creates a drop or redact rule. Requires the `ingest_rules:write` scope and an admin role.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("retrieve", "/:id", {
			params: { id: IngestRulePublicId },
			success: V2IngestRule,
			error: [ruleNotFound, rulePersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getIngestRule",
				summary: "Retrieve an ingest rule",
				description:
					"Returns one ingest rule by its `irule_…` ID. Requires the `ingest_rules:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.patch("update", "/:id", {
			params: { id: IngestRulePublicId },
			payload: V2IngestRuleUpdateParams,
			success: V2IngestRule,
			error: [ruleForbidden, ruleNotFound, ruleValidation, rulePersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "updateIngestRule",
				summary: "Update an ingest rule",
				description:
					"Updates a rule; omitted fields are unchanged. Requires the `ingest_rules:write` scope and an admin role.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.delete("delete", "/:id", {
			params: { id: IngestRulePublicId },
			success: V2IngestRuleDeleteResponse,
			error: [ruleForbidden, ruleNotFound, rulePersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "deleteIngestRule",
				summary: "Delete an ingest rule",
				description:
					"Deletes an ingest rule. Already-stored telemetry is unaffected. Requires the `ingest_rules:write` scope and an admin role.",
			}),
		),
	)
	.prefix("/v2/ingest_rules")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "Ingest Rules",
			description:
				"Drop or redact telemetry before Maple stores or bills it. Dropped data is not metered; redaction happens before anything is written to disk.",
		}),
	) {}
