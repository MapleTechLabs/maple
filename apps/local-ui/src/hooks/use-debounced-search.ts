import { useRef, useState } from "react"

/**
 * Local search input state that commits to a (URL-backed) sink on a debounce.
 * Keeps keystrokes snappy and avoids a history entry per character. Initialized
 * once from `initial`, so navigating away and back rehydrates from the URL.
 */
export function useDebouncedSearch(
	initial: string,
	onCommit: (value: string) => void,
	delay = 250,
): readonly [string, (next: string) => void] {
	const [value, setValue] = useState(initial)
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

	const change = (next: string) => {
		setValue(next)
		if (timer.current) clearTimeout(timer.current)
		timer.current = setTimeout(() => onCommit(next), delay)
	}

	return [value, change] as const
}
