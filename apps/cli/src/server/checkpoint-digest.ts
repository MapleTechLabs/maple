import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"

/** Hash immutable control snapshots asynchronously with bounded read buffers. */
export const sha256File = async (path: string): Promise<string> => {
	const hash = createHash("sha256")
	const stream = createReadStream(path, { highWaterMark: 64 * 1024 })
	for await (const chunk of stream) hash.update(chunk)
	return hash.digest("hex")
}
