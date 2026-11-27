import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { Array as Arr, Schema } from "effect"
import {
	INGEST_RULE_LIMITS,
	IngestRuleCondition,
	IngestRuleDetector,
	IngestRuleRedactMethod,
	IngestRuleScope,
	IngestRuleSignal,
	IngestParseSource,
	IngestTimestampFormat,
	type IngestParseStep,
	type IngestRuleAction,
} from "../../ingest-rules"
import { IngestRuleId } from "@maple/primitives"
import {
	IngestRuleForbiddenError,
	IngestRuleNotFoundError,
	IngestRulePersistenceError,
	IngestRuleValidationError,
} from "../ingest-rules"
import { AuthorizationV2 } from "./auth"
import { ListOf, ListQuery, Timestamp, wireExample } from "./envelopes"
import { V2ParameterInvalid } from "./errors"
import { V2WarehouseReadErrors } from "./query-errors"
import { publicErrors } from "./public-error"
import { PublicId, PublicIdPrefixes } from "./public-id"
import { EndpointAccess, handler, requires } from "../endpoint-access"

/** `irule_…` public ID ⇄ internal `IngestRuleId` (raw UUID). */
export const IngestRulePublicId = PublicId(PublicIdPrefixes.ingestRule, IngestRuleId)

const RuleName = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(INGEST_RULE_LIMITS.nameLength),
	Schema.isTrimmed(),
)
const Position = Schema.Number.check(
	Schema.isInt(),
	Schema.isBetween({ minimum: 0, maximum: INGEST_RULE_LIMITS.maxPosition }),
)

const stepSource = {
	source: IngestParseSource.annotate({ description: "Read the log `body`, or the log attribute `key`." }),
	key: Schema.optionalKey(Schema.String).annotate({
		description: "The attribute to read when `source` is `attribute`.",
	}),
}
const stepPrefix = {
	prefix: Schema.optionalKey(Schema.String).annotate({
		description: "Prepended to every attribute key the step writes.",
		examples: ["app."],
	}),
}

export const V2IngestParseStep = Schema.Union([
	Schema.Struct({ type: Schema.Literal("json"), ...stepSource, ...stepPrefix }).annotate({
		identifier: "IngestParseJsonStep",
		title: "JSON",
		description: "Flattens a JSON object, or a structured body, into attributes with dotted keys.",
	}),
	Schema.Struct({
		type: Schema.Literal("regex"),
		...stepSource,
		pattern: Schema.String.annotate({
			description:
				"A regular expression with named groups; each group that matched becomes an attribute.",
			examples: ["^(?<method>[A-Z]+) (?<path>[^ ]+)"],
		}),
		...stepPrefix,
	}).annotate({ identifier: "IngestParseRegexStep", title: "Regex" }),
	Schema.Struct({
		type: Schema.Literal("grok"),
		...stepSource,
		pattern: Schema.String.annotate({
			description:
				"A grok pattern: `%{PATTERN:field}` or `%{PATTERN:field:int}` from Maple's grok library.",
			examples: ["%{IP:client.address} %{WORD:method} %{NOTSPACE:path}"],
		}),
		...stepPrefix,
	}).annotate({ identifier: "IngestParseGrokStep", title: "Grok" }),
	Schema.Struct({ type: Schema.Literal("severity"), ...stepSource }).annotate({
		identifier: "IngestParseSeverityStep",
		title: "Severity",
		description: "Sets the log severity from a level name (`warn`, `error`) or number (1 to 24).",
	}),
	Schema.Struct({
		type: Schema.Literal("timestamp"),
		...stepSource,
		format: IngestTimestampFormat.annotate({
			description: "How the value is written.",
			examples: ["rfc3339"],
		}),
	}).annotate({
		identifier: "IngestParseTimestampStep",
		title: "Timestamp",
		description: "Sets the log timestamp.",
	}),
]).annotate({ identifier: "IngestParseStep", title: "Parse step" })
export type V2IngestParseStep = Schema.Schema.Type<typeof V2IngestParseStep>

