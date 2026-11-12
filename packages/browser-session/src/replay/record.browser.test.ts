// Real rrweb in real Chromium: what a recorded chunk carries for secret inputs.
import { afterEach, describe, expect, it, vi } from "vitest"
import { getSession, resetSessionStorageStateForTests } from "../session/session"
import { startRecording } from "./record"

const CONFIG = {
	endpoint: "https://ingest.test",
	sdk: "maple-test/0.0.0",
	maskAllText: false,
}

const SECRETS = {
	csrf: "csrf-token-7f3a9c",
	card: "4111111111111111",
	otp: "839201",
	newPassword: "hunter2-new-pass",
}

/** Every chunk body the recorder uploaded, decompressed. */
function captureUploads(): () => Promise<string> {
	const bodies: Uint8Array[] = []
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
			if (init?.body instanceof Uint8Array) bodies.push(init.body)
			return new Response(null, { status: 202 })
		}),
	)
	return async () => {
		const texts = await Promise.all(
			bodies.map((body) =>
				new Response(
					new Blob([new Uint8Array(body)]).stream().pipeThrough(new DecompressionStream("gzip")),
				).text(),
			),
		)
		return texts.join("\n")
	}
}

function mountForm(): { hidden: HTMLInputElement; card: HTMLInputElement; plain: HTMLInputElement } {
	document.body.innerHTML = `
		<form>
			<input type="hidden" name="csrf" value="${SECRETS.csrf}">
			<input name="card" autocomplete="billing cc-number" value="">
			<input name="otp" autocomplete="one-time-code" value="${SECRETS.otp}">
			<input name="pw" type="text" autocomplete="new-password" value="${SECRETS.newPassword}">
			<input name="plain" type="text" value="">
		</form>`
	const query = (selector: string): HTMLInputElement => {
		const element = document.querySelector(selector)
		if (!(element instanceof HTMLInputElement)) throw new Error(`missing ${selector}`)
		return element
	}
	return { hidden: query("[name=csrf]"), card: query("[name=card]"), plain: query("[name=plain]") }
}

const type = (input: HTMLInputElement, value: string): void => {
	input.value = value
	input.dispatchEvent(new Event("input", { bubbles: true }))
}

afterEach(() => {
	vi.unstubAllGlobals()
	document.body.innerHTML = ""
	sessionStorage.clear()
	resetSessionStorageStateForTests()
})

describe("input masking with real rrweb", () => {
	it.each([false, true])(
		"never records hidden, card, one-time-code or password values (maskAllInputs: %s)",
		async (maskAllInputs) => {
			const uploads = captureUploads()
			const { hidden, card, plain } = mountForm()
			const recorder = startRecording({ ...CONFIG, maskAllInputs }, getSession().id)

			type(card, SECRETS.card)
			type(plain, "visible-words")
			// A rotated token written by script: the setter hook and the attribute mutation.
			hidden.value = `${SECRETS.csrf}-2`
			hidden.setAttribute("value", `${SECRETS.csrf}-3`)
			await new Promise((resolve) => setTimeout(resolve, 0))
			await recorder.flush()
			recorder.stop()

			const recorded = await uploads()
			expect(recorded.length).toBeGreaterThan(0)
			for (const secret of Object.values(SECRETS)) expect(recorded).not.toContain(secret)
			// Proves the input was captured at all: an ordinary field is masked only when asked.
			expect(recorded.includes("visible-words")).toBe(!maskAllInputs)
		},
	)
})

describe("a page's own failing stylesheet call, with real rrweb", () => {
	// What the dashboard's auth widget inserts: a vendor-prefixed rule Chromium rejects.
	const REJECTED_RULE = ".cl-internal-41zur7:focus::-moz-focus-inner{border:0;}"

	/** How the thrown error reads to the page, or undefined when nothing was thrown. */
	const thrownBy = (run: () => void): string | undefined => {
		try {
			run()
		} catch (error) {
			return error instanceof DOMException ? `${error.name}: ${error.message}` : String(error)
		}
		return undefined
	}

	const mountSheet = (): CSSStyleSheet => {
		const style = document.createElement("style")
		document.body.appendChild(style)
		if (!style.sheet) throw new Error("the style element has no sheet")
		return style.sheet
	}

	it("rethrows the browser's own error to the page and keeps recording", async () => {
		const uploads = captureUploads()
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const sheet = mountSheet()
		const withoutRecorder = thrownBy(() => sheet.insertRule(REJECTED_RULE, 0))
		const recorder = startRecording({ ...CONFIG, maskAllInputs: false }, getSession().id)

		const withRecorder = thrownBy(() => sheet.insertRule(REJECTED_RULE, 0))
		// A rule the page inserts afterwards is still recorded, and still returns its index.
		const index = sheet.insertRule(".after-the-throw{color:red}", 0)
		await recorder.flush()
		recorder.stop()

		expect(withoutRecorder).toContain("SyntaxError: Failed to execute 'insertRule'")
		expect(withRecorder).toBe(withoutRecorder)
		expect(index).toBe(0)
		expect(sheet.cssRules).toHaveLength(1)
		expect(await uploads()).toContain("after-the-throw")
		expect(warn).not.toHaveBeenCalled()
		warn.mockRestore()
	})

	it("hands the stylesheet methods back to the page once recording stops", () => {
		captureUploads()
		const before = CSSStyleSheet.prototype.insertRule
		const recorder = startRecording({ ...CONFIG, maskAllInputs: false }, getSession().id)
		const during = CSSStyleSheet.prototype.insertRule
		recorder.stop()

		expect(during).not.toBe(before)
		expect(CSSStyleSheet.prototype.insertRule).toBe(before)
	})
})
