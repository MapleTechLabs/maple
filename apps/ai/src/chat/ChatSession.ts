/**
 * `ChatSession` — the durable transcript, one Durable Object per `"<orgId>:<tabId>"`.
 *
 * Replaces Flue's `FlueMapleChatAgent` + `FlueRegistry` SQLite Durable Objects. The DO owns four
 * things:
 *
 *   1. **Ordering.** It assigns every event a monotonic `seq`. That is what makes the client
 *      transport resumable by construction: reconnect is `?cursor=<last seq you saw>`, not a
 *      heuristic about whether you missed something.
 *   2. **The event log**, in SQLite, replayed on reconnect and folded into a transcript on cold
 *      load. Both roles replay, so a conversation opened on another device is complete.
 *   3. **Turn lifecycle** — at most one turn in flight, abortable, and self-healing.
 *   4. **Running the turn.** The turn executes *here*, under `ctx.waitUntil` on the DO's own
 *      request context, not in whichever request asked for it.
 *
 * That last point is the load-bearing one. A turn is a multi-second model stream plus N tool
 * calls; the `POST /messages` request that starts it answers in milliseconds. Forking the turn off
 * that request and returning meant Cloudflare was free to cancel it the moment the response was
 * written — and the autonomous path was worse, since cron ticks run under `runScheduledEffect`,
 * which disposes the Effect runtime as soon as the tick's program settles. A Durable Object owns
 * its own lifetime, so hosting the turn here is what actually makes it survive. It also removes
 * every cross-process hop: appending an event is a method call, not a stub RPC.
 *
 * A plain class over the object's state and env rather than a `DurableObject` subclass: the Durable
 * Object itself is `ChatSessionObject` at the bottom of this file, alchemy's Effect-native form, which
 * the api Worker's init yields (binding, namespace and the entry's class export all derive from it)
 * and which builds one of these per activation and drives its methods over RPC.
 *
 * Startup-CPU note (Cloudflare error 10021): this class is reachable from `worker.ts`, whose
 * module scope Cloudflare evaluates during upload validation. It must therefore import nothing
 * from the app service graph at module scope — hence `@maple/domain` (the wire contract and its
 * transcript fold) being the only import, and `./turn-runner` (which pulls in the whole graph)
 * arriving through a dynamic import inside the method that needs it, exactly as `worker.ts` does
 * for the route graph.
 */
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect } from "effect"
import {
	decodeChatEventPayload,
	encodeChatEventPayload,
	type ChatEvent,
	type ChatEventInput,
	type ChatMessage,
	type ChatProposalOutcome,
	type ChatProposalSettlement,
	type ChatTurnOrigin,
	type ChatTurnTenantEncoded,
} from "@maple/domain/chat-session"
import { type ChatSessionStub } from "@maple/domain/chat-session-stub"
import { makeChatTranscript } from "@maple/domain/chat-transcript"
import type { AppliedProposal, ApplyChatProposalInput } from "./apply-proposal"

/** What the class reads off its Durable Object state: SQLite, the alarm, and the object's own `waitUntil`. */
interface ChatSessionState {
	readonly storage: {
		readonly sql: SqlStorage
		setAlarm(scheduledTime: number): Promise<void>
	}
	waitUntil(promise: Promise<unknown>): void
}

/** SQLite row shapes. `SqlStorage.exec` requires an index signature on its row type. */
interface EventRow extends Record<string, SqlStorageValue> {
	readonly seq: number
	readonly created_at: number
	readonly payload: string
}
interface CursorRow extends Record<string, SqlStorageValue> {
	readonly seq: number | null
}
interface SessionRow extends Record<string, SqlStorageValue> {
	readonly running: number
	readonly running_since: number | null
	readonly running_message_id: string | null
}

