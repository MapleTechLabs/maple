# Cutting over from the standalone chat agent

`apps/slack-agent` is the bot Maple has been running: its own Railway service, its own app, its own
event URL. The chat-platform connector in `packages/chat-platform/src/connectors/slack/` replaces
it, on Cloudflare, behind the same `ChatConnector` contract every other platform uses.

This is the ops runbook for running both at once and then retiring the old one. It is not a
migration: there is nothing to move. The two have separate applications, separate tables and
separate credentials, so the cutover is "stop pointing at one, start pointing at the other", and the
rollback is the same sentence backwards.

**Deleting `apps/slack-agent` is not part of the connector's own change.** It is step 6 here, after
step 5 has held.

## Why they can run side by side

| | the standalone agent | the connector |
| --- | --- | --- |
| Where it runs | Railway | `apps/chat-bot` (Cloudflare) |
| Which app | its own | a new one — see the connector's README |
| Event URL | its own host | `https://chat.maple.dev/connectors/slack/webhook` |
| Workspace ↔ org | its own store | `chat_workspaces`, one row per linked workspace |
| Credentials | its own | `chat_workspaces.credentials_*`, sealed per workspace |

Nothing is shared, so both can be installed in the same workspace at the same time. They will both
answer a mention — which is the point of step 3, and the reason step 4 is short.

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
    - **an approval card** renders with both buttons, and pressing one produces
      `maple.chat.event = action` — whatever the approval flow then does with it;
    - **a private channel, a DM and a group DM** each behave like the public channel;
    - **formatting**: a turn with bold, italics, a link, a bullet list, a blockquote, a table and a
      code block is readable — the table arrives as a fenced block, and nothing renders as raw
      markdown;
    - **nothing pages the workspace**: ask the bot to repeat `<!channel>` and `[urgent](!channel)`
      back, and confirm neither notifies anybody;
    - **removing the app** from the workspace unlinks its row (`app_uninstalled` →
      `workspace-removed`);
    - **no token anywhere**: grep the deploy's logs and spans for `xoxb-` and find nothing.

4. **Point the old app's event URL at nothing.** In the OLD application's configuration, clear or
   invalidate the Events request URL. That stops the Railway agent answering without touching
   anything it runs, and it is one field to put back if step 5 goes badly.

5. **Let it sit.** A week of real use is enough to find what a checklist does not. If the connector
   has to be backed out, restore the old app's request URL — the old agent has been running
   untouched the whole time.

6. **Retire the old agent**, in this order: uninstall the old application from every workspace, stop
   the Railway service, then delete `apps/slack-agent` and its deploy configuration in a change of
   its own.

## What each rollback costs

| Step reached | To undo |
| --- | --- |
| 2 | Nothing is live; remove the secrets or leave them, the connector is skipped without them. |
| 3 | Uninstall the new app from the workspace; its `chat_workspaces` row goes with it. |
| 4 | Restore the old app's request URL. |
| 5 | Same. |
| 6 | The old agent is gone — from here, forward only. |