const toV2Step = (step: IngestParseStep): V2IngestParseStep => {
	switch (step._tag) {
		case "json": {
			const { _tag, ...rest } = step
			return { type: _tag, ...rest }
		}
		case "regex":
		case "grok": {
			const { _tag, ...rest } = step
			return { type: _tag, ...rest }
		}
		case "severity": {
			const { _tag, ...rest } = step
			return { type: _tag, ...rest }
		}
		case "timestamp": {
			const { _tag, ...rest } = step
			return { type: _tag, ...rest }
		}
	}
}

const fromV2Step = (step: V2IngestParseStep): IngestParseStep => {
	switch (step.type) {
		case "json": {
			const { type, ...rest } = step
			return { _tag: type, ...rest }
		}
		case "regex":
		case "grok": {
			const { type, ...rest } = step
			return { _tag: type, ...rest }
		}
		case "severity": {
			const { type, ...rest } = step
			return { _tag: type, ...rest }
		}
		case "timestamp": {
			const { type, ...rest } = step
			return { _tag: type, ...rest }
		}
	}
}

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
	Schema.Struct({
		type: Schema.Literal("parse"),
		steps: Schema.Array(V2IngestParseStep).annotate({
			description:
				"Run in order on logs the conditions match, after drop and redact rules, so they read redacted text; redact rules then also cover the attributes they write. A failed step sets `maple.parse.error` and the log is kept.",
			examples: [[{ type: "json", source: "body" }]],
		}),
	}).annotate({ identifier: "IngestRuleParseAction", title: "Parse" }),
]).annotate({ identifier: "IngestRuleAction", title: "Ingest rule action" })
export type V2IngestRuleAction = Schema.Schema.Type<typeof V2IngestRuleAction>

export const toV2IngestRuleAction = (action: IngestRuleAction): V2IngestRuleAction =>
	action._tag === "drop"
		? { type: "drop", keep_percent: action.keepPercent }
		: action._tag === "parse"
			? { type: "parse", steps: Arr.map(action.steps, toV2Step) }
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
		: action.type === "parse"
			? { _tag: "parse", steps: Arr.map(action.steps, fromV2Step) }
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
		description:
			"Drop rules always run first; redact rules, then parse rules, run in ascending position.",
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
		"A rule the ingest gateway applies before telemetry is stored or billed: drop matching records, parse log bodies into attributes, or redact values. Applies to new data within 30 seconds.",
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

const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const countFields = {
	matched: Count.annotate({ description: "Records the rule's conditions matched." }),
	dropped: Count.annotate({ description: "Records the rule dropped." }),
	dropped_bytes: Count.annotate({ description: "Encoded bytes dropped; never metered or billed." }),
	redacted_values: Count.annotate({ description: "Values masked, hashed or removed." }),
}

export const V2IngestRuleStatsQuery = Schema.Struct({
	start_time: Schema.optional(
		Timestamp.annotate({ description: "Window start; defaults to 24 hours before end_time." }),
	),
	end_time: Schema.optional(Timestamp.annotate({ description: "Window end; defaults to now." })),
}).annotate({ identifier: "IngestRuleStatsQuery", title: "Ingest rule stats query" })

export const V2IngestRuleStats = Schema.Struct({
	object: Schema.Literal("ingest_rule_stats"),
	start_time: Timestamp,
	end_time: Timestamp,
	rules: Schema.Array(
		Schema.Struct({
			id: IngestRulePublicId,
			...countFields,
			signals: Schema.Array(Schema.Struct({ signal: IngestRuleSignal, ...countFields })).annotate({
				description: "The rule's totals per signal; signals without hits are left out.",
			}),
		}),
	).annotate({
		description: "Totals per rule over the window; rules without hits are left out.",
	}),
	signals: Schema.Array(Schema.Struct({ signal: IngestRuleSignal, ...countFields })).annotate({
		description: "Totals per signal: what rules kept off the bill.",
	}),
	hourly: Schema.Array(
		Schema.Struct({ id: IngestRulePublicId, bucket: Timestamp, ...countFields }),
	).annotate({
		description: "Counts per rule and UTC hour; empty for windows over 7 days.",
	}),
}).annotate({
	identifier: "IngestRuleStats",
	title: "Ingest rule stats",
	description: "What the gateway's rules matched, dropped and redacted. Counts lag by up to a minute.",
})
export type V2IngestRuleStats = Schema.Schema.Type<typeof V2IngestRuleStats>

