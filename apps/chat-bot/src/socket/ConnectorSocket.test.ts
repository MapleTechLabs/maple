/**
 * The socket object's lifecycle, against a fake Durable Object state, a fake `WebSocket` and a fake
 * connector: what a dial leaves behind, what a tick decides before the socket has opened, and when
 * it gives up.
 */
import { socketIngress, type SocketStep } from "@maple/chat-platform"
import { Effect, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { IngressConnector } from "../config.ts"
import type { ConnectorRelayClient } from "../relay/stub.ts"
import { TEST_SOCKET_ID, TEST_TOKEN_KEY } from "../test-support.ts"
import { ConnectorSocket, OPEN_TIMEOUT_MS } from "./ConnectorSocket.ts"

const HEARTBEAT_MS = 41_250

const FakeState = Schema.Struct({ awaitingAck: Schema.Boolean, heartbeatIntervalMs: Schema.Number })
type FakeState = typeof FakeState.Type

/**
 * A heartbeat protocol shaped like a real gateway's: a heartbeat sent while the last one is still
 * unacknowledged means the connection is a zombie, so the connector asks for a reconnect.
 */
const fakeConnector: IngressConnector = {
	id: TEST_SOCKET_ID,
	ingress: socketIngress({
		requiredConfig: [{ name: TEST_TOKEN_KEY, secret: true }],
		stateSchema: Schema.fromJsonString(FakeState),
		initialState: { awaitingAck: false, heartbeatIntervalMs: HEARTBEAT_MS },
		connectUrl: () => "wss://socket.test/gateway",
		onOpen: (state: FakeState, now: number): SocketStep<FakeState> => ({
			state: { ...state, awaitingAck: false },
			heartbeatAt: now + state.heartbeatIntervalMs,
		}),
		onFrame: (state: FakeState, frame: string): SocketStep<FakeState> => ({
			state: frame === "ack" ? { ...state, awaitingAck: false } : state,
		}),
		onClose: (state: FakeState): SocketStep<FakeState> => ({
			state,
			directive: { _tag: "reconnect", closeCode: 4_000 },
		}),
		heartbeat: (state: FakeState, now: number): SocketStep<FakeState> =>
			state.awaitingAck
				? { state, directive: { _tag: "reconnect", closeCode: 4_009 } }
				: {
						state: { ...state, awaitingAck: true },
						send: ["ping"],
						heartbeatAt: now + state.heartbeatIntervalMs,
					},
	}),
}

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

const ENV = { [TEST_TOKEN_KEY]: "token" }
const NOW = 1_800_000_000_000

/** What an evicted activation left in storage: a session mid-heartbeat, and its due time. */
const evicted = () =>
	new Map<string, unknown>([
		["connectorId", TEST_SOCKET_ID],
		["protocol", JSON.stringify({ awaitingAck: true, heartbeatIntervalMs: HEARTBEAT_MS })],
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
		const socket = new ConnectorSocket(state, ENV, relays, [fakeConnector])

		await socket.ensureConnected(TEST_SOCKET_ID)
		await socket.alarm()
		await Promise.all(state.pending)

		expect(FakeWebSocket.opened).toHaveLength(1)
		// The stale `awaitingAck` would have closed the fresh socket for a missed acknowledgement.
		expect(FakeWebSocket.opened[0]?.closedWith).toBeUndefined()
		expect(FakeWebSocket.opened[0]?.sent).toEqual([])
		expect(state.stored.has("heartbeatAt")).toBe(false)
	})

	it("sends the fresh socket's first heartbeat instead of judging it by the dead one's ack", async () => {
		const state = objectState(evicted())
		const socket = new ConnectorSocket(state, ENV, relays, [fakeConnector])

		await socket.ensureConnected(TEST_SOCKET_ID)
		FakeWebSocket.opened[0]?.open()
		await Promise.all(state.pending)
		vi.setSystemTime(Number(state.stored.get("heartbeatAt")))
		await socket.alarm()

		expect(FakeWebSocket.opened[0]?.sent).toEqual(["ping"])
		expect(FakeWebSocket.opened[0]?.closedWith).toBeUndefined()
	})

	it("arms the handshake timer once the socket opens", async () => {
		const state = objectState(evicted())
		const socket = new ConnectorSocket(state, ENV, relays, [fakeConnector])

		await socket.ensureConnected(TEST_SOCKET_ID)
		FakeWebSocket.opened[0]?.open()
		await Promise.all(state.pending)

		expect(state.stored.get("heartbeatAt")).toBeGreaterThan(NOW)
		expect(FakeWebSocket.opened[0]?.closedWith).toBeUndefined()
	})

	it("gives up on a socket that never opens, and backs off before dialling again", async () => {
		const state = objectState(evicted())
		const socket = new ConnectorSocket(state, ENV, relays, [fakeConnector])

		await socket.ensureConnected(TEST_SOCKET_ID)
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
		const socket = new ConnectorSocket(state, ENV, relays, [fakeConnector])
		FakeWebSocket.refuseClose = true

		await socket.ensureConnected(TEST_SOCKET_ID)
		vi.setSystemTime(NOW + OPEN_TIMEOUT_MS)
		await socket.alarm()
		await Promise.all(state.pending)
		expect(state.stored.get("attempt")).toBe(1)

		vi.setSystemTime(Number(state.stored.get("reconnectAt")))
		await socket.alarm()
		expect(FakeWebSocket.opened).toHaveLength(2)
	})
})
