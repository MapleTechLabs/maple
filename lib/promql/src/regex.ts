import { Option } from "effect"
import { RE2JS } from "re2js"
import { lookup } from "./lookup"

/** A full match's groups: by index (0 is the whole match) and by name. */
export interface RegexMatch {
	readonly group: (ref: number | string) => string | undefined
}

/**
 * A label regex with Prometheus semantics: RE2 syntax (linear time, so a query
 * cannot stall the evaluator), anchored at both ends, `.` matching newlines.
 */
export interface LabelRegex {
	readonly test: (value: string) => boolean
	readonly exec: (value: string) => RegexMatch | undefined
}

const compile = Option.liftThrowable((pattern: string) => RE2JS.compile(`^(?s:${pattern})$`))

/** The compiled regex, or None when RE2 rejects the pattern (Prometheus rejects the query too). */
export const anchoredRegex = (pattern: string): Option.Option<LabelRegex> =>
	Option.map(compile(pattern), (re) => {
		const names = re.namedGroups()
		return {
			test: (value) => re.matcher(value).matches(),
			exec: (value) => {
				const m = re.matcher(value)
				if (!m.matches()) return undefined
				return {
					group: (ref) => {
						const index = typeof ref === "number" ? ref : lookup(names, ref)
						if (index === undefined || index > m.groupCount()) return undefined
						return m.group(index) ?? undefined
					},
				}
			},
		}
	})