/** Rows the DO writes. `payload` is the encoded `ChatEvent` minus its `seq`, which is the key. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	created_at INTEGER NOT NULL,
	payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	running INTEGER NOT NULL DEFAULT 0,
	running_since INTEGER,
	running_message_id TEXT
);
INSERT OR IGNORE INTO session (id, running) VALUES (1, 0);
`

/**
 * How long a subscription sits silent before the connection is recycled. Cloudflare caps a request
 * at a few minutes; 25s keeps it well inside that and inside typical proxy idle timeouts.
 *
 * This is a *silence* budget, not a connection lifetime: every batch that goes out resets it, so a
 * turn that streams for two minutes streams over one connection.
 */
const SUBSCRIBE_IDLE_MS = 25_000

/**
 * One SSE frame per event.
 *
 * Framed inside the Durable Object rather than at the route: the DO writes bytes straight into the
 * stream the route hands back, so the route does no per-event work at all.
 *
 * `id:` carries the seq so a client that drops mid-stream resumes from exactly where it stopped
 * rather than re-reading the whole log.
 */
const frameChatEvent = (event: ChatEvent): string => `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`

/** Sent once per connection so a browser falling back to its own reconnect logic paces itself. */
const RETRY_HINT = "retry: 1000\n\n"

/**
 * How long a claimed turn may go without finishing before the claim is treated as abandoned.
 *
 * Without this, any way of losing the turn — isolate eviction, an unhandled defect, a deploy
 * mid-stream — leaves `running = 1` forever: `beginTurn` returns `undefined`, the route 409s every
 * message, and the conversation is wedged with no recovery but a manual abort. 15 minutes matches
 * the `diagnosis_timeout` ceiling the triage path already uses.
 */
const TURN_STALE_MS = 15 * 60 * 1000
const CHAT_TURN_FAILED = "Maple couldn't complete this response."

/**
 * How often a running turn re-arms the object's alarm.
 *
 * An outbound `fetch` never keeps a Durable Object alive, even while the response streams, and an
 * object with no incoming request or event for 70-140 seconds is evicted. A chat turn survives
 * because the open page holds a subscription; an autonomous investigation nobody is watching was
 * evicted about two minutes in, mid-run (seen 2026-09-15). The alarm is the event that prevents it.
 */
const TURN_HEARTBEAT_MS = 30 * 1000

/** What the copy says when applying an approved mutation fell over rather than failing in-band. */
const PROPOSAL_FAILED = "Maple couldn't apply this change. Check whether it went through in Maple."

/**
 * How a session runs a mutation somebody approved.
 *
 * A port rather than a call, for the reason the whole module has: what actually runs the tool is
 * the MCP service graph, which must not be reachable from a class the worker entry exports
 * (Cloudflare error 10021). The Worker's own applier reaches it behind a dynamic import and is the
 * default; a test of the settling supplies its own rather than building that graph.
 *
 * The signature is the applier's own, through a type-only import — erased at compile time, so it
 * costs nothing at module scope; the ban is on the VALUE import below.
 */
export type ProposalApplier = (input: ApplyChatProposalInput) => Promise<AppliedProposal>

const applyThroughWorker: ProposalApplier = async (input) => {
	const { applyChatProposal } = await import("./apply-proposal")
	return applyChatProposal(input)
}

/** A proposed tool call, as the log holds it. */
interface Proposal {
	/** The assistant message that issued it — the id a `tool-result` has to be appended under. */
	readonly messageId: string
	readonly name: string
	readonly input: unknown
	/** Whether somebody has already decided it. */
	readonly settled: boolean
}

export class ChatSession {
	private readonly sql: SqlStorage

	/**
	 * Subscribers parked on the next append — the Workers-native stand-in for an in-memory event bus.
	 *
	 * Durable Object storage has no change feed, so this used to be a 40ms poll. A poll puts a floor
	 * under how fast a token can reach the browser that has nothing to do with how fast the model
	 * produced it, and every wake-up cost two SELECTs against the same isolate the turn was writing
	 * into. Reader and writer are different requests but the *same object*, so the writer can simply
	 * tap the reader on the shoulder.
	 */
	private waiters = new Set<() => void>()

	/**
	 * The turn this activation is actually running. SQL says which turn holds the slot; only this
	 * says its fiber still exists — an evicted object comes back with the claim and without the turn.
	 */
	private liveTurn: string | undefined

