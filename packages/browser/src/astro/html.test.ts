import { describe, expect, it } from "vitest"
import { routeInsertionPoint, stampRoute } from "./html"

const encoder = new TextEncoder()

/** Stream `chunks` through `stampRoute` and collect the output as chunks. */
async function stamp(route: string, chunks: string[]): Promise<string[]> {
	const input = new ReadableStream<Uint8Array<ArrayBuffer>>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
			controller.close()
		},
	})
	const decoder = new TextDecoder()
	const output: string[] = []
	for await (const chunk of input.pipeThrough(stampRoute(route)))
		output.push(decoder.decode(chunk, { stream: true }))
	return output
}

const stamped = async (route: string, chunks: string[]) => (await stamp(route, chunks)).join("")

describe("routeInsertionPoint", () => {
	it("finds <html after the doctype, comments and whitespace", () => {
		expect(routeInsertionPoint('<!DOCTYPE html><html lang="en"><head>')).toBe(20)
		expect(routeInsertionPoint("\n  <!-- built --> <!doctype html>\n<HTML>")).toBe(39)
		expect(routeInsertionPoint("<html>")).toBe(5)
	})

	it("needs more bytes while the start tag may still come", () => {
		for (const text of [
			"",
			"<",
			"<!DOC",
			"<!DOCTYPE html>",
			"<!-- a > b",
			"<!DOCTYPE html><ht",
			"<html",
			'<html lang="e',
		])
			expect(routeInsertionPoint(text), text).toBeUndefined()
	})

	it("stamps nothing when the document doesn't start with <html>", () => {
		for (const text of ["<div>island</div>", "<!DOCTYPE html><head>", "<html-card>", "{}", "hello"])
			expect(routeInsertionPoint(text), text).toBe(false)
	})

	it("leaves an <html> that has data-route already", () => {
		expect(routeInsertionPoint('<!DOCTYPE html><html data-route="/a" lang="en">')).toBe(false)
		expect(routeInsertionPoint("<html lang=en data-route>")).toBe(false)
		expect(routeInsertionPoint('<html data-router="x">')).toBe(5)
	})
})

describe("stampRoute", () => {
	it("adds the route to the <html> start tag", async () => {
		expect(
			await stamped("/projects/[id]", [
				'<!DOCTYPE html><html lang="en"><head></head><body></body></html>',
			]),
		).toBe('<!DOCTYPE html><html data-route="/projects/[id]" lang="en"><head></head><body></body></html>')
	})

	it("finds a start tag split across chunks", async () => {
		expect(await stamped("/", ["<!DOCTYPE html>", "<ht", "ml la", 'ng="en">', "<head>"])).toBe(
			'<!DOCTYPE html><html data-route="/" lang="en"><head>',
		)
	})

	it("passes the rest through as it arrives", async () => {
		const chunks = await stamp("/", ["<!DOCTYPE html><html><head>", "<body>", "</body></html>"])
		expect(chunks.slice(-2)).toEqual(["<body>", "</body></html>"])
	})

	it("escapes the route for the attribute", async () => {
		expect(await stamped('/a&"b', ["<html>"])).toBe('<html data-route="/a&amp;&quot;b">')
	})

	it("keeps multibyte text intact around the tag", async () => {
		const html = '<!-- é --><html lang="ja"><title>日本語</title></html>'
		const bytes = encoder.encode(html)
		// Split inside the multibyte characters
		const input = new ReadableStream<Uint8Array<ArrayBuffer>>({
			start(controller) {
				for (let at = 0; at < bytes.length; at += 3) controller.enqueue(bytes.slice(at, at + 3))
				controller.close()
			},
		})
		const output = await new Response(input.pipeThrough(stampRoute("/café"))).text()
		expect(output).toBe('<!-- é --><html data-route="/café" lang="ja"><title>日本語</title></html>')
	})

	it("passes through what isn't a document, and what already has a route", async () => {
		expect(await stamped("/_server-islands/[name]", ["<p>island</p>"])).toBe("<p>island</p>")
		expect(await stamped("/b", ['<html data-route="/a">'])).toBe('<html data-route="/a">')
		expect(await stamped("/", [])).toBe("")
		expect(await stamped("/", ["<!DOCTYPE html>"])).toBe("<!DOCTYPE html>")
	})

	it("gives up on a preamble that never ends", async () => {
		const comment = `<!--${"x".repeat(20_000)}`
		expect(await stamped("/", [comment, "--><html>"])).toBe(`${comment}--><html>`)
	})
})
