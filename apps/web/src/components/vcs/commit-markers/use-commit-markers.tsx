import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react"

import { Result, useAtomValue } from "@/lib/effect-atom"

import { commitQueryAtom, isResolvableSha } from "../commit-sha-hover-card"
import { CommitMarkersLayer } from "./commit-markers-layer"
import { buildCommitMarkers, type ReleasePoint } from "./marker-layout"

const EMPTY_LABELS: ReadonlyMap<string, string> = new Map()

function firstLine(message: string): string {
	const idx = message.indexOf("\n")
	return (idx === -1 ? message : message.slice(0, idx)).trim()
}

/**
 * Derives commit deploy markers from the release timeline and returns the chart
 * `overlay` element plus the `resolvers` to render. A marker's label defaults to
 * its representative commit's full SHA; here we resolve that commit (in the
 * background) and, when it succeeds, swap the label to the message subject. The
 * resolvers are tiny null-rendering subscribers that lift the resolved subject up;
 * the same memoized query primes the hover card's cache too, so opening the card is
 * a cache hit.
 */
export function useCommitMarkers(
	releases: ReadonlyArray<ReleasePoint>,
	chartBuckets: ReadonlyArray<string>,
): { overlay: ReactNode; resolvers: ReactNode } {
	const baseMarkers = useMemo(() => buildCommitMarkers(releases, chartBuckets), [releases, chartBuckets])

	const [labels, setLabels] = useState<ReadonlyMap<string, string>>(EMPTY_LABELS)
	const onResolved = useCallback((sha: string, text: string) => {
		setLabels((prev) => (prev.get(sha) === text ? prev : new Map(prev).set(sha, text)))
	}, [])

	const markers = useMemo(
		() =>
			baseMarkers.map((m) => {
				const resolved = labels.get(m.commits[0]?.sha ?? "")
				return resolved ? { ...m, label: resolved } : m
			}),
		[baseMarkers, labels],
	)

	const resolvers = useMemo(() => {
		const shas = new Set<string>()
		for (const m of baseMarkers) {
			const sha = m.commits[0]?.sha
			if (sha && isResolvableSha(sha)) shas.add(sha)
		}
		return Array.from(shas, (sha) => <CommitLabelResolver key={sha} sha={sha} onResolved={onResolved} />)
	}, [baseMarkers, onResolved])

	const overlay = markers.length > 0 ? <CommitMarkersLayer markers={markers} /> : null
	return { overlay, resolvers }
}

// Subscribes to a commit's resolution and lifts its subject line up. Renders
// nothing; mounting it just runs (and caches) the shared per-SHA query.
function CommitLabelResolver({
	sha,
	onResolved,
}: {
	sha: string
	onResolved: (sha: string, text: string) => void
}) {
	const result = useAtomValue(commitQueryAtom(sha))
	useEffect(() => {
		const text = Result.builder(result)
			.onSuccess((commit) => firstLine(commit.message))
			.orElse(() => null)
		if (text) onResolved(sha, text)
	}, [result, sha, onResolved])
	return null
}