	/**
	 * Proposals this activation is part-way through settling.
	 *
	 * The durable check — does the call already have a result — answers every click after the first
	 * one has finished. This answers the one that arrives while the tool is still running, which is
	 * the window a double click actually lands in. An eviction between the two clicks loses the set
	 * and costs at most a tool run the reader asked for twice.
	 */
	private readonly settling = new Set<string>()

	constructor(
		private readonly ctx: ChatSessionState,
		private readonly env: Record<string, unknown>,
		private readonly applier: ProposalApplier = applyThroughWorker,
	) {
		this.sql = ctx.storage.sql
		this.sql.exec(SCHEMA)
		// Sessions created before the watchdog columns existed (local dev only — the class has
		// never been deployed) would otherwise fail every read against `session`.
		for (const column of ["running_since INTEGER", "running_message_id TEXT"]) {
			try {
				this.sql.exec(`ALTER TABLE session ADD COLUMN ${column}`)
			} catch {
				// Already present.
			}
		}
	}

	/** Highest assigned seq, i.e. the cursor a client that has read everything holds. */
	cursor(): number {
		const row = this.sql.exec<CursorRow>("SELECT MAX(seq) AS seq FROM events").one()
		return row.seq ?? 0
	}

	private sessionRow(): SessionRow {
		return this.sql
			.exec<SessionRow>("SELECT running, running_since, running_message_id FROM session WHERE id = 1")
			.one()
	}

	/**
	 * The message id of the turn that holds the slot *right now*, or `undefined` if none does.
	 *
	 * Expiring a stale claim here rather than in a separate sweep means every caller — `beginTurn`,
	 * the turn's own between-step check — agrees on the answer without needing an alarm to have
	 * fired first.
	 *
	 * One read serves both questions callers ask ("is anything running?" and "is *this* running?").
	 * They used to be separate methods issuing the same SELECT, and `holdsTurn` — called once per
	 * streamed event — paid for both.
	 */
	private runningTurn(): string | undefined | null {
		const row = this.sessionRow()
		if (row.running !== 1) return undefined
		if (row.running_since !== null && Date.now() - row.running_since > TURN_STALE_MS) {
			const messageId = row.running_message_id
			this.clearRunning()
			if (messageId !== null) {
				this.append({
					type: "turn-end",
					messageId,
					reason: "error",
					error: "The turn stopped responding and was abandoned.",
				})
			}
			return undefined
		}
		// `null` means running but with no recorded id — pre-watchdog rows only.
		return row.running_message_id
	}

	private isRunning(): boolean {
		return this.runningTurn() !== undefined
	}

	private clearRunning(): void {
		this.sql.exec(
			"UPDATE session SET running = 0, running_since = NULL, running_message_id = NULL WHERE id = 1",
		)
	}

	/** The message id of the turn currently holding the slot, if any. */
	private runningMessageId(): string | undefined {
		return this.runningTurn() ?? undefined
	}

	/**
	 * Append one event and return the seq it was assigned.
	 *
	 * `RETURNING seq` rather than a following `SELECT MAX(seq)`: this runs once per token delta, and
	 * the second statement was pure overhead in an isolate that is also serving every subscriber.
	 */
	append(event: ChatEventInput): number {
		const row = this.sql
			.exec<CursorRow>(
				"INSERT INTO events (created_at, payload) VALUES (?, ?) RETURNING seq",
				Date.now(),
				encodeChatEventPayload(event),
			)
			.one()
		this.notify()
		return row.seq ?? 0
	}

	/** Wake every parked subscriber. Cheap and unconditional — the list is empty when nobody reads. */
	private notify(): void {
		if (this.waiters.size === 0) return
		const parked = this.waiters
		this.waiters = new Set()
		for (const wake of parked) wake()
	}