export const V2IngestRulePreviewParams = Schema.Struct({
	signals: signalsField,
	conditions: Schema.optionalKey(conditionsField),
	action: V2IngestRuleAction,
}).annotate({
	identifier: "IngestRulePreviewParams",
	title: "Ingest rule preview parameters",
	description: "A draft rule to dry-run against stored telemetry. Nothing is saved.",
	examples: [
		wireExample({
			signals: ["logs"],
			conditions: [{ field: "severity", op: "lt", value: "info" }],
			action: { type: "drop", keep_percent: 0 },
		}),
	],
})
export type V2IngestRulePreviewParams = Schema.Schema.Type<typeof V2IngestRulePreviewParams>

export const V2IngestRulePreviewSignal = Schema.Struct({
	signal: Schema.Literals(["traces", "logs"]),
	scanned_minutes: Count.annotate({
		description:
			"Minutes scanned: 1440, or the latest stretch that fits the scan budget; then each service's match rate there is applied to its stored records for the day.",
	}),
	stored: Count.annotate({ description: "Records stored in the window." }),
	matched: Count.annotate({ description: "Stored records every condition matches." }),
	estimated_dropped: Count.annotate({
		description: "Matches a drop rule would have dropped after `keep_percent`; 0 for redact rules.",
	}),
	estimated_dropped_bytes: Count.annotate({
		description:
			"Bytes those drops would have kept off the bill, from each service's average record size.",
	}),
	services: Schema.Array(
		Schema.Struct({ service_name: Schema.String, stored: Count, matched: Count }),
	).annotate({ description: "The services with the most matches, at most 10." }),
}).annotate({ identifier: "IngestRulePreviewSignal", title: "Ingest rule preview for one signal" })
export type V2IngestRulePreviewSignal = Schema.Schema.Type<typeof V2IngestRulePreviewSignal>

export const V2IngestRulePreview = Schema.Struct({
	object: Schema.Literal("ingest_rule_preview"),
	start_time: Timestamp,
	end_time: Timestamp,
	signals: Schema.Array(V2IngestRulePreviewSignal).annotate({
		description: "One entry per previewable signal the draft covers. Metrics are not previewed.",
	}),
}).annotate({
	identifier: "IngestRulePreview",
	title: "Ingest rule preview",
	description:
		"What a draft rule would have matched in the last 24 hours of stored logs and spans. An estimate: data other rules already dropped is not stored, and regexes run on the warehouse's engine.",
})
export type V2IngestRulePreview = Schema.Schema.Type<typeof V2IngestRulePreview>

export const V2IngestRuleSuggestion = Schema.Struct({
	signal: Schema.Literals(["traces", "logs"]),
	service_name: Schema.String,
	level: Schema.NullOr(Schema.Literals(["debug", "info"])).annotate({
		description: "Logs: the rule covers this level and every level below it. `null` for traces.",
	}),
	span_name: Schema.NullOr(Schema.String).annotate({
		description: "Traces: the exact span name the rule covers. `null` for logs.",
	}),
	reason: Schema.Literals(["debug_logs", "info_logs", "health_checks"]).annotate({
		description:
			"Why: debug logs and health-check spans are dropped; a service's logs below warn are sampled when its info logs are a tenth of all log bytes.",
	}),
	keep_percent: Count.annotate({ description: "The rule's `keep_percent`: 0 drops, 10 samples." }),
	records: Count.annotate({ description: "Records stored in the last 24 hours." }),
	bytes: Count.annotate({
		description: "Their bytes; for spans, estimated from the service's average span.",
	}),
	saved_bytes: Count.annotate({ description: "Bytes the rule would have kept off the bill." }),
	share: Schema.Number.annotate({
		description: "`bytes` as a share (0 to 1) of the signal's stored bytes.",
	}),
}).annotate({ identifier: "IngestRuleSuggestion", title: "Suggested ingest rule" })
export type V2IngestRuleSuggestion = Schema.Schema.Type<typeof V2IngestRuleSuggestion>

