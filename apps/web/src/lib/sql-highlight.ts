const KEYWORDS = new Set([
	"SELECT",
	"FROM",
	"WHERE",
	"GROUP",
	"BY",
	"ORDER",
	"LIMIT",
	"JOIN",
	"ON",
	"AS",
	"AND",
	"OR",
	"NOT",
	"NULL",
	"CASE",
	"WHEN",
	"THEN",
	"ELSE",
	"END",
	"WITH",
	"HAVING",
	"UNION",
	"ALL",
	"DISTINCT",
	"INNER",
	"LEFT",
	"RIGHT",
	"FULL",
	"OUTER",
	"ARRAY",
	"TUPLE",
	"ASOF",
	"FINAL",
	"PREWHERE",
	"SAMPLE",
	"SETTINGS",
	"FORMAT",
	"INSERT",
	"INTO",
	"VALUES",
	"IF",
	"BETWEEN",
	"IN",
	"LIKE",
	"ILIKE",
	"IS",
	"INTERVAL",
	"DESC",
	"ASC",
	"OFFSET",
	"USING",
	"CROSS",
	"ANY",
	"SEMI",
	"ANTI",
	"TRUE",
	"FALSE",
])

const TOKEN_RE =
	/(\/\*[\s\S]*?\*\/|--[^\n]*)|('(?:''|\\.|[^'\\])*'|"(?:""|\\.|[^"\\])*")|(\$__[a-zA-Z_][a-zA-Z0-9_]*)|(\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([a-zA-Z_][a-zA-Z0-9_]*)/g

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export interface SqlHighlightToken {
	text: string
	start: number
	className?: string
}

export function tokenizeSql(code: string): SqlHighlightToken[] {
	const tokens: SqlHighlightToken[] = []
	let last = 0
	TOKEN_RE.lastIndex = 0
	let m: RegExpExecArray | null
	while ((m = TOKEN_RE.exec(code)) !== null) {
		if (m.index > last) tokens.push({ text: code.slice(last, m.index), start: last })
		const [full, comment, str, macro, num, ident] = m
		if (comment) {
			tokens.push({ text: comment, start: m.index, className: "text-muted-foreground/70 italic" })
		} else if (str) {
			tokens.push({ text: str, start: m.index, className: "text-severity-info" })
		} else if (macro) {
			tokens.push({ text: macro, start: m.index, className: "text-primary font-medium" })
		} else if (num) {
			tokens.push({ text: num, start: m.index, className: "text-amber-400" })
		} else if (ident) {
			if (KEYWORDS.has(ident.toUpperCase())) {
				tokens.push({ text: ident, start: m.index, className: "text-fuchsia-400" })
			} else if (code.charAt(m.index + ident.length) === "(") {
				tokens.push({ text: ident, start: m.index, className: "text-cyan-400" })
			} else {
				tokens.push({ text: ident, start: m.index })
			}
		} else {
			tokens.push({ text: full, start: m.index })
		}
		last = m.index + full.length
	}
	if (last < code.length) tokens.push({ text: code.slice(last), start: last })
	return tokens
}

export function highlightSql(code: string): string {
	return tokenizeSql(code)
		.map((token) => {
			const text = escapeHtml(token.text)
			return token.className ? `<span class="${token.className}">${text}</span>` : text
		})
		.join("")
}
