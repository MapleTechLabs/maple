//! Audit events from provider feeds as rows of `audit_trail_events`, the table
//! behind the Security hub's audit log. They are written here, never as OTLP
//! logs: a log can be sent by anything holding an ingest key and read by every
//! member, and an audit record must be neither.
//!
//! The row shape and the id derivation mirror the TypeScript writer
//! (`packages/backend/src/services/audit-trail/audit-trail-row.ts`). The two
//! must agree: an event a provider redelivers has to land on the same key.

use crate::vercel_logs::text;
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use sha2::{Digest, Sha256};

type JsonObject = JsonMap<String, JsonValue>;

pub const DATASOURCE: &str = "audit_trail_events";

/// Above any ingest time in ms, so `Version` stays positive and falls as time
/// rises: the table keeps the highest version, which is the first write.
const VERSION_CEILING_MS: i64 = 9_999_999_999_999;

/// A payload larger than this is stored as the fields the row was built from.
const RAW_LIMIT_BYTES: usize = 32 * 1024;

/// One audit event, normalized. Empty strings are absent values.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct AuditEvent {
    pub provider: &'static str,
    pub account: String,
    pub provider_event_id: String,
    pub occurred_at_ms: i64,
    pub actor_type: &'static str,
    pub actor_id: String,
    pub actor_name: String,
    pub actor_email: String,
    pub action: String,
    pub category: &'static str,
    pub outcome: &'static str,
    pub outcome_reason: String,
    pub target_type: String,
    pub target_id: String,
    pub target_name: String,
    pub origin_ip: String,
    pub user_agent: String,
    pub raw: String,
}

/// The row's key: the first 32 hex characters of sha256 over
/// `provider\naccount\neventId`.
pub fn event_id(provider: &str, account: &str, provider_event_id: &str) -> String {
    sha256_prefix(format!("{provider}\n{account}\n{provider_event_id}").as_bytes())
}

const HEX_DIGITS: &[u8; 16] = b"0123456789abcdef";

/// The first 16 bytes of a sha256, as 32 hex characters.
fn sha256_prefix(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(32);
    for byte in &digest[..16] {
        hex.push(char::from(HEX_DIGITS[usize::from(byte >> 4)]));
        hex.push(char::from(HEX_DIGITS[usize::from(byte & 0x0f)]));
    }
    hex
}

/// `YYYY-MM-DD HH:MM:SS.mmm` in UTC, the form the warehouse's DateTime64(3) takes.
fn warehouse_datetime(epoch_ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(epoch_ms)
        .unwrap_or_default()
        .format("%Y-%m-%d %H:%M:%S%.3f")
        .to_string()
}

impl AuditEvent {
    /// The event as one NDJSON row for `org_id`, stored at `ingested_at_ms`.
    pub fn to_row(&self, org_id: &str, ingested_at_ms: i64) -> Vec<u8> {
        json!({
            "OrgId": org_id,
            "Id": event_id(self.provider, &self.account, &self.provider_event_id),
            "OccurredAt": warehouse_datetime(self.occurred_at_ms),
            "IngestedAt": warehouse_datetime(ingested_at_ms),
            "Provider": self.provider,
            "Account": self.account,
            "ProviderEventId": self.provider_event_id,
            "ActorType": self.actor_type,
            "ActorId": self.actor_id,
            "ActorName": self.actor_name,
            "ActorEmail": self.actor_email,
            "Action": self.action,
            "Category": self.category,
            "Outcome": self.outcome,
            "OutcomeReason": self.outcome_reason,
            "TargetType": self.target_type,
            "TargetId": self.target_id,
            "TargetName": self.target_name,
            "OriginIp": self.origin_ip,
            "OriginCountry": "",
            "UserAgent": self.user_agent,
            "Raw": self.raw,
            "Version": VERSION_CEILING_MS - ingested_at_ms,
        })
        .to_string()
        .into_bytes()
    }
}

fn owned(value: Option<&str>) -> String {
    value.unwrap_or_default().to_owned()
}

fn object<'a>(parent: &'a JsonObject, key: &str) -> Option<&'a JsonObject> {
    parent.get(key)?.as_object()
}

/// The payload as JSON text, or `summary` when the payload is too large to keep.
fn raw_of(payload: &JsonObject, summary: impl FnOnce() -> JsonValue) -> String {
    let full = JsonValue::Object(payload.clone()).to_string();
    if full.len() <= RAW_LIMIT_BYTES {
        full
    } else {
        summary().to_string()
    }
}

