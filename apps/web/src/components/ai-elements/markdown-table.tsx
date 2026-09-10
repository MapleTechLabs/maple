import { Children, createContext, isValidElement, use, useRef, type ReactNode } from "react"

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { LATENCY_TEXT_TONE, latencyLevel } from "@maple/ui/lib/latency-tone"
import { SEVERITY_COLORS } from "@maple/ui/lib/severity"
import { cn } from "@maple/ui/lib/utils"
import { ServiceRef, TraceRef } from "./entity-ref"
import { useKnownServices } from "./known-services"
import { classifyCell, columnRole, type CellValue } from "./table-cell-value"

/**
 * The table Streamdown renders for a markdown table in an assistant reply.
 *
 * Two things live here. The first is styling: rather than overriding a vendor's
 * classes from the outside — which drifts every time it changes one — the table
 * is built from the same `Table` primitives as every other table in Maple, so a
 * table in a reply and a table in the product agree by construction.
 *
 * The second is why owning the cells is worth it at all. A cell knows its own
 * text and its column's header, which is enough to turn a trace id into a link
 * and a duration into a toned value without the model spending a token on
 * either. See `table-cell-value.ts` for what counts as recognized.
 */

/** Column headers by index, filled by the header row before any body row reads it. */
const HeadersContext = createContext<string[]>([])

/** Column index, handed to each cell by its row. */
const ColumnContext = createContext(0)

interface MarkdownNodeProps {
	readonly children?: ReactNode
	readonly className?: string
	/** react-markdown's hast node. Never forwarded to the DOM. */
	readonly node?: unknown
}

/**
 * The cell's text, or null when the cell holds something other than text and
 * inline code — a link the model wrote itself, an image, a card. Those are left
 * exactly as authored rather than reinterpreted.
 */
function cellText(children: ReactNode): string | null {
	if (children === null || children === undefined || typeof children === "boolean") return ""
	if (typeof children === "string") return children
	if (typeof children === "number") return String(children)
	if (Array.isArray(children)) {
		let text = ""
		for (const child of children) {
			const part = cellText(child)
			if (part === null) return null
			text += part
		}
		return text
	}
	if (isValidElement<{ children?: ReactNode; href?: string; src?: string }>(children)) {
		// An element with its own destination is content the model authored — a link,
		// an image. Reading its label would let a recognized value replace it.
		if (children.props.href !== undefined || children.props.src !== undefined) return null
		return cellText(children.props.children)
	}
	return null
}

export function MarkdownTable({ children, className, node: _node, ...props }: MarkdownNodeProps) {
	// A ref, not state: the header row writes into it while rendering and the body
	// rows read it in the same pass, so nothing here should schedule a re-render.
	const headers = useRef<string[]>([])
	return (
		<HeadersContext value={headers.current}>
			{/* The frame lives on a wrapper because `Table` gives its own scroll
			    container no class hook, and the radius has to clip the header fill. */}
			<div className="my-3 overflow-hidden rounded-lg border border-border bg-card">
				<Table className={cn("text-xs", className)} {...props}>
					{children}
				</Table>
			</div>
		</HeadersContext>
	)
}

export function MarkdownTableHeader({ children, node: _node, ...props }: MarkdownNodeProps) {
	return (
		<TableHeader className="bg-muted/40" {...props}>
			{children}
		</TableHeader>
	)
}

export function MarkdownTableBody({ children, node: _node, ...props }: MarkdownNodeProps) {
	return <TableBody {...props}>{children}</TableBody>
}

/**
 * Hands each cell its column index. react-markdown puts whitespace text nodes
 * between cells, so the counter advances on elements only.
 */
export function MarkdownTableRow({ children, node: _node, ...props }: MarkdownNodeProps) {
	let column = 0
	const cells = Children.map(children, (child) => {
		if (!isValidElement(child)) return child
		const index = column++
		return (
			<ColumnContext key={index} value={index}>
				{child}
			</ColumnContext>
		)
	})
	return <TableRow {...props}>{cells}</TableRow>
}

export function MarkdownTableHead({ children, className, node: _node, ...props }: MarkdownNodeProps) {
	const headers = use(HeadersContext)
	const column = use(ColumnContext)
	const text = cellText(children)
	headers[column] = text ?? ""
	return (
		<TableHead className={cn("h-8 px-3 text-xs", className)} {...props}>
			{children}
		</TableHead>
	)
}

export function MarkdownTableCell({ children, className, node: _node, ...props }: MarkdownNodeProps) {
	const headers = use(HeadersContext)
	const column = use(ColumnContext)
	const knownServices = useKnownServices()
	const header = headers[column] ?? ""
	const text = cellText(children)
	const value =
		text === null
			? { kind: "plain" as const }
			: classifyCell(text, { role: columnRole(header), header, knownServices })

	return (
		<TableCell
			// A cell is already a container, so inline code inside one drops its chip:
			// a column of ids was a stack of grey pills, each taller than its row.
			className={cn(
				"px-3 py-2 text-xs text-foreground tabular-nums",
				"[&_code]:bg-transparent [&_code]:p-0 [&_code]:text-xs",
				className,
			)}
			{...props}
		>
			{value.kind === "plain" ? children : <CellValueView value={value} />}
		</TableCell>
	)
}

function CellValueView({ value }: { value: Exclude<CellValue, { kind: "plain" }> }) {
	switch (value.kind) {
		case "trace":
			return <TraceRef traceId={value.traceId} />
		case "service":
			return <ServiceRef name={value.name} />
		case "duration":
			return (
				<span className={cn("font-mono", LATENCY_TEXT_TONE[latencyLevel(value.ms, value.scale)])}>
					{value.value}
					{value.note ? <span className="ml-1 text-muted-foreground">{value.note}</span> : null}
				</span>
			)
		case "severity":
			return <span style={{ color: SEVERITY_COLORS[value.label] }}>{value.label}</span>
		case "flag":
			return (
				<span className={value.severe ? "text-severity-error" : "text-muted-foreground"}>
					{value.text}
				</span>
			)
		case "status": {
			const tone =
				value.code >= 500
					? "text-severity-error"
					: value.code >= 400
						? "text-severity-warn"
						: "text-muted-foreground"
			return <span className={cn("font-mono", tone)}>{value.text}</span>
		}
	}
}
