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
import { cn } from "@maple/ui/lib/utils"
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
	type SearchIndexPayload,
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

interface SearchIndex extends SearchIndexPayload {
	records: SearchRecord[]
	fuzzy: Fuse<SearchRecord>
}

// Module-scoped so the index is fetched + built at most once per page session.
let indexPromise: Promise<SearchIndex> | null = null

function loadIndex() {
	if (!indexPromise) {
		indexPromise = fetch("/docs/search-index.json")
			.then((res) => res.json() as Promise<SearchIndexPayload>)
			.then(({ docs, icons }) => {
				const records = toRecords(docs)
				return { docs, icons, records, fuzzy: new Fuse(records, FUZZY_OPTIONS) }
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

// Build-time SVG from our own icon components (see search-index.json.ts).
// Category glyphs paint in currentColor, so they follow the highlighted row.
function Icon({ svg, className }: { svg: string | undefined; className?: string }) {
	if (!svg) return null
	return (
		<span
			aria-hidden="true"
			className={cn("flex shrink-0", className)}
			dangerouslySetInnerHTML={{ __html: svg }}
		/>
	)
}

function Tag({ doc }: { doc: SearchDoc }) {
	return (
		<span className="ms-auto shrink-0 whitespace-nowrap border border-current/25 px-1.5 py-0.5 font-medium text-[9px] text-current/70 uppercase leading-none tracking-wider">
			{doc.sdk ?? doc.group}
		</span>
	)
}

type Icons = SearchIndexPayload["icons"]

// The highlighted row mirrors the sidebar's active link: a primary tint and a
// primary left bar. Text keeps the foreground color and leans on opacity for hierarchy.
const ITEM_CLASS =
	"flex items-center gap-3 rounded-none data-highlighted:bg-primary/10 data-highlighted:text-fg data-highlighted:shadow-[inset_2px_0_0_var(--primary)]"

function PageItem({ doc, icons }: { doc: SearchDoc; icons: Icons }) {
	return (
		<CommandItem value={doc.url} render={<a href={doc.url} />} className={ITEM_CLASS}>
			<Icon svg={doc.icon && icons[doc.icon]} className="opacity-80" />
			<span className="flex min-w-0 flex-col">
				<span className="truncate text-sm">{doc.title}</span>
				<span className="truncate text-xs opacity-65">{doc.description}</span>
			</span>
			<Tag doc={doc} />
		</CommandItem>
	)
}

function HitItem({ hit, terms, icons }: { hit: SearchHit; terms: string[]; icons: Icons }) {
	const { record, snippet } = hit
	const detail = snippet || (record.section ? "" : record.doc.description)
	return (
		<CommandItem value={record.url} render={<a href={record.url} />} className={ITEM_CLASS}>
			<Icon svg={record.doc.icon && icons[record.doc.icon]} className="opacity-80" />
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
	const [icons, setIcons] = useState<Icons>({})
	const indexRef = useRef<SearchIndex | null>(null)

	const ensureIndex = useCallback(() => {
		loadIndex()
			.then((index) => {
				indexRef.current = index
				setDocs(index.docs)
				setIcons(index.icons)
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
											<CommandGroupLabel className="flex items-center gap-1.5">
												<Icon
													svg={icons[`group:${group}`]}
													className="text-primary/80 [&_svg]:size-3"
												/>
												{group}
											</CommandGroupLabel>
											{items.map((doc) => (
												<PageItem key={doc.id} doc={doc} icons={icons} />
											))}
										</CommandGroup>
									))
								) : results.length === 0 ? (
									<CommandEmpty>No results for “{query}”.</CommandEmpty>
								) : (
									results.map((hit) => (
										<HitItem key={hit.record.url} hit={hit} terms={terms} icons={icons} />
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
