// Where the replay recorder keeps the chunk a page was flushing as it went
// away (`replay/record.ts` stores and sends it). The key and its removal live
// in the always-loaded tier so a consent revoke discards the chunk even on a
// page where the replay module never loaded.
export const PENDING_CHUNK_KEY = "maple.replay.pending"

/** Remove the stored chunk. False when storage is blocked: nothing is known to be removed. */
export function clearPendingChunk(): boolean {
	try {
		window.sessionStorage.removeItem(PENDING_CHUNK_KEY)
		return true
	} catch {
		return false
	}
}
