// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
// A zone.js app, as every Angular app was before zoneless became the default. Its own file: zone.js
// patches the page's timers and promises for every test that runs after it.
import "zone.js"
import "@angular/compiler"
import { provideLocationMocks } from "@angular/common/testing"
import { type ApplicationRef, NgZone, provideZoneChangeDetection } from "@angular/core"
import { createApplication } from "@angular/platform-browser"
import { provideRouter, Router } from "@angular/router"
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base"
import { filter, firstValueFrom, timeout } from "rxjs"
import { afterEach, expect, it, vi } from "vitest"

const exported: ReadableSpan[] = []
vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
	OTLPTraceExporter: class {
		export(spans: ReadableSpan[], callback: (result: { code: number }) => void): void {
			exported.push(...spans)
			callback({ code: 0 })
		}
		forceFlush(): Promise<void> {
			return Promise.resolve()
		}
		shutdown(): Promise<void> {
			return Promise.resolve()
		}
	},
}))

const { MapleBrowser } = await import("../index")
const { provideMapleTracing } = await import("./index")

let app: ApplicationRef | undefined

afterEach(() => app?.destroy())

it("leaves a zone.js app stable after a navigation, though its span waits for the next export", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("{}")),
	)
	const handle = MapleBrowser.init({
		ingestKey: "k",
		serviceName: "web",
		endpoint: "https://ingest.test",
		replay: { enabled: false },
	})
	app = await createApplication({
		providers: [
			provideZoneChangeDetection(),
			provideRouter([
				{ path: "", children: [] },
				{ path: "projects/:id", children: [] },
			]),
			provideLocationMocks(),
			provideMapleTracing(),
		],
	})
	const router = app.injector.get(Router)
	await app.injector.get(NgZone).run(() => router.navigateByUrl("/projects/1"))

	// Well before the exporter's 2 s timer
	await expect(firstValueFrom(app.isStable.pipe(filter(Boolean), timeout(500)))).resolves.toBe(true)
	await handle.shutdown()
	expect(exported.map((span) => span.name)).toEqual(["pageload /projects/:id"])
})
