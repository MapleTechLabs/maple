import { describe, expect, it } from "vitest"
import {
	compareVersions,
	normalizeRuntimeVersion,
	type RuntimeRelease,
	releaseCycleOf,
	runtimePosture,
	runtimeProductOf,
} from "./runtime-posture"

const NODE: ReadonlyArray<RuntimeRelease> = [
	{ cycle: "22", isEol: false, eolFrom: "2027-04-30", latest: "22.21.1" },
	{ cycle: "18", isEol: true, eolFrom: "2025-04-30", latest: "18.20.8" },
]
const PYTHON: ReadonlyArray<RuntimeRelease> = [
	{ cycle: "3.1", isEol: true, eolFrom: "2012-04-09", latest: "3.1.5" },
	{ cycle: "3.12", isEol: false, eolFrom: "2028-10-31", latest: "3.12.12" },
]
const releases = (product: string) =>
	product === "nodejs" ? NODE : product === "python" ? PYTHON : undefined

const posture = (runtimeName: string, runtimeVersion: string, sdkLanguage = "") =>
	runtimePosture({ runtimeName, runtimeVersion, sdkLanguage }, releases)

describe("runtimeProductOf", () => {
	it("names the runtime from process.runtime.name, else the SDK language", () => {
		expect(runtimeProductOf("nodejs", "nodejs")).toBe("nodejs")
		expect(runtimeProductOf("bun", "nodejs")).toBe("bun")
		expect(runtimeProductOf("CPython", "python")).toBe("python")
		expect(runtimeProductOf("OpenJDK Runtime Environment", "java")).toBe("java")
		expect(runtimeProductOf(".NET", "dotnet")).toBe("dotnet")
		// PHP reports its SAPI as the runtime name.
		expect(runtimeProductOf("fpm-fcgi", "php")).toBe("php")
	})

	it("leaves Workers, unknown Node.js hosts and unlisted runtimes untracked", () => {
		expect(runtimeProductOf("workerd", "")).toBeUndefined()
		expect(runtimeProductOf("", "nodejs")).toBeUndefined()
		expect(runtimeProductOf("jruby", "ruby")).toBeUndefined()
		expect(runtimeProductOf(".NET Framework", "dotnet")).toBeUndefined()
		expect(runtimeProductOf("", "ruby")).toBe("ruby")
	})
})

describe("normalizeRuntimeVersion", () => {
	it("reduces vendor spellings to a dotted version", () => {
		expect(normalizeRuntimeVersion("v22.11.0")).toBe("22.11.0")
		expect(normalizeRuntimeVersion("go1.22.1")).toBe("1.22.1")
		expect(normalizeRuntimeVersion("17.0.9+9")).toBe("17.0.9")
		expect(normalizeRuntimeVersion("1.8.0_392-b08")).toBe("8.0.392")
		expect(normalizeRuntimeVersion("8u504-b01")).toBe("8.0.504")
		expect(normalizeRuntimeVersion("")).toBeUndefined()
	})
})

describe("releaseCycleOf", () => {
	it("picks the longest cycle on a segment boundary", () => {
		expect(releaseCycleOf(PYTHON, "3.12.4")?.cycle).toBe("3.12")
		expect(releaseCycleOf(PYTHON, "3.1.2")?.cycle).toBe("3.1")
		expect(releaseCycleOf(PYTHON, "3.13.0")).toBeUndefined()
	})

	it("compares versions numerically", () => {
		expect(compareVersions("22.9.0", "22.10.0")).toBe(-1)
		expect(compareVersions("22.10", "22.10.0")).toBe(0)
	})
})

describe("runtimePosture", () => {
	it("flags an end-of-life cycle even on its latest patch", () => {
		expect(posture("nodejs", "18.20.8")).toMatchObject({ status: "end_of_life", cycle: "18" })
	})

	it("flags a supported cycle behind its latest patch", () => {
		expect(posture("nodejs", "v22.11.0")).toMatchObject({ status: "behind", latest: "22.21.1" })
		expect(posture("nodejs", "22.21.1")).toMatchObject({ status: "supported" })
	})

	it("does not judge Bun or Deno by the Node.js version they emulate", () => {
		expect(
			runtimePosture(
				{
					runtimeName: "nodejs",
					runtimeVersion: "18.20.8",
					sdkLanguage: "nodejs",
					executableName: "bun",
				},
				releases,
			),
		).toEqual({ status: "emulated", product: "bun", version: "18.20.8" })
	})

	it("says why a runtime cannot be judged", () => {
		expect(posture("nodejs", "")).toEqual({ status: "no_version", product: "nodejs" })
		expect(posture("workerd", "")).toEqual({ status: "untracked" })
		expect(posture("python", "3.13.0", "python")).toMatchObject({ status: "unknown_cycle" })
		expect(posture("ruby", "3.3.0")).toMatchObject({ status: "catalog_unavailable" })
	})
})
