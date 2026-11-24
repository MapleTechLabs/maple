# App Review information

App Store Connect → the version → App Review Information.

**Sign-in required:** Yes.

Set in App Store Connect (demo account, contact and the notes below).

**Contact:** a person who can answer during review (first name, last name,
phone, email).

**Notes** (paste as is, fill the two placeholders):

> Maple is the mobile client for the Maple observability platform (maple.dev), used by software teams to watch the health of their production systems. The app shows data that a team's own services send to Maple; it creates no content of its own.
>
> Demo account: sign in with the email and password above (choose "Continue" with email, then enter the password). The account belongs to an organization with sample services, alerts, errors and traces, so every tab has data.
>
> Things to try:
> - Overview: the current state of production.
> - Services → any service: health verdict and charts.
> - Triage: incidents, errors and anomalies; open one for its detail.
> - Explore: traces, logs and dashboards.
> - The bell icon on Overview: notification settings. Push notifications and the Lock Screen Live Activity are sent when an alert fires in the organization.
> - The avatar at the top right of any tab: account page with privacy policy, terms, support, sign out and Delete account.
>
> Account deletion: Account (avatar) → Delete account → type DELETE. This permanently deletes the user.
>
> The app has no purchases. Accounts and organizations are created on the web at maple.dev; the app is free and unlocks nothing that is paid for elsewhere.
>
> Background modes: "remote-notification" refreshes the Home Screen widget when an alert push arrives, and "fetch" refreshes it periodically.

## The demo account (to do before submitting)

App Review needs a production account that lands on real data. A fresh sign-up
stops at "No organizations", which reviewers reject as incomplete.

1. Create a user on the production Clerk instance with email + password (not
   Google or GitHub, and no email code), e.g. `appreview@maple.dev`.
2. Add it as a member (or analyst) of an organization that receives steady
   telemetry with at least one alert rule, so Triage is not empty.
3. Turn off MFA for that user, and make sure Clerk does not ask it for an email code on a new device (Client Trust). Sign in once on a fresh simulator to confirm.
4. Put the credentials in the fields above, not in the notes.
