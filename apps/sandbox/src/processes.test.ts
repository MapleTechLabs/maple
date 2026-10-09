import { assert, describe, it } from "@effect/vitest"
import {
	claimProcessArgv,
	commandArgv,
	isSafeProcessId,
	isTimedOut,
	parseProcessStatus,
	startProcessArgv,
} from "./processes"

describe("commandArgv", () => {
	it("runs the command string in bash, as the 0.x SDK did", () => {
		assert.deepStrictEqual(commandArgv("echo hi"), ["bash", "-c", "echo hi"])
	})

	it("bounds it with coreutils timeout, rounding up to whole seconds", () => {
		assert.deepStrictEqual(commandArgv("echo hi", 1_500), [
			"timeout",
			"--kill-after=5",
			"2",
			"bash",
			"-c",
			"echo hi",
		])
	})
})

describe("isTimedOut", () => {
	it("reads TERM and KILL exits past the deadline as a timeout", () => {
		assert.isTrue(isTimedOut(124, 30_000, 30_000))
		assert.isTrue(isTimedOut(137, 35_100, 30_000))
	})

	it("leaves a command's own 124 alone when it exited early", () => {
		assert.isFalse(isTimedOut(124, 200, 30_000))
		assert.isFalse(isTimedOut(124, 200))
	})
})

describe("background processes", () => {
	it("refuses an id that is not a plain directory name", () => {
		assert.isTrue(isSafeProcessId("maple-clone-0123abcd"))
		assert.isFalse(isSafeProcessId("../etc"))
		assert.isFalse(isSafeProcessId(""))
	})

	it("claims an id with a mkdir that fails when it is taken", () => {
		assert.include(claimProcessArgv("p1").at(-1)!, "&& mkdir '/var/lib/maple-processes/p1'")
	})

	it("hands the command to bash as one argument, never through the runner's shell", () => {
		assert.deepStrictEqual(startProcessArgv("p1", "git fetch").slice(-3), ["bash", "-c", "git fetch"])
	})

	it("maps each recorded state onto the port's statuses", () => {
		assert.isNull(parseProcessStatus("p", "missing\n"))
		assert.deepStrictEqual(parseProcessStatus("p", "starting\n"), { id: "p", status: "starting" })
		assert.deepStrictEqual(parseProcessStatus("p", "running\n"), { id: "p", status: "running" })
		assert.deepStrictEqual(parseProcessStatus("p", "exited 0\n"), {
			id: "p",
			status: "completed",
			exitCode: 0,
		})
		assert.deepStrictEqual(parseProcessStatus("p", "exited 128\n"), {
			id: "p",
			status: "failed",
			exitCode: 128,
		})
		assert.deepStrictEqual(parseProcessStatus("p", "lost\n"), { id: "p", status: "error" })
	})
})