	/** Resolve `true` when an event lands, `false` if `timeoutMs` elapses first. */
	private waitForAppend(timeoutMs: number): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			let settled = false
			const wake = () => settle(true)
			const settle = (appended: boolean) => {
				if (settled) return
				settled = true
				resolve(appended)
			}
			this.waiters.add(wake)
			void scheduler.wait(timeoutMs).then(() => {
				this.waiters.delete(wake)
				settle(false)
			})
		})
	}

	/** Every event after `cursor`, oldest first. */
	since(cursor: number): ReadonlyArray<ChatEvent> {
		const rows = this.sql
			.exec<EventRow>(
				"SELECT seq, created_at, payload FROM events WHERE seq > ? ORDER BY seq ASC",
				cursor,
			)
			.toArray()
		return rows.map((row) => decodeChatEventPayload(row.payload, row.seq))
	}

	/**
	 * Replay from `cursor`, then stay open and push every subsequent event as an SSE frame.
	 *
	 * Returning a `ReadableStream` over RPC is the point: the route used to re-enter a `tail` call
	 * per batch, so every *visible* update in the browser cost a Worker→Durable Object round trip.
	 * The DO is pinned at its first-access colo while the SSE Worker runs at the viewer's edge, so
	 * that round trip — not the model — set the pace tokens appeared at. Now the RTT is paid once,
	 * at connect, and bytes flow.
	 *
	 * The stream ends on `turn-end` or after `SUBSCRIBE_IDLE_MS` of silence, both of which the
	 * client already treats as a reconnect point rather than the end of the conversation. Ending on
	 * silence rather than on "nothing pending" is what keeps an idle tab from reconnecting in a
	 * tight loop, and keeps a client that opened the stream just before posting from missing the
	 * turn it was about to start.
	 */
	subscribe(cursor: number): ReadableStream<Uint8Array> {
		const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
		this.ctx.waitUntil(this.pump(writable, cursor))
		return readable
	}

	private async pump(writable: WritableStream<Uint8Array>, cursor: number): Promise<void> {
		const encoder = new TextEncoder()
		const writer = writable.getWriter()
		let position = cursor
		try {
			await writer.write(encoder.encode(RETRY_HINT))
			for (;;) {
				const events = this.since(position)
				for (const event of events) {
					await writer.write(encoder.encode(frameChatEvent(event)))
					position = event.seq
				}
				// Only the *conversation's* turn ending closes the stream. A sub-agent's `turn-end`
				// is tagged with `task` and merely closes its card — treating it as terminal would
				// cut the connection the moment the first delegated search finished, and the rest of
				// the parent's answer would only arrive on the client's next reconnect.
				if (events.some((event) => event.type === "turn-end" && event.task === undefined)) break
				// The idle budget is spent on silence only: a batch that went out resets it, so a
				// long turn streams over one connection instead of being recycled mid-answer.
				if (!(await this.waitForAppend(SUBSCRIBE_IDLE_MS))) break
			}
		} catch {
			// The reader went away, or the stream was already closed. Either way the client resumes
			// from its own cursor, so a dropped subscription costs a reconnect, not the conversation.
		} finally {
			await writer.close().catch(() => undefined)
		}
	}

	/**
	 * Claim the turn slot, record the user's message, and start the turn.
	 *
	 * Returns `undefined` when a turn is already running — the client's composer is disabled during
	 * a turn, but two tabs on the same conversation are one session, so the DO is where that has to
	 * be enforced.
	 *
	 * `tenant` is the caller's *resolved* identity, passed in rather than re-derived here: the DO
	 * has no auth context of its own, and the route has already matched the session's org against
	 * the caller's before it gets this far.
	 */
	beginTurn(input: {
		/** `"<orgId>:<tabId>"`. A DO cannot recover its own name, and the turn needs it for mode. */
		readonly sessionId: string
		readonly messageId: string
		readonly text: string
		readonly tenant: ChatTurnTenantEncoded
		/** Who is driving the turn, stated by whoever raised it. */
		readonly origin: ChatTurnOrigin
	}): { cursor: number; messageId: string; turnMessageId: string } | undefined {
		if (this.isRunning()) return undefined
		const cursor = this.cursor()
		// The assistant's message needs an id of its OWN. Reusing the user's meant `history()` found
		// the user message when opening the assistant one, so every text delta was appended to the
		// user's own bubble — "Say PONG" came back as "Say PONGPING" — and the client folded it the
		// same way, since it keys the optimistic user message on exactly this id.
		const turnId = crypto.randomUUID()
		this.sql.exec(
			"UPDATE session SET running = 1, running_since = ?, running_message_id = ? WHERE id = 1",
			Date.now(),
			turnId,
		)
		this.append({ type: "user-message", id: input.messageId, text: input.text })
		this.liveTurn = turnId
		this.armHeartbeat()
		// `waitUntil` on the DO's own context: the turn is now this object's work, and it outlives
		// whatever request asked for it. `waitUntil` alone does not keep the object in memory — the
		// heartbeat alarm does.
		this.ctx.waitUntil(this.runTurn(input.sessionId, turnId, input.tenant, input.origin))
		return { cursor, messageId: input.messageId, turnMessageId: turnId }
	}

	/**
	 * Apply or decline a mutation the agent proposed, and record the outcome as that call's
	 * `tool-result`.
	 *
	 * By reference: the caller names the call, and the tool's name and arguments come out of this
	 * object's own log. Accepting them from the caller would make this a second way to run a
	 * mutating tool, and the caller is a Worker relaying a click off a chat platform.
	 *
	 * The caller is also who authorized the click: it resolved the workspace, checked that the
	 * control named THIS conversation, and decided whose authority the change runs under —
	 * `actingUserId` when the connector could name the clicker and they had linked, the org-level
	 * connector identity when it could not. Reaching this object at all requires the Durable
	 * Object binding, which only Maple's own Workers hold, and that is the same trust `beginTurn`
	 * already runs on.
	 */
	async settleProposal(input: ChatProposalSettlement): Promise<ChatProposalOutcome> {
		const proposal = this.findProposal(input.toolCallId)
		if (proposal === undefined) return "unknown"
		// Two clicks on one control: the durable half catches the second once the first has written
		// its result, and the in-memory half catches it while the first is still running the tool.
		if (proposal.settled || this.settling.has(input.toolCallId)) return "settled"
		this.settling.add(input.toolCallId)
		try {
			const result =
				input.decision === "deny"
					? {
							output: `Declined by ${input.approver.displayName}. The tool did not run.`,
							isError: true,
						}
					: await this.applyProposal(input, proposal)
			this.append({
				type: "tool-result",
				// The assistant message that issued the proposal: the transcript fold opens a message
				// by id and only then finds the call in it, so anything else leaves the proposal open.
				messageId: proposal.messageId,
				callId: input.toolCallId,
				output: result.output,
				...(result.isError ? { isError: true } : undefined),
			})
			return "decided"
		} finally {
			this.settling.delete(input.toolCallId)
		}
	}

	/** The open proposal with this call id, whether it is still open, and what it asked for. */
	private findProposal(toolCallId: string): Proposal | undefined {
		for (const message of this.history()) {
			for (const call of message.toolCalls) {
				if (call.id !== toolCallId || call.proposed !== true) continue
				return {
					messageId: message.id,
					name: call.name,
					input: call.input,
					settled: "output" in call,
				}
			}
		}
		return undefined
	}

	/**
	 * Run the proposed tool.
	 *
	 * A failure becomes an error result rather than being re-raised: the proposal is settled either
	 * way, because leaving live controls on a mutation that may or may not have run is the worse of
	 * the two — the reader is told it failed and can act in Maple.
	 */
	private async applyProposal(
		settlement: ChatProposalSettlement,
		proposal: Proposal,
	): Promise<AppliedProposal> {
		try {
			return await this.applier({
				env: this.env,
				sessionId: settlement.sessionId,
				approver: settlement.approver,
				...(settlement.actingUserId === undefined
					? undefined
					: { actingUserId: settlement.actingUserId }),
				tool: proposal.name,
				input: proposal.input,
			})
		} catch (cause) {
			console.error("[chat.approval] Failed to apply a proposal", cause)
			return { output: PROPOSAL_FAILED, isError: true }
		}
	}

	/**
	 * Whether `messageId` still holds the slot. The turn calls this between steps so an abort takes
	 * effect promptly, and so a turn that has already been superseded stops writing.
	 */
	holdsTurn(messageId: string): boolean {
		return this.runningTurn() === messageId
	}

	/**
	 * Release the slot, but only if `messageId` still owns it.
	 *
	 * The compare-and-clear matters: an aborted turn keeps draining its in-flight model call for a
	 * while, and a plain `running = 0` from that straggler would release a *newer* turn's claim.
	 */
	endTurn(messageId: string): void {
		if (this.runningMessageId() !== messageId) return
		this.clearRunning()
	}

	/**
	 * Abort the running turn.
	 *
	 * The DO cannot synchronously cancel the fiber, so it clears the claim and records the terminal
	 * event against the message that actually holds it — the turn notices via `holdsTurn` at its
	 * next step and stops. Taking the message id from the session rather than the caller is what
	 * makes the emitted `turn-end` land on the assistant message the client is rendering; a
	 * caller-supplied id named a message that never existed, so no client ever cleared its
	 * streaming state.
	 */
	abort(): void {
		const messageId = this.runningTurn()
		if (messageId === undefined) return
		this.clearRunning()
		if (messageId !== null) {
			this.append({ type: "turn-end", messageId, reason: "aborted" })
		}
	}

	running(): boolean {
		return this.isRunning()
	}

	/**
	 * The heartbeat. Re-arms while this activation runs the turn that holds the slot.
	 *
	 * A slot held by a turn this activation is not running means the object was evicted mid-turn (a
	 * deploy, or eviction before the heartbeat existed): the fiber is gone, so the slot is released
	 * with a terminal event now rather than when the 15-minute watchdog expires it.
	 */
	alarm(): void {
		const messageId = this.runningTurn()
		if (messageId === undefined) return
		if (messageId !== null && this.liveTurn !== messageId) {
			this.clearRunning()
			this.append({ type: "turn-end", messageId, reason: "error", error: CHAT_TURN_FAILED })
			return
		}
		this.armHeartbeat()
	}

	private armHeartbeat(): void {
		this.ctx.waitUntil(this.ctx.storage.setAlarm(Date.now() + TURN_HEARTBEAT_MS).catch(() => undefined))
	}

	/**
	 * Drive one turn to completion, appending events as they are produced.
	 *
	 * Everything heavy — the Effect runtime, the service graph, the agent engine — is behind this
	 * dynamic import so none of it is evaluated at module scope. Failures are recorded as a
	 * terminal event rather than thrown: the log is what the client reads, so a turn that dies
	 * silently is indistinguishable from one that hung.
	 */
	private async runTurn(
		sessionId: string,
		messageId: string,
		tenant: ChatTurnTenantEncoded,
		origin: ChatTurnOrigin,
	): Promise<void> {
		try {
			const { runChatSessionTurn } = await import("./turn-runner")
			await runChatSessionTurn({
				session: this,
				sessionId,
				env: this.env,
				messageId,
				tenant,
				origin,
			})
		} catch (cause) {
			console.error("[chat.turn] Failed to start turn runner", cause)
			if (this.holdsTurn(messageId)) {
				this.append({
					type: "turn-end",
					messageId,
					reason: "error",
					error: CHAT_TURN_FAILED,
				})
			}
		} finally {
			if (this.liveTurn === messageId) this.liveTurn = undefined
			this.endTurn(messageId)
		}
	}

	/**
	 * Replay the whole log into a transcript.
	 *
	 * The fold itself is `@maple/domain/chat-transcript`, so a consumer tailing `subscribe` builds
	 * the same messages out of the same events. Only `createdAt` differs: the row's stored time
	 * here, receive time for a tail, because a `ChatEvent` carries no timestamp of its own.
	 */
	history(): ReadonlyArray<ChatMessage> {
		const transcript = makeChatTranscript()
		const rows = this.sql
			.exec<EventRow>("SELECT seq, created_at, payload FROM events ORDER BY seq ASC")
			.toArray()

		for (const row of rows) {
			transcript.add(decodeChatEventPayload(row.payload, row.seq), row.created_at)
		}

		return transcript.messages
	}
}

