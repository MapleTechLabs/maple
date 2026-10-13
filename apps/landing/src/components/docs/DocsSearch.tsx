import {
	Command,
	CommandDialog,
	CommandDialogPopup,
	CommandEmpty,
	CommandFooter,
	CommandGroup,
	CommandGroupLabel,
	CommandInput,
	CommandItem,
	CommandList,
} from "@maple/ui/components/ui/command"
import { isEditableTarget } from "@maple/ui/lib/keyboard"
import { MagnifierIcon } from "@maple/ui/components/icons/magnifier"
import Fuse, { type IFuseOptions } from "fuse.js"
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
	queryTerms,
	searchRecords,
	termPattern,
	toRecords,
	type SearchDoc,
	type SearchHit,
	type SearchRecord,
} from "../../lib/docs-search"
import { groupRank } from "../../lib/docs-nav"
import { trackLanding } from "../../lib/telemetry"

const MAX_RESULTS = 10

// Typo fallback only: runs when no row contains every term, and only over
// titles and headings, so a fuzzy hit in body text can't outrank a real one.
const FUZZY_OPTIONS: IFuseOptions<SearchRecord> = {
	keys: [
		{ name: "heading", weight: 0.6 },
		{ name: "doc.title", weight: 0.4 },
	],
	ignoreLocation: true,
	threshold: 0.3,
	minMatchCharLength: 3,
}

interface SearchIndex {
	docs: SearchDoc[]
	records: SearchRecord[]
	fuzzy: Fuse<SearchRecord>
}

// Module-scoped so the index is fetched + built at most once per page session.
let indexPromise: Promise<SearchIndex> | null = null

function loadIndex() {
	if (!indexPromise) {
		indexPromise = fetch("/docs/search-index.json")
			.then((res) => res.json() as Promise<SearchDoc[]>)
			.then((docs) => {
				const records = toRecords(docs)
				return { docs, records, fuzzy: new Fuse(records, FUZZY_OPTIONS) }
			})
			.catch((err) => {
				indexPromise = null // allow retry on next open
				throw err
			})
	}
	return indexPromise
}

function groupDocs(docs: SearchDoc[]): [string, SearchDoc[]][] {
	const groups = new Map<string, SearchDoc[]>()
	for (const doc of docs) {
		const list = groups.get(doc.group)
		if (list) list.push(doc)
		else groups.set(doc.group, [doc])
	}
	return [...groups.entries()].sort((a, b) => groupRank(a[0]) - groupRank(b[0]))
}

/** Emphasize each query term where it starts a word. */
function Highlight({ text, terms }: { text: string; terms: string[] }) {
	const parts: ReactNode[] = []
	let rest = text
	let key = 0
	while (rest) {
		let best: { at: number; len: number } | null = null
		for (const term of terms) {
			const match = termPattern(term).exec(rest)
			if (!match) continue
			const at = match.index + match[1].length
			if (!best || at < best.at) best = { at, len: term.length }
		}
		if (!best) break
		parts.push(rest.slice(0, best.at))
		parts.push(
			<mark key={key++} className="bg-transparent font-semibold text-current">
				{rest.slice(best.at, best.at + best.len)}
			</mark>,
		)
		rest = rest.slice(best.at + best.len)
	}
	parts.push(rest)
	return <>{parts}</>
}

function Tag({ doc }: { doc: SearchDoc }) {
	return (
		<span className="ms-auto shrink-0 whitespace-nowrap border border-current/25 px-1.5 py-0.5 font-medium text-[9px] text-current/70 uppercase leading-none tracking-wider">
			{doc.sdk ?? doc.group}
		</span>
	)
}

// Items inherit the row's text color (the base component flips it to the dark
// accent-foreground when highlighted) and lean on opacity for hierarchy, so
// both states stay legible — fixed fg/fg-muted colors clash on the amber row.
function PageItem({ doc }: { doc: SearchDoc }) {
	return (
		<CommandItem value={doc.url} render={<a href={doc.url} />} className="flex items-center gap-3">
			<span className="flex min-w-0 flex-col">
				<span className="truncate text-sm">{doc.title}</span>
				<span className="truncate text-xs opacity-65">{doc.description}</span>
			</span>
			<Tag doc={doc} />
		</CommandItem>
	)
}

function HitItem({ hit, terms }: { hit: SearchHit; terms: string[] }) {
	const { record, snippet } = hit
	const detail = snippet || (record.section ? "" : record.doc.description)
	return (
		<CommandItem value={record.url} render={<a href={record.url} />} className="flex items-center gap-3">
			<span className="flex min-w-0 flex-col">
				{record.section && (
					<span className="truncate text-[11px] opacity-55">{record.doc.title}</span>
				)}
				<span className="truncate text-sm">
					<Highlight text={record.heading} terms={terms} />
				</span>
				{detail && (
					<span className="line-clamp-2 text-xs opacity-65">
						<Highlight text={detail} terms={terms} />
					</span>
				)}
			</span>
			<Tag doc={record.doc} />
		</CommandItem>
	)
}

