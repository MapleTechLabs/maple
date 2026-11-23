// The curated grok library parse rules expand `%{NAME:field}` from. The gateway
// (`apps/ingest/src/ingest_rules/parse.rs`) carries the same table; both are checked against
// `packages/ingest-rules/fixtures/grok-patterns.json`. Every definition is ASCII-only and avoids
// `\d`, `\w` and `\s`, so it means the same in both regex engines.

import { Option, Record as Rec, String as Str } from "effect"

export const GROK_PATTERNS = {
	USERNAME: "[a-zA-Z0-9._-]+",
	USER: "%{USERNAME}",
	INT: "[+-]?[0-9]+",
	BASE10NUM: "[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)",
	NUMBER: "%{BASE10NUM}",
	BASE16NUM: "[+-]?(?:0x)?[0-9A-Fa-f]+",
	POSINT: "[1-9][0-9]*",
	NONNEGINT: "[0-9]+",
	WORD: "[A-Za-z0-9_]+",
	NOTSPACE: "[^ \\t\\r\\n]+",
	SPACE: "[ \\t\\r\\n]*",
	DATA: ".*?",
	GREEDYDATA: ".*",
	QUOTEDSTRING: "\"(?:[^\"\\\\]|\\\\.)*\"|'(?:[^'\\\\]|\\\\.)*'",
	QS: "%{QUOTEDSTRING}",
	UUID: "[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}",
	MAC: "(?:[A-Fa-f0-9]{2}[:-]){5}[A-Fa-f0-9]{2}",
	IPV4: "(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])",
	IPV6: "(?:[A-Fa-f0-9]{0,4}:){2,7}(?:%{IPV4}|[A-Fa-f0-9]{0,4})",
	IP: "%{IPV6}|%{IPV4}",
	HOSTNAME: "[A-Za-z0-9][A-Za-z0-9-]{0,62}(?:\\.[A-Za-z0-9][A-Za-z0-9-]{0,62})*\\.?",
	IPORHOST: "%{IP}|%{HOSTNAME}",
	HOSTPORT: "%{IPORHOST}:%{POSINT}",
	EMAILADDRESS: "[a-zA-Z0-9._%+-]+@%{HOSTNAME}",
	URIPROTO: "[A-Za-z][A-Za-z0-9+.-]*",
	URIHOST: "%{IPORHOST}(?::%{POSINT})?",
	URIPATH: "(?:/[A-Za-z0-9$.+!*'(){},~:;=@#%&_-]*)+",
	URIPARAM: "\\?[A-Za-z0-9$.+!*'|(){},~@#%&/=:;_?<>-]*",
	URIPATHPARAM: "%{URIPATH}(?:%{URIPARAM})?",
	URI: "%{URIPROTO}://(?:%{USER}(?::[^@]*)?@)?(?:%{URIHOST})?(?:%{URIPATHPARAM})?",
	PATH: "(?:/[^ \\t\\r\\n/]*)+",
	MONTH: "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?",
	MONTHNUM: "0?[1-9]|1[0-2]",
	MONTHDAY: "0[1-9]|[12][0-9]|3[01]|[1-9]",
	DAY: "Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?",
	YEAR: "[0-9]{4}",
	HOUR: "2[0-3]|[01]?[0-9]",
	MINUTE: "[0-5][0-9]",
	SECOND: "(?:[0-5]?[0-9]|60)(?:[.,][0-9]+)?",
	TIME: "%{HOUR}:%{MINUTE}(?::%{SECOND})?",
	ISO8601_TIMEZONE: "Z|[+-]%{HOUR}(?::?%{MINUTE})?",
	TIMESTAMP_ISO8601:
		"%{YEAR}-%{MONTHNUM}-%{MONTHDAY}[T ]%{HOUR}:?%{MINUTE}(?::?%{SECOND})?(?:%{ISO8601_TIMEZONE})?",
	HTTPDATE: "%{MONTHDAY}/%{MONTH}/%{YEAR}:%{TIME} %{INT}",
	SYSLOGTIMESTAMP: "%{MONTH} +%{MONTHDAY} %{TIME}",
	LOGLEVEL:
		"[Tt]race|TRACE|[Dd]ebug|DEBUG|[Ii]nfo|INFO|[Nn]otice|NOTICE|[Ww]arn(?:ing)?|WARN(?:ING)?|[Ee]rr(?:or)?|ERR(?:OR)?|[Cc]rit(?:ical)?|CRIT(?:ICAL)?|[Ff]atal|FATAL|[Ss]evere|SEVERE|[Ee]merg(?:ency)?|EMERG(?:ENCY)?|[Aa]lert|ALERT",
	COMMONAPACHELOG:
		'%{IPORHOST:client.address} %{USER:ident} %{USER:auth} \\[%{HTTPDATE:timestamp}\\] "(?:%{WORD:http.request.method} %{NOTSPACE:url.original}(?: HTTP/%{NUMBER:network.protocol.version})?|%{DATA:raw_request})" %{INT:http.response.status_code:int} (?:%{INT:http.response.body.size:int}|-)',
	COMBINEDAPACHELOG: "%{COMMONAPACHELOG} %{QS:http.request.referrer} %{QS:user_agent.original}",
} as const satisfies Record<string, string>