export const V2IngestRuleSuggestions = Schema.Struct({
	object: Schema.Literal("ingest_rule_suggestions"),
	start_time: Timestamp,
	end_time: Timestamp,
	data: Schema.Array(V2IngestRuleSuggestion).annotate({
		description: "At most 6, most bytes saved first.",
	}),
}).annotate({
	identifier: "IngestRuleSuggestions",
	title: "Suggested ingest rules",
	description:
		"Rules the last 24 hours of stored logs and spans suggest: debug logs and health-check spans to drop, and a service's logs below warn to sample when its info logs dominate.",
})
export type V2IngestRuleSuggestions = Schema.Schema.Type<typeof V2IngestRuleSuggestions>

export const V2IngestRuleReorderParams = Schema.Struct({
	ids: Schema.Array(IngestRulePublicId).annotate({
		description: "Every rule's id, in the new order. Positions become 0, 1, 2 and so on.",
	}),
}).annotate({ identifier: "IngestRuleReorderParams", title: "Ingest rule reorder parameters" })

export const V2IngestRuleReorderResponse = Schema.Struct({
	object: Schema.Literal("list"),
	data: Schema.Array(V2IngestRule),
}).annotate({ identifier: "IngestRuleReorderResponse", title: "Ingest rules in their new order" })

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
		HttpApiEndpoint.get("stats", "/stats", {
			query: V2IngestRuleStatsQuery,
			success: V2IngestRuleStats,
			error: [V2ParameterInvalid.schema, rulePersistence],
		})
			.annotate(EndpointAccess, requires("telemetry:read"))
			.annotateMerge(
				OpenApi.annotations({
					identifier: "getIngestRuleStats",
					summary: "Ingest rule stats",
					description:
						"Per-rule and per-signal counts of what rules matched, dropped and redacted, at most 62 days. Requires the `ingest_rules:read` scope.",
				}),
			),
	)
	.add(
		HttpApiEndpoint.get("suggestions", "/suggestions", {
			success: V2IngestRuleSuggestions,
			error: [...V2WarehouseReadErrors],
		})
			.annotate(EndpointAccess, requires("telemetry:read"))
			.annotateMerge(
				OpenApi.annotations({
					identifier: "listIngestRuleSuggestions",
					summary: "Suggested ingest rules",
					description:
						"Rules the last 24 hours of stored logs and spans suggest, from the hourly rollups, with the bytes each would have dropped. Requires the `ingest_rules:read` scope; log suggestions also need `logs:read` and span suggestions `traces:read`.",
				}),
			),
	)
	.add(
		HttpApiEndpoint.post("preview", "/preview", {
			payload: V2IngestRulePreviewParams,
			success: V2IngestRulePreview,
			error: [ruleValidation, ...V2WarehouseReadErrors],
		})
			.annotate(EndpointAccess, requires("telemetry:read"))
			.annotateMerge(
				OpenApi.annotations({
					identifier: "previewIngestRule",
					summary: "Preview an ingest rule",
					description:
						"Counts what a draft rule's conditions match in the last 24 hours of stored logs and spans, per service, and estimates the records and bytes it would drop. Saves nothing. Requires the `ingest_rules:read` scope, plus `logs:read` and `traces:read` for the signals it counts.",
				}),
			),
	)
	.add(
		HttpApiEndpoint.post("reorder", "/reorder", {
			payload: V2IngestRuleReorderParams,
			success: V2IngestRuleReorderResponse,
			error: [ruleForbidden, ruleValidation, rulePersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "reorderIngestRules",
				summary: "Reorder ingest rules",
				description:
					"Sets every rule's position in one transaction, so the order is never half applied. Pass all of the organization's rule ids. Requires the `ingest_rules:write` scope and an admin role.",
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
					"Creates a drop, parse or redact rule. Requires the `ingest_rules:write` scope and an admin role.",
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
				"Drop, parse or redact telemetry before Maple stores or bills it. Dropped data is not metered; parsing and redaction happen before anything is written to disk.",
		}),
	)
	.annotate(EndpointAccess, handler("ingest_rules:manage")) {}
