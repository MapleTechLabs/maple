// `@maple/ui/lib/colors` (framework-free otherwise) types one helper with the global
// `React.CSSProperties`. Phase 1's styles extraction removes it; until then this stub types it here.
declare namespace React {
	type CSSProperties = Readonly<Record<string, string | number | undefined>>
}