/// A key for an event the provider gave no id: the same payload is the same event.
fn content_id(payload: &JsonObject) -> String {
    sha256_prefix(JsonValue::Object(payload.clone()).to_string().as_bytes())
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

/// What a Vercel action is about, read off its name. Vercel publishes no closed
/// list, so this is by the words the names use; anything unrecognised is a
/// change to a resource.
fn vercel_category(action: &str) -> &'static str {
    let action = action.to_ascii_lowercase();
    if contains_any(
        &action,
        &["login", "logout", "sso", "saml", "mfa", "2fa", "passkey"],
    ) {
        "authentication"
    } else if contains_any(
        &action,
        &["token", "secret", "env", "certificate", "password", "key"],
    ) {
        "credential"
    } else if contains_any(&action, &["member", "invite", "join", "leave"]) {
        "membership"
    } else if contains_any(
        &action,
        &["role", "permission", "access-group", "access_group", "acl"],
    ) {
        "permission"
    } else if contains_any(
        &action,
        &["billing", "invoice", "payment", "plan", "subscription"],
    ) {
        "billing"
    } else if contains_any(
        &action,
        &[
            "setting",
            "drain",
            "integration",
            "webhook",
            "firewall",
            "config",
            "protection",
        ],
    ) {
        "configuration"
    } else {
        "resource"
    }
}

/// One event of Vercel's Audit Log drain. `None` for an event with no action:
/// there is nothing to say happened.
pub fn vercel_event(event: &JsonObject, now_ms: i64) -> Option<AuditEvent> {
    let action = text(event, "action")?;
    let actor = object(event, "actor");
    let actor_text = |key: &str| owned(actor.and_then(|actor| text(actor, key)));
    let actor_type = match actor.and_then(|actor| text(actor, "type")) {
        Some("user") => "user",
        Some("system") => "system",
        Some(_) => "service",
        None => "unknown",
    };
    // Epoch milliseconds, whole in practice; a fractional one is cut to its millisecond.
    #[expect(
        clippy::cast_possible_truncation,
        reason = "a finite positive epoch-ms value is far inside i64"
    )]
    let occurred_at_ms = event
        .get("timestamp")
        .and_then(JsonValue::as_f64)
        .filter(|ms| ms.is_finite() && *ms > 0.0)
        .map_or(now_ms, |ms| ms.trunc() as i64);
    Some(AuditEvent {
        provider: "vercel",
        account: owned(text(event, "teamId")),
        provider_event_id: text(event, "id").map_or_else(|| content_id(event), str::to_owned),
        occurred_at_ms,
        actor_type,
        actor_id: actor_text("id"),
        actor_name: actor_text("name"),
        actor_email: actor_text("email"),
        action: action.to_owned(),
        category: vercel_category(action),
        // The drain reports what was done; Vercel does not log refused attempts in it.
        outcome: "success",
        origin_ip: owned(text(event, "ipAddress")),
        user_agent: owned(text(event, "userAgent")),
        raw: raw_of(
            event,
            || json!({ "id": event.get("id"), "action": action, "actor": event.get("actor") }),
        ),
        ..AuditEvent::default()
    })
}

/// Which of Google's audit logs an entry is from, by its `logName`.
fn gcp_audit_log(log_name: &str) -> Option<&'static str> {
    let (_, log) = log_name.rsplit_once("/logs/")?;
    match log.replace("%2F", "/").as_str() {
        "cloudaudit.googleapis.com/activity" => Some("activity"),
        "cloudaudit.googleapis.com/policy" => Some("policy"),
        _ => None,
    }
}

/// What a Google API call is about, read off its service and method.
fn gcp_category(service: &str, method: &str) -> &'static str {
    let method_lower = method.to_ascii_lowercase();
    if contains_any(&method_lower, &["setiampolicy", "testiampermissions"])
        || (service == "iam.googleapis.com" && contains_any(&method_lower, &["role", "policy"]))
    {
        "permission"
    } else if contains_any(
        &method_lower,
        &["serviceaccountkey", "createkey", "deletekey"],
    ) || contains_any(service, &["secretmanager", "apikeys", "cloudkms"])
    {
        "credential"
    } else if contains_any(service, &["cloudbilling", "billingbudgets"]) {
        "billing"
    } else if contains_any(&method_lower, &["login", "signin"]) {
        "authentication"
    } else {
        "resource"
    }
}

