import { inferBucketSeconds, parseBucketMs } from "./format"

export interface IncompleteSegmentsResult<T extends Record<string, unknown>> {
	data: T[]
	hasIncomplete: boolean
	incompleteKeys: string[]
}

/**
 * Split time-series data into complete and incomplete segments.
 *
 * For each value key, the output rows contain:
 * - Complete buckets: `key = value`, `key_incomplete = null`
 * - Bridge point (last complete): `key = value`, `key_incomplete = value`
 * - Incomplete buckets: `key = null`, `key_incomplete = value`
 *
 * This allows Recharts to render two overlapping series — one solid (complete)
 * and one dashed (incomplete) — with a seamless connection at the bridge point.
 *
 * Detection is authoritative when the upstream pipeline annotates rows with
 * `partial: true` (it knows the query's bucket size and freshness, so it can flag
 * the in-progress *and* ingestion-lagged trailing buckets that wall-clock alone
 * can't catch). When no row carries that flag, fall back to inferring the bucket
 * size from point spacing and comparing each bucket's end against `now`.
 */
export function markIncompleteSegments<T extends Record<string, unknown>>(
	data: T[],
	valueKeys: string[],
	opts?: { now?: number },
): IncompleteSegmentsResult<T> {
	if (data.length === 0) {
		return { data: [], hasIncomplete: false, incompleteKeys: [] }
	}

	// Prefer an explicit per-row flag set by the data pipeline.
	let firstIncompleteIdx = data.findIndex((row) => row.partial === true)

	if (firstIncompleteIdx === -1) {
		// Fall back to the spacing + wall-clock heuristic.
		const bucketSeconds = inferBucketSeconds(data as unknown as Array<{ bucket: string }>)
		if (bucketSeconds == null) {
			return { data, hasIncomplete: false, incompleteKeys: [] }
		}

		const nowMs = opts?.now ?? Date.now()
		const intervalMs = bucketSeconds * 1000

		for (let i = 0; i < data.length; i++) {
			const bucketMs = parseBucketMs(data[i].bucket)
			if (bucketMs == null) continue
			if (bucketMs + intervalMs > nowMs) {
				firstIncompleteIdx = i
				break
			}
		}
	}

	// No incomplete buckets found
	if (firstIncompleteIdx === -1) {
		return { data, hasIncomplete: false, incompleteKeys: [] }
	}

	const incompleteKeys = valueKeys.map((k) => `${k}_incomplete`)
	const bridgeIdx = firstIncompleteIdx - 1

	const result = data.map((row, i) => {
		const next = { ...row } as Record<string, unknown>

		if (i < firstIncompleteIdx) {
			// Complete bucket — null out incomplete keys
			for (const ik of incompleteKeys) {
				next[ik] = null
			}

			// Bridge point: duplicate value into incomplete key so the dashed line connects
			if (i === bridgeIdx) {
				for (let k = 0; k < valueKeys.length; k++) {
					next[incompleteKeys[k]] = row[valueKeys[k]] ?? null
				}
			}
		} else {
			// Incomplete bucket — move values to incomplete keys, null out originals
			for (let k = 0; k < valueKeys.length; k++) {
				next[incompleteKeys[k]] = row[valueKeys[k]] ?? null
				next[valueKeys[k]] = null
			}
		}

		return next as T
	})

	return { data: result, hasIncomplete: true, incompleteKeys }
}
