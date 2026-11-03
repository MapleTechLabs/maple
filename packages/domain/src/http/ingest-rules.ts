import { Schema } from "effect"
import { IngestRuleId, RoleName } from "../primitives"
import { HttpTaggedError } from "./error-policy"

export class IngestRulePersistenceError extends HttpTaggedError<IngestRulePersistenceError>()(
	"@maple/http/errors/IngestRulePersistenceError",
	{ message: Schema.String },
	{
		status: 503,
		code: "ingest_rules_unavailable",
		title: "Ingest rules are temporarily unavailable",
		message: "Ingest rules are temporarily unavailable. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

export class IngestRuleNotFoundError extends HttpTaggedError<IngestRuleNotFoundError>()(
	"@maple/http/errors/IngestRuleNotFoundError",
	{ ruleId: IngestRuleId, message: Schema.String },
	{
		status: 404,
		code: "ingest_rule_not_found",
		title: "Ingest rule not found",
		message: "No such ingest rule.",
		param: "id",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {}

/** Rules drop and rewrite every org's incoming telemetry, so writes are admin-only. */
export class IngestRuleForbiddenError extends HttpTaggedError<IngestRuleForbiddenError>()(
	"@maple/http/errors/IngestRuleForbiddenError",
	{ message: Schema.String, roles: Schema.optionalKey(Schema.Array(RoleName)) },
	{
		status: 403,
		code: "ingest_rule_forbidden",
		title: "Permission required",
		message: "Only org admins can manage ingest rules.",
		retry: "never",
		recovery: "request_access",
		exposure: "redacted",
	},
) {}

export class IngestRuleValidationError extends HttpTaggedError<IngestRuleValidationError>()(
	"@maple/http/errors/IngestRuleValidationError",
	{ message: Schema.String, problems: Schema.Array(Schema.String) },
	{
		status: 400,
		code: "ingest_rule_invalid",
		title: "Invalid ingest rule",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}
