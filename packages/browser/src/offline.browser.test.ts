import {
	BasicTracerProvider,
	InMemorySpanExporter,
	type ReadableSpan,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { afterEach, describe, expect, it } from "vitest"
import { attachSpanStash, OfflineSpanExporter, resetOfflineForTests } from "./offline"

const finishedSpans = (...names: string[]): ReadableSpan[] => {
	const memory = new InMemorySpanExporter()
	const tracer = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memory)] }).getTracer(
		"t",
	)
	for (const name of names) tracer.startSpan(name).end()
	return memory.getFinishedSpans()
}

afterEach(() => resetOfflineForTests())

describe("OfflineSpanExporter", () => {
	it("hands failed batches to the stash, holding them until it is attached", () => {
		const failing = {
			export: (_spans: ReadableSpan[], callback: (result: { code: number }) => void) =>
				callback({ code: 1 }),
			shutdown: async () => {},
		}
		const exporter = new OfflineSpanExporter(failing)
		exporter.export(finishedSpans("early"), () => {})
		const stashed: ReadableSpan[][] = []
		attachSpanStash((batch) => stashed.push(batch))
		exporter.export(finishedSpans("late"), () => {})
		expect(stashed.map((batch) => batch[0]?.name)).toEqual(["early", "late"])
	})
})
