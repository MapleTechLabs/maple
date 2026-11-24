# App Privacy answers

App Store Connect → App Privacy. Matches `Maple/Resources/PrivacyInfo.xcprivacy`.

**Do you or your third-party partners collect data from this app?** Yes.

**Tracking:** No data is used to track. The app has no ads, no ad SDKs and no
IDFA, so no App Tracking Transparency prompt.

Every type below: **Linked to the user: Yes. Used for tracking: No.**

| Category           | Type                     | Purposes                         | Why                                                                 |
| ------------------ | ------------------------ | -------------------------------- | ------------------------------------------------------------------- |
| Contact Info       | Name                     | App Functionality                | Clerk account profile                                               |
| Contact Info       | Email Address            | App Functionality                | Clerk sign-in                                                       |
| Identifiers        | User ID                  | App Functionality                | Clerk user id, organization membership                              |
| Identifiers        | Device ID                | App Functionality                | APNs push token, widget device credential (installation id)         |
| Usage Data         | Product Interaction      | Analytics                        | Screen views and taps recorded by the Maple SDK                     |
| Diagnostics        | Crash Data               | App Functionality, Analytics     | Crash reports from the Maple SDK                                    |
| Diagnostics        | Performance Data         | App Functionality, Analytics     | Launch and request traces                                           |
| Diagnostics        | Other Diagnostic Data    | App Functionality, Analytics     | Session replay frames (screens of the app, including the org's data) |

Not collected: location, contacts, health, financial info, photos, audio,
browsing or search history (in-app search terms only go to Maple's API to run
the search and are not stored for analytics), purchases, sensitive info.

Data goes to Maple's own infrastructure and to Clerk (authentication). Neither
is shared with advertisers or data brokers.
