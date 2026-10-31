// SQL for the Security Center's telemetry views: which Server spans are scanner probes, and the
// runtime a span's service reports. Compiled from the catalog in `../security-telemetry.ts` so the
// write filter and the read-side labels share one list.

import type { Expr } from "@maple-dev/effect-orm/expr"
import * as CH from "@maple-dev/effect-orm/expr"
import { compile } from "@maple-dev/effect-orm/sql"
import { PROBE_SIGNATURES, SCANNER_AGENTS } from "../security-telemetry"
import { requestPathExpr, userAgentExpr } from "./ai-crawler-columns"

interface MapColumnLike {
	get(key: string): Expr<string>
}

const mapColumn = (name: string): MapColumnLike => ({
	get: (key) => CH.mapGet(CH.dynamicColumn<Record<string, string>>(name), key),
})

const spanAttributes = mapColumn("SpanAttributes")
const resourceAttributes = mapColumn("ResourceAttributes")

const stringArray = (values: ReadonlyArray<string>) => CH.arrayOf(...values.map((value) => CH.lit(value)))

const firstNonEmpty = (...values: ReadonlyArray<Expr<string>>): Expr<string> =>
	CH.coalesce(...values.map((value) => CH.nullIf(value, "")), CH.lit(""))

const leftUtf8 = (value: Expr<string>, max: number) => CH.compileFnCall<string>("leftUTF8", value, max)

const SIGNATURE_TOKENS = PROBE_SIGNATURES.map((signature) => signature.token)

/** 1-based index into {@link PROBE_SIGNATURES} of the token found in the path, 0 for none. */
export function probeIndexExpr(attrs: MapColumnLike): Expr<number> {
	return CH.compileFnCall<number>(
		"multiSearchFirstIndexCaseInsensitive",
		requestPathExpr(attrs),
		stringArray(SIGNATURE_TOKENS),
	)
}

/** The matched token, `''` when the path matches none. */
export function probeSignatureExpr(attrs: MapColumnLike): Expr<string> {
	return CH.arrayElement(stringArray(SIGNATURE_TOKENS), probeIndexExpr(attrs))
}

/** 1-based index into {@link SCANNER_AGENTS} of the tool named in the user agent, 0 for none. */
export function scannerIndexExpr(attrs: MapColumnLike): Expr<number> {
	return CH.compileFnCall<number>(
		"multiSearchFirstIndexCaseInsensitive",
		userAgentExpr(attrs),
		stringArray(SCANNER_AGENTS.map((agent) => agent.token)),
	)
}

/** The scanning tool's name, `''` when the user agent names none. */
export function scannerNameExpr(attrs: MapColumnLike): Expr<string> {
	return CH.arrayElement(stringArray(SCANNER_AGENTS.map((agent) => agent.name)), scannerIndexExpr(attrs))
}

/** Bounds for the free-form columns the views keep. */
export const CLIENT_ADDRESS_MAX = 64
export const USER_AGENT_MAX = 256
export const RUNTIME_FIELD_MAX = 64

/** The caller's address: `client.address`, then the legacy spellings. */
export function clientAddressExpr(attrs: MapColumnLike): Expr<string> {
	return leftUtf8(
		firstNonEmpty(attrs.get("client.address"), attrs.get("http.client_ip"), attrs.get("net.peer.ip")),
		CLIENT_ADDRESS_MAX,
	)
}

const sql = (expr: Expr<unknown>) => compile(expr.toFragment())

const resourceField = (key: string) => sql(leftUtf8(resourceAttributes.get(key), RUNTIME_FIELD_MAX))

export const PROBE_INDEX_SQL = sql(probeIndexExpr(spanAttributes))
export const PROBE_SIGNATURE_SQL = sql(probeSignatureExpr(spanAttributes))
export const SCANNER_INDEX_SQL = sql(scannerIndexExpr(spanAttributes))
export const SCANNER_NAME_SQL = sql(scannerNameExpr(spanAttributes))
export const CLIENT_ADDRESS_SQL = sql(clientAddressExpr(spanAttributes))
export const SCANNER_USER_AGENT_SQL = sql(leftUtf8(userAgentExpr(spanAttributes), USER_AGENT_MAX))

export const RUNTIME_NAME_SQL = resourceField("process.runtime.name")
export const RUNTIME_VERSION_SQL = resourceField("process.runtime.version")
export const SDK_LANGUAGE_SQL = resourceField("telemetry.sdk.language")
export const SDK_NAME_SQL = resourceField("telemetry.sdk.name")
export const SDK_VERSION_SQL = resourceField("telemetry.sdk.version")