/** The stub's surface with each method's Promise lifted to the Effect alchemy runs per RPC call. */
type EffectRpc<Stub> = {
	readonly [K in keyof Stub]: Stub[K] extends (...args: infer Args) => Promise<infer Result>
		? (...args: Args) => Effect.Effect<Result>
		: never
}

/** The RPC surface plus the heartbeat alarm, which alchemy's bridge dispatches as the object's `alarm`. */
type ChatSessionObjectApi = EffectRpc<ChatSessionStub> & { readonly alarm: () => Effect.Effect<void> }

/**
 * The session's methods, one Effect each. alchemy runs the Effect per RPC call and hands its value
 * back as-is — a `ReadableStream` included, which Workers RPC carries by reference — so
 * `ChatSessionStub` stays what a caller sees.
 */
export const chatSessionRpc = (session: ChatSession) =>
	({
		cursor: () => Effect.sync(() => session.cursor()),
		running: () => Effect.sync(() => session.running()),
		history: () => Effect.sync(() => session.history()),
		since: (cursor) => Effect.sync(() => session.since(cursor)),
		subscribe: (cursor) => Effect.sync(() => session.subscribe(cursor)),
		append: (event) => Effect.sync(() => session.append(event)),
		beginTurn: (input) => Effect.sync(() => session.beginTurn(input)),
		settleProposal: (input) => Effect.promise(() => session.settleProposal(input)),
		holdsTurn: (messageId) => Effect.sync(() => session.holdsTurn(messageId)),
		endTurn: (messageId) => Effect.sync(() => session.endTurn(messageId)),
		abort: () => Effect.sync(() => session.abort()),
		alarm: () => Effect.sync(() => session.alarm()),
	}) satisfies ChatSessionObjectApi

