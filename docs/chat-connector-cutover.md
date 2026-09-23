# Cutting over from the standalone chat agent

`apps/slack-agent` is the bot Maple has been running: its own Railway service, its own app, its own
event URL. The chat-platform connector in `packages/chat-platform/src/connectors/slack/` replaces
it, on Cloudflare, behind the same `ChatConnector` contract every other platform uses.

This is the ops runbook for running both at once and then retiring the old one. It is not a
migration: there is nothing to move. The two have separate applications, separate tables and
separate credentials, so the cutover is "stop pointing at one, start pointing at the other", and the
rollback is the same sentence backwards.

**Deleting `apps/slack-agent` is not part of the connector's own change.** It is step 7 here, after
step 6 has held.

## Why they can run side by side

| | the standalone agent | the connector |
| --- | --- | --- |
| Where it runs | Railway | `apps/chat-bot` (Cloudflare) |
| Which app | its own | a new one — see the connector's README |
| Event URL | its own host | `https://chat.maple.dev/connectors/slack/webhook` |
| Workspace ↔ org | its own store | `chat_workspaces`, one row per linked workspace |
| Credentials | its own | `chat_workspaces.credentials_*`, sealed per workspace |

Nothing is shared, so both can be installed in the same workspace at the same time. They will both
answer a mention — which is the point of step 3, and the reason the cutover itself is one switch.

Note the third, unrelated thing also called Slack here: the alert-delivery integration
(`slack_workspaces`, `SlackIntegrationService`) is a fourth application again, is not part of this
cutover, and keeps running throughout.

## The cutover

1. **Create the new application and put its secrets on the deployments.** The connector's README has
   the app manifest and the three secrets — client id and secret on api, signing secret on chat-bot
   — plus `MAPLE_INGEST_KEY_ENCRYPTION_KEY` on chat-bot, which is what opens the per-workspace token.

2. **Deploy.** `apps/chat-bot` takes `chat.maple.dev` on production instances; a dev stage reaches
   the same route through portless and a PR preview gets no hostname. Check
   `https://chat.maple.dev/connectors/slack/webhook` answers **503** before the secrets land and
   **400** after (an unsigned request is a rejected request — a 404 means the connector is not in
   this build, and a 200 means something is very wrong).

3. **Install it into one workspace and run the smoke checklist**, with the old agent still running.
   This is where the facts that only a live install can confirm get confirmed:

    - saving the request URL succeeds (that is the `url_verification` handshake);
    - **a top-level mention** in a public channel is answered in a thread on that message;
    - **a mention inside an existing thread** is answered in that same thread — and lands on the
      same session as the first question, not a new one;
    - **a reply in the bot's thread without a mention** is answered, and the answer shows the bot
      read the messages above it — the thread is one the bot opened, which is what makes an
      un-addressed message in it still a turn;
    - **an un-addressed message in a channel the bot was merely invited to** is NOT answered;
    - **an approval card** renders with both buttons, pressing one applies the change, and the
      card then keeps its line and loses its buttons;
    - **the identity check**, which is what would let Slack approvals run as the person rather than
      as the org: sign the same user in through Slack's OpenID Connect flow and compare the `sub`
      it returns against the `user.id` on their `block_actions` payload. If they match, the
      connector's `identity` can be implemented (see its README); nothing depends on the answer
      today, so this is evidence-gathering rather than a gate;
    - **a private channel, a DM and a group DM** each behave like the public channel;
    - **formatting**: a turn with bold, italics, a link, a bullet list, a blockquote, a table and a
      code block is readable — the table arrives as a fenced block, and nothing renders as raw
      markdown;
    - **nothing pages the workspace**: ask the bot to repeat `<!channel>` and `[urgent](!channel)`
      back, and confirm neither notifies anybody;
    - **removing the app** from the workspace unlinks its row (`app_uninstalled` →
      `workspace-removed`);
    - **no token anywhere**: grep the deploy's logs and spans for `xoxb-` and find nothing.

4. **Install and verify the connector in EVERY workspace the old app is in**, not just the one from
   step 3. Step 5 is app-wide and cannot be done per workspace, so a workspace still on the old
   agent when it runs simply loses its bot. `chat_workspaces` is the list of what has been linked;
   the old application's own install list is what it has to be checked against.

5. **Turn the old app's event subscriptions OFF.** In the OLD application's configuration, disable
   Event Subscriptions — do not point the request URL at something that fails. Slack retries a
   delivery its endpoint rejects and **disables an app's subscriptions after enough of them**, so
   an intentionally broken URL ends in the same place as switching them off, except that it gets
   there by itself, at a time nobody chose, and re-entering the URL afterwards does not bring
   delivery back until an operator re-enables the subscriptions by hand.

   This is **app-wide**: Slack applies a subscription change across every team the app is installed
   in, which is why step 4 comes first. The Railway agent keeps running and keeps its own
   configuration; it simply stops being sent anything, everywhere, at once.

6. **Let it sit.** A week of real use is enough to find what a checklist does not. If the connector
   has to be backed out, re-enable the old app's event subscriptions — the old agent has been
   running untouched the whole time, and its request URL never moved.

7. **Retire the old agent**, in this order: uninstall the old application from every workspace, stop
   the Railway service, then delete `apps/slack-agent` and its deploy configuration in a change of
   its own.

## What each rollback costs

| Step reached | To undo |
| --- | --- |
| 2 | Nothing is live; remove the secrets or leave them, the connector is skipped without them. |
| 3 | Uninstall the new app from the workspace; its `chat_workspaces` row goes with it. |
| 4 | Same, for each workspace. The old app is still serving all of them. |
| 5 | Re-enable the old app's event subscriptions — app-wide, so every workspace comes back together. |
| 6 | Same. |
| 7 | The old agent is gone — from here, forward only. |
