// The page's route template on its `<html>` element, as `data-route`, where
// `traceAstroNavigation` reads it. The page's own `Astro.routePattern` is the
// name, but only the page can write it into its markup: this does it for every
// page from middleware, as the HTML streams past. Only the bytes before the end
// of the `<html>` start tag are held back.

/** Doctype, comments and whitespace, which may come before `<html>`. */
const PREAMBLE = /^(?:\s+|<!--[\s\S]*?-->|<!(?!--)[^>]*>)*/
const HTML_TAG = /^<html(?=[\s>])[^>]*>/i
const HAS_ROUTE = /\sdata-route[\s=>]/i

/** Stop looking after this much, for a document that starts with something else entirely. */
const MAX_LOOKAHEAD = 16 * 1024

/**
 * Where ` data-route="…"` goes in the document's first bytes: right after `<html`. `false`
 * when there's nothing to stamp (no `<html>` start tag first, or it has `data-route` already),
 * `undefined` when more bytes are needed to tell.
 */
export function routeInsertionPoint(text: string): number | false | undefined {
	const start = PREAMBLE.exec(text)?.[0].length ?? 0
	const rest = text.slice(start)
	const tag = HTML_TAG.exec(rest)
	if (tag) return !HAS_ROUTE.test(tag[0]) && start + "<html".length
	const pending =
		rest.startsWith("<!") || /^<html[^>]*$/i.test(rest) || "<html".startsWith(rest.toLowerCase())
	return pending ? undefined : false
}

const escapeAttribute = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;")

/**
 * One character per byte, so string offsets are byte offsets. Everything the search looks for
 * is ASCII, which UTF-8 never uses inside a multibyte character. Not `TextDecoder("latin1")`:
 * not every runtime has it.
 */
const byteString = (bytes: Uint8Array): string => String.fromCharCode(...bytes)

/** Adds `data-route` to the `<html>` start tag of the HTML streaming through, if it starts with one. */
export function stampRoute(route: string): TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>> {
	let held: Uint8Array<ArrayBuffer> | undefined = new Uint8Array(0)
	return new TransformStream({
		transform(chunk, controller) {
			if (!held) return controller.enqueue(chunk)
			const buffered = new Uint8Array(held.length + chunk.length)
			buffered.set(held)
			buffered.set(chunk, held.length)
			const at = routeInsertionPoint(byteString(buffered.subarray(0, MAX_LOOKAHEAD)))
			if (at === undefined && buffered.length < MAX_LOOKAHEAD) {
				held = buffered
				return
			}
			held = undefined
			if (typeof at !== "number") return controller.enqueue(buffered)
			controller.enqueue(buffered.subarray(0, at))
			controller.enqueue(new TextEncoder().encode(` data-route="${escapeAttribute(route)}"`))
			controller.enqueue(buffered.subarray(at))
		},
		flush(controller) {
			if (held?.length) controller.enqueue(held)
		},
	})
}
