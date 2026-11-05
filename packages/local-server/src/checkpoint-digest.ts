import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import type { Readable } from "node:stream"

// Node types a stream's iterator as `any`; a file stream without an encoding yields Buffers.
const bufferChunks = (stream: Readable): AsyncIterable<Buffer> => stream

/** Hash a file asynchronously with a bounded read buffer (64 KiB unless given). */
export const sha256File = async (path: string, highWaterMark = 64 * 1024): Promise<string> => {
	const hash = createHash("sha256")
	for await (const chunk of bufferChunks(createReadStream(path, { highWaterMark }))) hash.update(chunk)
	return hash.digest("hex")
}