/// gRPC status codes Google uses for a refusal: PERMISSION_DENIED and UNAUTHENTICATED.
const GCP_DENIED_CODES: [i64; 2] = [7, 16];

/// A Cloud Logging entry from the Admin Activity or Policy Denied audit log.
/// `None` for every other entry, System Event included: those are Google's own
/// actions on a workload and stay with its logs.
pub fn gcp_entry(entry: &JsonObject, now_ms: i64) -> Option<AuditEvent> {
    let log_name = text(entry, "logName")?;
    let log = gcp_audit_log(log_name)?;
    let payload = object(entry, "protoPayload")?;
    let method = text(payload, "methodName")?;
    let service = text(payload, "serviceName").unwrap_or_default();

    let principal = object(payload, "authenticationInfo")
        .and_then(|info| text(info, "principalEmail"))
        .unwrap_or_default();
    let actor_type = if principal.is_empty() {
        "unknown"
    } else if principal.ends_with("gserviceaccount.com") {
        "service"
    } else {
        "user"
    };

    let status = object(payload, "status");
    let code = status
        .and_then(|status| status.get("code"))
        .and_then(JsonValue::as_i64)
        .unwrap_or(0);
    let outcome = if log == "policy" || GCP_DENIED_CODES.contains(&code) {
        "denied"
    } else if code == 0 {
        "success"
    } else {
        "failure"
    };

    let resource = object(entry, "resource");
    let project = resource
        .and_then(|resource| object(resource, "labels"))
        .and_then(|labels| text(labels, "project_id"));
    // `projects/<id>/logs/...`, or a folder's or organization's own log.
    let account = project.map_or_else(
        || {
            log_name
                .split("/logs/")
                .next()
                .unwrap_or_default()
                .to_owned()
        },
        str::to_owned,
    );
    let request = object(payload, "requestMetadata");
    let occurred_at_ms = text(entry, "timestamp")
        .and_then(|timestamp| DateTime::parse_from_rfc3339(timestamp).ok())
        .map_or(now_ms, |timestamp| timestamp.timestamp_millis());

    Some(AuditEvent {
        provider: "gcp",
        account,
        provider_event_id: text(entry, "insertId").map_or_else(|| content_id(entry), str::to_owned),
        occurred_at_ms,
        actor_type,
        actor_id: principal.to_owned(),
        actor_email: principal.to_owned(),
        action: method.to_owned(),
        category: if log == "policy" {
            "permission"
        } else {
            gcp_category(service, method)
        },
        outcome,
        outcome_reason: owned(status.and_then(|status| text(status, "message"))),
        target_type: owned(resource.and_then(|resource| text(resource, "type"))),
        target_name: owned(text(payload, "resourceName")),
        origin_ip: owned(request.and_then(|request| text(request, "callerIp"))),
        user_agent: owned(request.and_then(|request| text(request, "callerSuppliedUserAgent"))),
        raw: raw_of(entry, || {
            json!({
                "logName": log_name,
                "insertId": entry.get("insertId"),
                "timestamp": entry.get("timestamp"),
                "protoPayload": {
                    "serviceName": service,
                    "methodName": method,
                    "resourceName": payload.get("resourceName"),
                    "authenticationInfo": payload.get("authenticationInfo"),
                    "status": payload.get("status"),
                    "requestMetadata": payload.get("requestMetadata"),
                },
            })
        }),
        ..AuditEvent::default()
    })
}

