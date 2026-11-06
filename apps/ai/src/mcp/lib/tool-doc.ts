/**
 * The one shape a tool's model-facing text takes.
 *
 * A tool renders its typed output into a {@link ToolDoc}; {@link renderToolDoc} turns that into
 * markdown. Every result therefore reads the same way: a title, one line of what was asked, the
 * body, then how much was left out, and typed calls to make next. Next calls are data, so the
 * registry checks each one against its target tool's schema before it reaches a model.
 */
import { fencedBlock, formatTable, tableCell } from "./format"
import { stringifyJson } from "./json"
import { Array as Arr, Record as Rec, String as Str } from "effect"

export type ToolArgValue = string | number | boolean | ReadonlyArray<string>

/** A call the model can make next, with arguments valid for `tool`'s input schema. */
export interface NextCall {
	readonly tool: string
	readonly args: Readonly<Record<string, ToolArgValue>>
	/** What the call is for, in a few words. */
	readonly why: string
}

export type DocBlock =
	| { readonly _tag: "text"; readonly text: string }
	| { readonly _tag: "heading"; readonly text: string }
	| {
			readonly _tag: "table"
			readonly headers: ReadonlyArray<string>
			readonly rows: ReadonlyArray<ReadonlyArray<string>>
	  }
	| { readonly _tag: "fields"; readonly entries: ReadonlyArray<readonly [string, string]> }
	| { readonly _tag: "list"; readonly items: ReadonlyArray<string> }
	| { readonly _tag: "code"; readonly language: string; readonly text: string }

export interface ToolDoc {
	/** Rendered as the `##` heading. */
	readonly title: string
	/** Where the call was not run as sent (ignored keys). First under the title, so it is not missed. */
	readonly warnings?: ReadonlyArray<string>
	/** What the result covers: the resolved window and the filters that applied. One line. */
	readonly scope?: ReadonlyArray<readonly [string, string | undefined]>
	readonly blocks: ReadonlyArray<DocBlock>
	/** Set when nothing matched: what was looked for, and how to widen it. */
	readonly empty?: { readonly message: string; readonly hints?: ReadonlyArray<string> }
	/** Set when the body shows part of the result. `next` fetches the rest. */
	readonly truncation?: {
		readonly shown: number
		readonly total?: number
		readonly noun: string
		readonly next?: NextCall
	}
	/** Things the model should know about how its call was read (clamped windows, inferred values). */
	readonly notices?: ReadonlyArray<string>
	readonly next?: ReadonlyArray<NextCall>
}

export const doc = {
	text: (text: string): DocBlock => ({ _tag: "text", text }),
	heading: (text: string): DocBlock => ({ _tag: "heading", text }),
	table: (headers: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>): DocBlock => ({
		_tag: "table",
		headers,
		rows,
	}),
	fields: (entries: ReadonlyArray<readonly [string, string | number | undefined]>): DocBlock => ({
		_tag: "fields",
		entries: Arr.flatMap(entries, ([label, value]) =>
			value === undefined ? [] : [[label, String(value)] as const],
		),
	}),
	list: (items: ReadonlyArray<string>): DocBlock => ({ _tag: "list", items }),
	code: (language: string, text: string): DocBlock => ({ _tag: "code", language, text }),
	next: (
		tool: string,
		args: Readonly<Record<string, ToolArgValue | undefined>>,
		why: string,
	): NextCall => ({
		tool,
		args: Rec.fromEntries(
			Arr.filter(
				Rec.toEntries(args),
				(entry): entry is [string, ToolArgValue] => entry[1] !== undefined,
			),
		),
		why,
	}),
}

const formatArg = (value: ToolArgValue): string =>
	typeof value === "string" || Arr.isArray(value) ? (stringifyJson(value) ?? String(value)) : String(value)

export const formatNextCall = (call: NextCall): string => {
	const args = Arr.map(Rec.toEntries(call.args), ([key, value]) => `${key}=${formatArg(value)}`)
	return `\`${Arr.join([call.tool, ...args], " ")}\`: ${call.why}`
}