/**
 * One activation, in alchemy's two phases: the outer Effect resolves the state and env (it also
 * runs at plan time, against a mock state, so it must not touch storage), the inner one builds the
 * session inside the object's `blockConcurrencyWhile` — the schema statements have run before the
 * first call reaches it, hibernation wakes included.
 */
export const activateChatSession = Effect.map(
	Effect.all([Cloudflare.DurableObjectState, Cloudflare.WorkerEnvironment]),
	([state, env]) => Effect.sync(() => chatSessionRpc(new ChatSession(state.raw, env))),
)

/**
 * The Durable Object: one per `"<orgId>:<tabId>"`, SQLite-backed, hosted by this Worker and bound
 * as `ChatSession` — the name `chatSessionStub` reads off `env` on both sides.
 *
 * `transferredFrom` names apps/api, which hosted this class until the agent surfaces moved here.
 * Alchemy turns that into a data-preserving `transferred_classes` migration, so live transcripts
 * follow the class rather than being stranded in a namespace nothing binds any more. Without it
 * the api's own deploy fails with `DurableObjectTransferRequired`, because dropping a locally
 * hosted class while keeping a cross-script reference to it is exactly the shape that silently
 * destroys a namespace, and alchemy refuses it before any upload.
 *
 * It is inert once every stage has transferred — a fresh stage creates the class outright — so it
 * stays here rather than being cleaned up later and breaking whichever stage lagged behind.
 *
 * The props-carrying class form is what makes room for that: the single-argument overload takes an
 * implementation and no props, so the implementation moves to `ChatSessionLive` below.
 */
export class ChatSessionObject extends Cloudflare.DurableObject<ChatSessionObject, ChatSessionObjectApi>()(
	"ChatSession",
	{ transferredFrom: "api" },
) {}

/** The activation, as the layer the host Worker provides. */
// The activation's requirements are named rather than inferred: `.make` discharges
// `DurableObjectServices` (both of these) through its own `Exclude`, while inference
// would widen them into the layer's requirements and surface them all the way up in
// `alchemy.run.ts`.
export const ChatSessionLive = ChatSessionObject.make<
	Cloudflare.DurableObjectState | Cloudflare.WorkerEnvironment
>(activateChatSession)
