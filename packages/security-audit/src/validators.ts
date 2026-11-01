/**
 * The upstream validators, called unchanged. They are the contract: a ledger or findings document
 * is valid exactly when Cloudflare's own checker says so, and a skill bump that tightens the
 * contract tightens ours with it.
 */
import { Effect, Schema } from "effect"
import * as LedgerValidator from "../skill/validate-coverage-ledger.cjs"
import * as FindingsValidator from "../skill/validate-findings.cjs"
import reportSchema from "../skill/report-schema.json" with { type: "json" }
import { type CanonicalRefs, type CoverageUnit, type Finding, Findings, Ledger } from "./schema"

export class SecurityAuditContractError extends Schema.TaggedError<SecurityAuditContractError>()(
	"@maple/security-audit/ContractError",
	{
		message: Schema.String,
		document: Schema.Literals(["ledger", "findings"]),
		errors: Schema.Array(Schema.String),
	},
) {}

const failWith = (document: "ledger" | "findings", errors: ReadonlyArray<string>) =>
	new SecurityAuditContractError({
		message: `${document} failed the skill's validator: ${errors.slice(0, 3).join("; ")}`,
		document,
		errors: [...errors],
	})

/**
 * The document as the file-based validator would read it. Values built in memory can share object
 * references, which the upstream validator rejects as cycles; a written-out document never does.
 */
type Json = string | number | boolean | null | ReadonlyArray<Json> | { readonly [key: string]: Json }
const asWritten = (value: unknown): Json => JSON.parse(JSON.stringify(value))

/** The skill's own `coverage_id`: RFC 3986-encoded canonical references joined with `::`. */
export const coverageId = (refs: CanonicalRefs): string => LedgerValidator.canonicalCoverageId(refs)

/**
 * The `coverage_id`, or undefined when a reference breaks the skill's canonical-reference rules
 * (surrounding whitespace, control characters, non-NFC text): the upstream helper throws on those.
 */
export const safeCoverageId = (refs: CanonicalRefs): string | undefined => {
	const result = Effect.runSync(
		Effect.result(
			Effect.try({ try: () => LedgerValidator.canonicalCoverageId(refs), catch: () => undefined }),
		),
	)
	return result._tag === "Success" ? result.success : undefined
}

export const isSafeAgentId = (value: string): boolean => LedgerValidator.isSafeAgentId(value)

export const isSafeRelativePath = (value: string): boolean => LedgerValidator.isSafeRelativePath(value)

/** Errors the upstream ledger validator reports; empty means valid. */
export const ledgerErrors = (ledger: ReadonlyArray<CoverageUnit>): ReadonlyArray<string> =>
	LedgerValidator.validateDocument(asWritten(ledger))

/** Errors the upstream findings validator reports against `report-schema.json`; empty means valid. */
export const findingsErrors = (findings: ReadonlyArray<Finding>): ReadonlyArray<string> =>
	FindingsValidator.validateDocument(asWritten(findings), reportSchema)

export const validateLedger = (ledger: unknown) =>
	Effect.gen(function* () {
		const errors = LedgerValidator.validateDocument(asWritten(ledger))
		if (errors.length > 0) return yield* failWith("ledger", errors)
		return yield* Schema.decodeUnknownEffect(Ledger)(ledger).pipe(
			Effect.mapError((cause) => failWith("ledger", [cause.message])),
		)
	})

export const validateFindings = (findings: unknown) =>
	Effect.gen(function* () {
		const errors = FindingsValidator.validateDocument(asWritten(findings), reportSchema)
		if (errors.length > 0) return yield* failWith("findings", errors)
		return yield* Schema.decodeUnknownEffect(Findings)(findings).pipe(
			Effect.mapError((cause) => failWith("findings", [cause.message])),
		)
	})