const renderBlock = (block: DocBlock): string => {
	switch (block._tag) {
		case "text":
			return block.text
		case "heading":
			return `### ${block.text}`
		case "table":
			// Cells are escaped here, once: pass raw text, clipped with `truncate` if needed.
			return formatTable(
				Arr.map(block.headers, (header) => tableCell(header)),
				Arr.map(block.rows, (row) => Arr.map(row, (cell) => tableCell(cell))),
			)
		case "fields":
			return Arr.join(
				Arr.map(block.entries, ([label, value]) => `${label}: ${value}`),
				"\n",
			)
		case "list":
			return Arr.join(
				Arr.map(block.items, (item) => `- ${item}`),
				"\n",
			)
		case "code":
			return Str.replace(/^(`+)\n/, `$1${block.language}\n`)(fencedBlock(block.text))
	}
}

const renderScope = (scope: NonNullable<ToolDoc["scope"]>): string | undefined => {
	const parts = Arr.flatMap(scope, ([label, value]) =>
		value === undefined || value === "" ? [] : [`${label}: ${value}`],
	)
	return parts.length === 0 ? undefined : Arr.join(parts, " · ")
}

/** Markdown, in a fixed order, with blank lines between sections. */
export const renderToolDoc = (tool: ToolDoc): string => {
	const sections: Array<string> = [`## ${tool.title}`]
	if (tool.warnings !== undefined && tool.warnings.length > 0) {
		sections.push(
			Arr.join(
				Arr.map(tool.warnings, (warning) => `Warning: ${warning}`),
				"\n",
			),
		)
	}
	const scope = tool.scope === undefined ? undefined : renderScope(tool.scope)
	if (scope !== undefined) sections.push(scope)
	if (tool.notices !== undefined && tool.notices.length > 0) {
		sections.push(
			Arr.join(
				Arr.map(tool.notices, (notice) => `Note: ${notice}`),
				"\n",
			),
		)
	}
	if (tool.empty !== undefined) {
		sections.push(tool.empty.message)
		if (tool.empty.hints !== undefined && tool.empty.hints.length > 0) {
			sections.push(
				Arr.join(
					Arr.map(tool.empty.hints, (hint) => `- ${hint}`),
					"\n",
				),
			)
		}
	}
	for (const block of tool.blocks) sections.push(renderBlock(block))
	if (tool.truncation !== undefined) {
		const { shown, total, noun, next } = tool.truncation
		const of = total === undefined ? "" : ` of ${total}`
		const more = next === undefined ? "" : ` Next page: ${formatNextCall(next)}`
		sections.push(`Showing ${shown}${of} ${noun}.${more}`)
	}
	if (tool.next !== undefined && tool.next.length > 0) {
		sections.push(
			`Next:\n${Arr.join(
				Arr.map(tool.next, (call) => `- ${formatNextCall(call)}`),
				"\n",
			)}`,
		)
	}
	return Arr.join(sections, "\n\n")
}

/** Every {@link NextCall} a doc carries, for validation against the target tools. */
export const nextCallsOf = (tool: ToolDoc): ReadonlyArray<NextCall> => [
	...(tool.truncation?.next === undefined ? [] : [tool.truncation.next]),
	...(tool.next ?? []),
]

/** The doc with the calls `keep` rejects removed. */
export const filterNextCalls = (tool: ToolDoc, keep: (call: NextCall) => boolean): ToolDoc => {
	const next = tool.next === undefined ? undefined : Arr.filter(tool.next, keep)
	const truncationNext = tool.truncation?.next
	return {
		...tool,
		...(next === undefined ? undefined : { next }),
		...(tool.truncation === undefined
			? undefined
			: {
					truncation:
						truncationNext === undefined || keep(truncationNext)
							? tool.truncation
							: {
									shown: tool.truncation.shown,
									noun: tool.truncation.noun,
									...(tool.truncation.total === undefined
										? undefined
										: { total: tool.truncation.total }),
								},
				}),
	}
}