export default function DocsSearch() {
	const [open, setOpen] = useState(false)
	const [query, setQuery] = useState("")
	const [docs, setDocs] = useState<SearchDoc[]>([])
	const indexRef = useRef<SearchIndex | null>(null)

	const ensureIndex = useCallback(() => {
		loadIndex()
			.then((index) => {
				indexRef.current = index
				setDocs(index.docs)
			})
			.catch(() => {
				/* keep palette usable; results just stay empty */
			})
	}, [])

	// `openRef` mirrors `open` so the mount-only key listener reads fresh state.
	const openRef = useRef(false)
	// Same reason: the close handler needs the final query, and it is created once.
	const queryRef = useRef("")
	const setPaletteOpen = useCallback(
		(next: boolean) => {
			openRef.current = next
			setOpen(next)
			if (next) {
				ensureIndex()
				return
			}
			// Emitted on close rather than per keystroke: what's worth knowing is
			// what someone searched for, not every prefix they typed on the way.
			const searched = queryRef.current.trim()
			if (searched) trackLanding("docs_search", { query: searched.slice(0, 120) })
			queryRef.current = ""
			setQuery("")
		},
		[ensureIndex],
	)

	// Mount once: prefetch the index (instant first open) + global shortcuts.
	useEffect(() => {
		ensureIndex()
		const onKeyDown = (event: KeyboardEvent) => {
			if ((event.key === "k" || event.key === "K") && (event.metaKey || event.ctrlKey)) {
				event.preventDefault()
				setPaletteOpen(!openRef.current)
			} else if (event.key === "/" && !openRef.current && !isEditableTarget(event.target)) {
				event.preventDefault()
				setPaletteOpen(true)
			} else if (event.key === "Escape" && openRef.current) {
				// The forced-open Autocomplete stopPropagation()s Escape before the Dialog
				// sees it, so close here from the capture phase.
				setPaletteOpen(false)
			}
		}
		// Capture phase so ⌘K still toggles while focus is trapped in the open dialog.
		document.addEventListener("keydown", onKeyDown, true)
		return () => document.removeEventListener("keydown", onKeyDown, true)
	}, [ensureIndex, setPaletteOpen])

	// `null` => browse mode (empty query); otherwise ranked page and section hits.
	const results = useMemo<SearchHit[] | null>(() => {
		const trimmed = query.trim()
		if (!trimmed) return null
		const index = indexRef.current
		if (!index) return []
		const exact = searchRecords(index.records, trimmed, MAX_RESULTS)
		if (exact.length > 0) return exact
		return index.fuzzy
			.search(trimmed, { limit: MAX_RESULTS })
			.map((r) => ({ record: r.item, snippet: "" }))
	}, [query, docs])

	const terms = useMemo(() => queryTerms(query), [query])
	const grouped = useMemo(() => groupDocs(docs), [docs])

	return (
		<>
			<button
				type="button"
				onClick={() => setPaletteOpen(true)}
				aria-label="Search docs"
				className="flex h-7 items-center gap-2 rounded-lg border border-border px-2 text-fg-muted text-xs transition-colors hover:border-fg-muted/40 hover:text-fg sm:w-56"
			>
				<MagnifierIcon className="size-3.5 shrink-0" />
				<span className="hidden sm:inline">Search docs</span>
				<kbd className="ml-auto hidden font-mono font-medium text-[10px] text-fg-muted/70 tracking-widest sm:inline">
					⌘K
				</kbd>
			</button>

			{/* Gate the popup on `open` so it unmounts cleanly — base-ui leaves the
			    backdrop mounted (pointer-events: auto) when the forced-open Autocomplete
			    inside holds focus through the close, which would block the page. */}
			<CommandDialog open={open} onOpenChange={setPaletteOpen}>
				{open && (
					<CommandDialogPopup>
						<Command
							inline={false}
							filter={null}
							value={query}
							onValueChange={(value: string) => {
								queryRef.current = value
								setQuery(value)
							}}
						>
							<CommandInput placeholder="Search the docs…" />
							<CommandList>
								{results === null ? (
									grouped.map(([group, items]) => (
										<CommandGroup key={group}>
											<CommandGroupLabel>{group}</CommandGroupLabel>
											{items.map((doc) => (
												<PageItem key={doc.id} doc={doc} />
											))}
										</CommandGroup>
									))
								) : results.length === 0 ? (
									<CommandEmpty>No results for “{query}”.</CommandEmpty>
								) : (
									results.map((hit) => (
										<HitItem key={hit.record.url} hit={hit} terms={terms} />
									))
								)}
							</CommandList>
							<CommandFooter>
								<span className="flex items-center gap-1.5">
									<kbd className="font-medium text-fg-muted/70">↵</kbd> to open
								</span>
								<span className="flex items-center gap-1.5">
									<kbd className="font-medium text-fg-muted/70">esc</kbd> to close
								</span>
							</CommandFooter>
						</Command>
					</CommandDialogPopup>
				)}
			</CommandDialog>
		</>
	)
}
