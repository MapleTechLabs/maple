/**
 * The socket object's lifecycle, against a fake Durable Object state and a fake `WebSocket`: what
 * a dial leaves behind, what a tick decides before the socket has opened, and when it gives up.
 */
import { chatConnectorId } from "@maple/chat-platform"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ConnectorRelayClient } from "../relay/stub.ts"
import { ConnectorSocket, OPEN_TIMEOUT_MS } from "./ConnectorSocket.ts"

/** The fields the object reads off a socket event. */
interface SocketEvent {
	readonly data?: string
	readonly code?: number
	readonly reason?: string
}

class FakeWebSocket {
	static readonly CONNECTING = 0
	static readonly OPEN = 1
	static readonly opened: Array<FakeWebSocket> = []
	readyState = FakeWebSocket.CONNECTING
	readonly sent: Array<string> = []
	closedWith: number | undefined
	private readonly listeners = new Map<string, Array<(event: SocketEvent) => void>>()
	constructor(readonly url: string) {
		FakeWebSocket.opened.push(this)
	}
	addEventListener(type: string, listener: (event: SocketEvent) => void): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
	}
	send(frame: string): void {
		this.sent.push(frame)
	}
	close(code: number): void {
		this.closedWith = code
		if (FakeWebSocket.refuseClose) throw new TypeError("close refused while connecting")
	}
	static refuseClose = false
	open(): void {
		this.readyState = FakeWebSocket.OPEN
		for (const listener of this.listeners.get("open") ?? []) listener({})
	}
}

const objectState = (stored: Map<string, unknown> = new Map()) => {
	const pending: Array<Promise<unknown>> = []
	return {
		stored,
		pending,
		storage: {
			get: <T>(key: string) => Promise.resolve(stored.get(key) as T | undefined),
			put: <T>(key: string, value: T) => {
				stored.set(key, value)
				return Promise.resolve()
			},
			delete: (key: string) => Promise.resolve(stored.delete(key)),
			setAlarm: () => Promise.resolve(),
		},
		waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
		blockConcurrencyWhile: <T>(callback: () => Promise<T>) => callback(),
	}
}

const relays: ConnectorRelayClient = {
	getByName: () => ({ deliver: () => Effect.void }),
}

const DISCORD_CONNECTOR_ID = chatConnectorId("discord")
const ENV = { MAPLE_DISCORD_BOT_TOKEN: "token" }
const NOW = 1_800_000_000_000

/** What an evicted activation left in storage: a session mid-heartbeat, and its due time. */
const evicted = () =>
	new Map<string, unknown>([
		["connectorId", DISCORD_CONNECTOR_ID],
		["protocol", JSON.stringify({ awaitingAck: true, heartbeatIntervalMs: 41_250 })],
		["heartbeatAt", NOW - 1_000],
	])

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] })
	vi.setSystemTime(NOW)
	FakeWebSocket.opened.length = 0
	FakeWebSocket.refuseClose = false
	vi.stubGlobal("WebSocket", FakeWebSocket)
})

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
})

describe("ConnectorSocket", () => {
	it("does not fire a dead connection's heartbeat on the socket that replaced it", async () => {
		const state = objectState(evicted())
		const socket = new ConnectorSocket(state, ENV, relays)

		await socket.ensureConnected(DISCORD_CONNECTOR_ID)
		await socket.alarm()
		await Promise.all(state.pending)

		expect(FakeWebSocket.opened).toHaveLength(1)
		// The stale `awaitingAck` would have closed the fresh socket for a missed acknowledgement.
		expect(FakeWebSocket.opened[0]?.closedWith).toBeUndefined()
		expect(state.stored.has("heartbeatAt")).toBe(false)
	})

	it("arms the handshake timer once the socket opens", async () => {
		const state = objectState(evicted())
		const socket = new ConnectorSocket(state, ENV, relays)

		await socket.ensureConnected(DISCORD_CONNECTOR_ID)
		FakeWebSocket.opened[0]?.open()
		await Promise.all(state.pending)

		expect(state.stored.get("heartbeatAt")).toBeGreaterThan(NOW)
		expect(FakeWebSocket.opened[0]?.closedWith).toBeUndefined()
	})

	it("gives up on a socket that never opens, and backs off before dialling again", async () => {
		const state = objectState(evicted())
		const socket = new ConnectorSocket(state, ENV, relays)

		await socket.ensureConnected(DISCORD_CONNECTOR_ID)
		await socket.alarm()
		expect(FakeWebSocket.opened[0]?.closedWith).toBeUndefined()

		vi.setSystemTime(NOW + OPEN_TIMEOUT_MS)
		await socket.alarm()
		await Promise.all(state.pending)

		expect(FakeWebSocket.opened[0]?.closedWith).toBe(1_000)
		expect(state.stored.get("reconnectAt")).toBeGreaterThan(NOW + OPEN_TIMEOUT_MS)
		expect(state.stored.get("attempt")).toBe(1)
	})

	it("drops a socket that refuses the close, and still backs off and dials again", async () => {
		const state = objectState(evicted())
		const socket = new ConnectorSocket(state, ENV, relays)
		FakeWebSocket.refuseClose = true

		await socket.ensureConnected(DISCORD_CONNECTOR_ID)
		vi.setSystemTime(NOW + OPEN_TIMEOUT_MS)
		await socket.alarm()
		await Promise.all(state.pending)
		expect(state.stored.get("attempt")).toBe(1)

		vi.setSystemTime(Number(state.stored.get("reconnectAt")))
		await socket.alarm()
		expect(FakeWebSocket.opened).toHaveLength(2)
	})
})