const LIBRARY: ReadonlyMap<string, string> = new Map(Rec.toEntries(GROK_PATTERNS))

export type GrokFieldType = "string" | "int" | "float"

export interface GrokField {
	readonly name: string
	readonly type: GrokFieldType
}

/** A grok pattern as a regex: capture group `g<i>` fills `fields[i]`. */
export interface ExpandedGrok {
	readonly regex: string
	readonly fields: ReadonlyArray<GrokField>
}

const PATTERN_NAME = /^[A-Z0-9_]+$/u
const FIELD_NAME = /^[A-Za-z_@][A-Za-z0-9_.@-]*$/u
/** Library patterns reference each other at most this deep. */
const MAX_DEPTH = 8

/**
 * Expands `%{NAME}`, `%{NAME:field}` and `%{NAME:field:int|float}` into a regex. The gateway runs
 * the same algorithm, so the group numbering matches. Returns a problem string when it cannot.
 */
export const expandGrok = (pattern: string): ExpandedGrok | string => {
	const fields: Array<GrokField> = []
	const expand = (text: string, depth: number): string | { readonly problem: string } => {
		let out = ""
		let at = 0
		while (at < text.length) {
			const rest = Str.slice(at)(text)
			if (Str.startsWith("%{")(rest)) {
				const close = Str.indexOf("}")(rest)
				if (Option.isNone(close)) return { problem: "a %{ is not closed" }
				const inner = Str.slice(2, close.value)(rest)
				const [name, field, type, ...extra] = Str.split(":")(inner)
				if (extra.length > 0) return { problem: `%{${inner}} has too many parts` }
				const definition = PATTERN_NAME.test(name) ? LIBRARY.get(name) : undefined
				if (definition === undefined) return { problem: `unknown grok pattern ${name}` }
				if (depth >= MAX_DEPTH) return { problem: "grok patterns nest too deeply" }
				if (field !== undefined && !FIELD_NAME.test(field))
					return {
						problem: `field name ${field} must start with a letter and use letters, digits, _, ., @ or -`,
					}
				if (type !== undefined && type !== "int" && type !== "float")
					return { problem: `field type ${type} must be int or float` }
				if (field === undefined) out += "(?:"
				else {
					out += `(?<g${fields.length}>`
					fields.push({ name: field, type: type ?? "string" })
				}
				const expanded = expand(definition, depth + 1)
				if (typeof expanded !== "string") return expanded
				out += `${expanded})`
				at += close.value + 1
			} else {
				// An escape is copied with the character it escapes, so `\%{` stays literal.
				const width = Str.startsWith("\\")(rest) && rest.length > 1 ? 2 : 1
				out += Str.slice(0, width)(rest)
				at += width
			}
		}
		return out
	}
	const regex = expand(pattern, 0)
	return typeof regex === "string" ? { regex, fields } : regex.problem
}