/// Now, as the warehouse and this module count it.
pub fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// An RFC 3339 instant for a row, for tests and logs.
pub fn iso(epoch_ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(epoch_ms)
        .unwrap_or_default()
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_700_000_060_000;

    fn parse(json: &str) -> JsonObject {
        serde_json::from_str(json).expect("fixture is a JSON object")
    }

    fn row(event: &AuditEvent) -> JsonObject {
        serde_json::from_slice(&event.to_row("org_1", NOW)).expect("a row is a JSON object")
    }

    // The TypeScript writer derives the same key (`auditTrailEventId`); these two
    // vectors are asserted there as well. A provider that moved between the two
    // writers would otherwise stop collapsing its redeliveries.
    #[test]
    fn the_row_key_matches_the_typescript_writer() {
        assert_eq!(
            event_id("maple", "", "evt_1"),
            "851ca0eff076aad987a0192777b176cd"
        );
        assert_eq!(event_id("maple", "acme", "evt_1").len(), 32);
        assert_ne!(
            event_id("maple", "acme", "evt_1"),
            event_id("maple", "", "evt_1")
        );
    }

    const VERCEL_EVENT: &str = r#"{"schema":"vercel.audit_log.v1","id":"evt_1","teamId":"team_1","action":"project.env-var.created","timestamp":1700000000123,"ipAddress":"203.0.113.7","userAgent":"Mozilla/5.0","actor":{"type":"user","id":"usr_1","name":"Ada","email":"ada@acme.test"},"payload":{"projectId":"prj_1"}}"#;

    #[test]
    fn a_vercel_event_becomes_a_row_with_its_actor_action_and_origin() {
        let event = vercel_event(&parse(VERCEL_EVENT), NOW).expect("an event with an action");
        let row = row(&event);

        assert_eq!(row["OrgId"], "org_1");
        assert_eq!(row["Provider"], "vercel");
        assert_eq!(row["Account"], "team_1");
        assert_eq!(row["ProviderEventId"], "evt_1");
        assert_eq!(row["Id"], event_id("vercel", "team_1", "evt_1"));
        assert_eq!(row["OccurredAt"], "2023-11-14 22:13:20.123");
        assert_eq!(row["IngestedAt"], "2023-11-14 22:14:20.000");
        assert_eq!(row["ActorType"], "user");
        assert_eq!(row["ActorEmail"], "ada@acme.test");
        assert_eq!(row["Action"], "project.env-var.created");
        assert_eq!(row["Category"], "credential");
        assert_eq!(row["Outcome"], "success");
        assert_eq!(row["OriginIp"], "203.0.113.7");
        assert_eq!(row["TargetType"], "");
        assert!(row["Raw"].as_str().is_some_and(|raw| raw.contains("prj_1")));
    }

    // The table keeps the highest version: a redelivery must lose to the first write.
    #[test]
    fn a_later_write_of_the_same_event_has_the_same_key_and_a_lower_version() {
        let event = vercel_event(&parse(VERCEL_EVENT), NOW).expect("an event with an action");
        let first: JsonObject = serde_json::from_slice(&event.to_row("org_1", NOW)).unwrap();
        let later: JsonObject =
            serde_json::from_slice(&event.to_row("org_1", NOW + 60_000)).unwrap();

        assert_eq!(first["Id"], later["Id"]);
        assert!(later["Version"].as_i64() < first["Version"].as_i64());
    }

    #[test]
    fn a_vercel_event_without_an_id_keys_on_its_content_and_one_without_an_action_is_skipped() {
        let no_id =
            parse(r#"{"teamId":"team_1","action":"drain-created","timestamp":1700000000000}"#);
        let first = vercel_event(&no_id, NOW).expect("an event with an action");
        let again = vercel_event(&no_id, NOW + 5).expect("an event with an action");

        assert!(!first.provider_event_id.is_empty());
        assert_eq!(first.provider_event_id, again.provider_event_id);
        assert_eq!(first.category, "configuration");
        assert_eq!(first.actor_type, "unknown");
        assert_eq!(vercel_event(&parse(r#"{"id":"evt_2"}"#), NOW), None);
    }

    const GCP_ACTIVITY: &str = r#"{"logName":"projects/acme-prod/logs/cloudaudit.googleapis.com%2Factivity","insertId":"abc123","timestamp":"2023-11-14T22:13:20.123Z","resource":{"type":"service_account","labels":{"project_id":"acme-prod"}},"protoPayload":{"serviceName":"iam.googleapis.com","methodName":"google.iam.admin.v1.CreateServiceAccountKey","resourceName":"projects/-/serviceAccounts/123","authenticationInfo":{"principalEmail":"ada@acme.test"},"requestMetadata":{"callerIp":"203.0.113.7","callerSuppliedUserAgent":"gcloud"}}}"#;

    #[test]
    fn an_admin_activity_entry_becomes_a_row() {
        let event = gcp_entry(&parse(GCP_ACTIVITY), NOW).expect("an Admin Activity entry");
        let row = row(&event);

        assert_eq!(row["Provider"], "gcp");
        assert_eq!(row["Account"], "acme-prod");
        assert_eq!(row["ProviderEventId"], "abc123");
        assert_eq!(row["OccurredAt"], "2023-11-14 22:13:20.123");
        assert_eq!(row["ActorType"], "user");
        assert_eq!(row["ActorEmail"], "ada@acme.test");
        assert_eq!(row["Action"], "google.iam.admin.v1.CreateServiceAccountKey");
        assert_eq!(row["Category"], "credential");
        assert_eq!(row["Outcome"], "success");
        assert_eq!(row["TargetType"], "service_account");
        assert_eq!(row["TargetName"], "projects/-/serviceAccounts/123");
        assert_eq!(row["OriginIp"], "203.0.113.7");
        assert_eq!(row["UserAgent"], "gcloud");
    }

    #[test]
    fn a_refused_call_is_denied_with_its_reason_and_a_service_account_is_a_service() {
        let mut entry = parse(GCP_ACTIVITY);
        let payload = entry["protoPayload"].as_object_mut().unwrap();
        payload.insert(
            "status".into(),
            json!({ "code": 7, "message": "Permission iam.serviceAccountKeys.create denied" }),
        );
        payload.insert(
            "authenticationInfo".into(),
            json!({ "principalEmail": "ci@acme-prod.iam.gserviceaccount.com" }),
        );
        let event = gcp_entry(&entry, NOW).expect("an Admin Activity entry");

        assert_eq!(event.outcome, "denied");
        assert_eq!(
            event.outcome_reason,
            "Permission iam.serviceAccountKeys.create denied"
        );
        assert_eq!(event.actor_type, "service");
    }

    #[test]
    fn a_failed_call_that_was_not_refused_is_a_failure() {
        let mut entry = parse(GCP_ACTIVITY);
        entry["protoPayload"].as_object_mut().unwrap().insert(
            "status".into(),
            json!({ "code": 9, "message": "Precondition failed" }),
        );

        assert_eq!(
            gcp_entry(&entry, NOW).map(|event| event.outcome),
            Some("failure")
        );
    }

    #[test]
    fn an_iam_policy_change_is_a_permission_event_and_a_policy_denial_is_denied() {
        let mut policy_change = parse(GCP_ACTIVITY);
        policy_change["protoPayload"]
            .as_object_mut()
            .unwrap()
            .insert("methodName".into(), json!("SetIamPolicy"));
        let mut denial = parse(GCP_ACTIVITY);
        denial.insert(
            "logName".into(),
            json!("projects/acme-prod/logs/cloudaudit.googleapis.com%2Fpolicy"),
        );

        assert_eq!(
            gcp_entry(&policy_change, NOW).map(|event| event.category),
            Some("permission")
        );
        let denied = gcp_entry(&denial, NOW).expect("a Policy Denied entry");
        assert_eq!((denied.category, denied.outcome), ("permission", "denied"));
    }

    // System Event and Data Access entries, and a workload's own log lines, are not
    // audit events of the org's people: they stay logs.
    #[test]
    fn only_admin_activity_and_policy_denied_entries_are_audit_events() {
        for log in [
            "cloudaudit.googleapis.com%2Fsystem_event",
            "cloudaudit.googleapis.com%2Fdata_access",
            "run.googleapis.com%2Fstdout",
        ] {
            let mut entry = parse(GCP_ACTIVITY);
            entry.insert(
                "logName".into(),
                json!(format!("projects/acme-prod/logs/{log}")),
            );
            assert_eq!(gcp_entry(&entry, NOW), None, "{log}");
        }
        let mut no_payload = parse(GCP_ACTIVITY);
        no_payload.remove("protoPayload");
        assert_eq!(gcp_entry(&no_payload, NOW), None);
    }

    #[test]
    fn an_oversized_payload_is_stored_as_the_fields_the_row_was_built_from() {
        let mut entry = parse(GCP_ACTIVITY);
        entry["protoPayload"]
            .as_object_mut()
            .unwrap()
            .insert("request".into(), json!("x".repeat(RAW_LIMIT_BYTES)));
        let event = gcp_entry(&entry, NOW).expect("an Admin Activity entry");

        assert!(event.raw.len() < RAW_LIMIT_BYTES);
        assert!(event.raw.contains("CreateServiceAccountKey"));
    }

    #[test]
    fn iso_formats_an_instant_in_utc() {
        assert_eq!(iso(1_700_000_000_123), "2023-11-14T22:13:20.123Z");
    }
}
