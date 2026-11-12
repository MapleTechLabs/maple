//! Audit events from provider feeds as rows of `audit_trail_events`, the table
//! behind the Security hub's audit log. They are written here, never as OTLP
//! logs: a log can be sent by anything holding an ingest key and read by every
//! member, and an audit record must be neither.
//!
//! The row shape and the id derivation mirror the TypeScript writer
//! (`packages/backend/src/services/audit-trail/audit-trail-row.ts`). The two
//! must agree: an event a provider redelivers has to land on the same key.

use crate::vercel_logs::text;
use chrono::{DateTime, Utc};
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use sha2::{Digest, Sha256};
use std::borrow::Cow;

type JsonObject = JsonMap<String, JsonValue>;

pub const DATASOURCE: &str = "audit_trail_events";

/// Above any ingest time in ms, so `Version` stays positive and falls as time
/// rises: the table keeps the highest version, which is the first write.
const VERSION_CEILING_MS: i64 = 9_999_999_999_999;

/// A payload larger than this is not kept; the row's columns say what happened.
const RAW_LIMIT_BYTES: usize = 32 * 1024;

/// The table drops a row this long after it happened.
const RETENTION_MS: i64 = 400 * 24 * 60 * 60 * 1000;
/// How far ahead of this gateway's clock a sender's may run.
const MAX_AHEAD_MS: i64 = 24 * 60 * 60 * 1000;

/// The most bytes a column keeps. The sender sets every one of them, and the
/// table is shared by every org.
const NAME_LIMIT_BYTES: usize = 256;
const TEXT_LIMIT_BYTES: usize = 1024;

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

/// `value` cut to at most `max_bytes`, on a character boundary.
fn clip(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

/// An id is part of the row's key, so one too long to keep is hashed, not cut:
/// two long ids sharing a prefix stay two events.
fn bounded_id(id: &str) -> Cow<'_, str> {
    if id.len() <= NAME_LIMIT_BYTES {
        Cow::Borrowed(id)
    } else {
        Cow::Owned(sha256_prefix(id.as_bytes()))
    }
}

impl AuditEvent {
    /// The event as one NDJSON row for `org_id`, stored at `ingested_at_ms`.
    pub fn to_row(&self, org_id: &str, ingested_at_ms: i64) -> Vec<u8> {
        let name = |value: &'_ str| clip(value, NAME_LIMIT_BYTES).to_owned();
        let long = |value: &'_ str| clip(value, TEXT_LIMIT_BYTES).to_owned();
        let account = name(&self.account);
        let provider_event_id = bounded_id(&self.provider_event_id);
        json!({
            "OrgId": org_id,
            "Id": event_id(self.provider, &account, &provider_event_id),
            "OccurredAt": warehouse_datetime(self.occurred_at_ms),
            "IngestedAt": warehouse_datetime(ingested_at_ms),
            "Provider": self.provider,
            "Account": account,
            "ProviderEventId": provider_event_id,
            "ActorType": self.actor_type,
            "ActorId": name(&self.actor_id),
            "ActorName": name(&self.actor_name),
            "ActorEmail": name(&self.actor_email),
            "Action": name(&self.action),
            "Category": self.category,
            "Outcome": self.outcome,
            "OutcomeReason": long(&self.outcome_reason),
            "TargetType": name(&self.target_type),
            "TargetId": name(&self.target_id),
            "TargetName": long(&self.target_name),
            "OriginIp": name(&self.origin_ip),
            "OriginCountry": "",
            "UserAgent": long(&self.user_agent),
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

/// The payload as JSON text, or a marker of its size when it is too large to keep.
fn raw_of(payload: &JsonObject) -> String {
    let full = serde_json::to_string(payload).unwrap_or_default();
    if full.len() <= RAW_LIMIT_BYTES {
        full
    } else {
        json!({ "truncated": true, "bytes": full.len() }).to_string()
    }
}

/// A key for an event the provider gave no id: the same payload is the same event.
fn content_id(payload: &JsonObject) -> String {
    sha256_prefix(
        serde_json::to_string(payload)
            .unwrap_or_default()
            .as_bytes(),
    )
}

/// When the event happened, as the sender says, if that is a time a row can
/// hold: inside the table's retention and not ahead of this clock. Any other
/// time is replaced by now, so a sender cannot mint partitions on the shared
/// table, plant a row that never expires, or send one that expires on arrival.
fn occurred_at_ms(claimed: Option<i64>, now_ms: i64) -> i64 {
    claimed
        .filter(|ms| (now_ms - RETENTION_MS..=now_ms + MAX_AHEAD_MS).contains(ms))
        .unwrap_or(now_ms)
}

/// The words of an action name, lowercased: split at punctuation and at a
/// camelCase hump. Matching whole words keeps `environment` from reading as `env`.
fn words(name: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut after_lowercase = false;
    for character in name.chars() {
        let hump = character.is_ascii_uppercase() && after_lowercase;
        if (hump || !character.is_ascii_alphanumeric()) && !word.is_empty() {
            words.push(std::mem::take(&mut word));
        }
        if character.is_ascii_alphanumeric() {
            word.push(character.to_ascii_lowercase());
        }
        after_lowercase = character.is_ascii_lowercase() || character.is_ascii_digit();
    }
    if !word.is_empty() {
        words.push(word);
    }
    words
}

/// Whether any of `words` is one of `needles`, or its plural.
fn has_word(words: &[String], needles: &[&str]) -> bool {
    words.iter().any(|word| {
        needles
            .iter()
            .any(|needle| word == needle || word.strip_suffix('s') == Some(*needle))
    })
}

/// What a Vercel action is about, read off its name. Vercel publishes no closed
/// list, so this is by the words the names use; anything unrecognised is a
/// change to a resource. The order decides a name with two readings: a member's
/// role change is about permission, and password protection is a setting.
fn vercel_category(action: &str) -> &'static str {
    let words = words(action);
    let has = |needles: &[&str]| has_word(&words, needles);
    if has(&[
        "login", "logout", "sso", "saml", "mfa", "2fa", "passkey", "signin",
    ]) {
        "authentication"
    } else if has(&["protection"]) {
        "configuration"
    } else if has(&["role", "permission", "acl"]) || (has(&["access"]) && has(&["group"])) {
        "permission"
    } else if has(&[
        "token",
        "secret",
        "env",
        "variable",
        "certificate",
        "cert",
        "password",
        "key",
    ]) {
        "credential"
    } else if has(&["member", "invite", "invitation", "join", "leave"]) {
        "membership"
    } else if has(&["billing", "invoice", "payment", "plan", "subscription"]) {
        "billing"
    } else if has(&[
        "setting",
        "drain",
        "integration",
        "webhook",
        "firewall",
        "config",
        "configuration",
    ]) {
        "configuration"
    } else {
        "resource"
    }
}

/// What a Vercel action was done to: the action without its closing verb
/// (`project.env-var.created` is about a `project.env-var`).
fn vercel_target_type(action: &str) -> &str {
    action
        .rfind(['.', '-', '_'])
        .map_or("", |verb_at| &action[..verb_at])
}

/// The id of what a Vercel action was done to, from the event's `payload`: the
/// id named after the action's subject (`drainId` for `drain-created`), or the
/// only id there is.
fn vercel_target_id<'a>(action: &str, payload: &'a JsonObject) -> Option<&'a str> {
    let subject = words(action).into_iter().next().unwrap_or_default();
    if let Some(id) = text(payload, &format!("{subject}Id")) {
        return Some(id);
    }
    let mut ids = payload
        .iter()
        .filter(|(key, _)| key.ends_with("Id"))
        .filter_map(|(_, value)| value.as_str());
    let only = ids.next()?;
    ids.next().is_none().then_some(only)
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
    let claimed_ms = event
        .get("timestamp")
        .and_then(JsonValue::as_f64)
        .filter(|ms| ms.is_finite() && *ms > 0.0)
        .map(|ms| ms.trunc() as i64);
    let payload = object(event, "payload");
    Some(AuditEvent {
        provider: "vercel",
        account: owned(text(event, "teamId")),
        provider_event_id: text(event, "id").map_or_else(|| content_id(event), str::to_owned),
        occurred_at_ms: occurred_at_ms(claimed_ms, now_ms),
        actor_type,
        actor_id: actor_text("id"),
        actor_name: actor_text("name"),
        actor_email: actor_text("email"),
        action: action.to_owned(),
        category: vercel_category(action),
        // The drain reports what was done; Vercel does not log refused attempts in it.
        outcome: "success",
        target_type: vercel_target_type(action).to_owned(),
        target_id: owned(payload.and_then(|payload| vercel_target_id(action, payload))),
        target_name: owned(payload.and_then(|payload| text(payload, "name"))),
        origin_ip: owned(text(event, "ipAddress")),
        user_agent: owned(text(event, "userAgent")),
        raw: raw_of(event),
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

/// Kubernetes API writes reach the Admin Activity log under this service. Most
/// are a cluster's own controllers at work, thousands an hour: they stay logs.
const GCP_KUBERNETES_SERVICE: &str = "k8s.io";

/// Services whose every change is to how the organization itself is set up.
const GCP_CONFIGURATION_SERVICES: [&str; 6] = [
    "orgpolicy",
    "logging",
    "serviceusage",
    "accesscontextmanager",
    "essentialcontacts",
    "securitycenter",
];

/// What a Google API call is about, read off its service and method. Only the
/// call itself is read (`SetIamPolicy`), not the package it sits in.
fn gcp_category(service: &str, method: &str) -> &'static str {
    let call = words(method.rsplit('.').next().unwrap_or(method));
    let has = |needles: &[&str]| has_word(&call, needles);
    let service_is = |names: &[&str]| names.iter().any(|name| service.contains(name));
    if has(&["iam"])
        || (service == "iam.googleapis.com" && has(&["role", "policy", "binding", "deny"]))
    {
        "permission"
    } else if has(&["key"]) || service_is(&["secretmanager", "apikeys", "cloudkms"]) {
        "credential"
    } else if service_is(&["cloudbilling", "billingbudgets"]) {
        "billing"
    } else if has(&["login", "signin"]) {
        "authentication"
    } else if service_is(&GCP_CONFIGURATION_SERVICES) || (has(&["org"]) && has(&["policy"])) {
        "configuration"
    } else {
        "resource"
    }
}

/// Who made a Google API call: `(type, id, email)`. A federated workload has
/// no email, only a `principalSubject`.
fn gcp_actor(payload: &JsonObject) -> (&'static str, &str, &str) {
    let info = object(payload, "authenticationInfo");
    let email = info
        .and_then(|info| text(info, "principalEmail"))
        .unwrap_or_default();
    if !email.is_empty() {
        let service = email.ends_with("gserviceaccount.com") || email.starts_with("system:");
        let address = if email.contains('@') { email } else { "" };
        return (if service { "service" } else { "user" }, email, address);
    }
    let subject = info
        .and_then(|info| text(info, "principalSubject"))
        .unwrap_or_default();
    if subject.is_empty() {
        ("unknown", "", "")
    } else if subject.starts_with("user:") {
        ("user", subject, "")
    } else {
        ("service", subject, "")
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
    if service == GCP_KUBERNETES_SERVICE {
        return None;
    }
    let (actor_type, actor_id, actor_email) = gcp_actor(payload);

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
    let claimed_ms = text(entry, "timestamp")
        .and_then(|timestamp| DateTime::parse_from_rfc3339(timestamp).ok())
        .map(|timestamp| timestamp.timestamp_millis());

    Some(AuditEvent {
        provider: "gcp",
        account,
        provider_event_id: text(entry, "insertId").map_or_else(|| content_id(entry), str::to_owned),
        occurred_at_ms: occurred_at_ms(claimed_ms, now_ms),
        actor_type,
        actor_id: actor_id.to_owned(),
        actor_email: actor_email.to_owned(),
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
        raw: raw_of(entry),
        ..AuditEvent::default()
    })
}

/// Now, as the warehouse and this module count it.
pub fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
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
        assert_eq!(
            event_id("maple", "acme", "evt_1"),
            "1d19ea3d78217e97b45a7a9d28300146"
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
        assert_eq!(row["TargetType"], "project.env-var");
        assert_eq!(row["TargetId"], "prj_1");
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
    fn an_oversized_payload_is_not_kept_and_the_row_still_says_what_happened() {
        let mut entry = parse(GCP_ACTIVITY);
        entry["protoPayload"]
            .as_object_mut()
            .unwrap()
            .insert("request".into(), json!("x".repeat(RAW_LIMIT_BYTES)));
        let event = gcp_entry(&entry, NOW).expect("an Admin Activity entry");
        let raw: JsonObject = serde_json::from_str(&event.raw).expect("raw is JSON");

        assert_eq!(raw["truncated"], true);
        assert!(event.raw.len() < 100);
        assert_eq!(event.action, "google.iam.admin.v1.CreateServiceAccountKey");
    }

    // Every column is the sender's to fill, and the table is every org's.
    #[test]
    fn a_row_keeps_no_more_of_a_field_than_its_column_takes() {
        let long = "é".repeat(4000);
        let mut entry = parse(GCP_ACTIVITY);
        entry.insert("insertId".into(), json!(long));
        let payload = entry["protoPayload"].as_object_mut().unwrap();
        payload.insert("methodName".into(), json!(long));
        payload.insert("resourceName".into(), json!(long));
        payload.insert("status".into(), json!({ "code": 9, "message": long }));
        let row = row(&gcp_entry(&entry, NOW).expect("an Admin Activity entry"));
        let bytes = |column: &str| row[column].as_str().map_or(0, str::len);

        assert_eq!(bytes("Action"), NAME_LIMIT_BYTES);
        assert_eq!(bytes("TargetName"), TEXT_LIMIT_BYTES);
        assert_eq!(bytes("OutcomeReason"), TEXT_LIMIT_BYTES);
        // An id is hashed rather than cut: it is part of the row's key.
        assert_eq!(bytes("ProviderEventId"), 32);
        assert!(bytes("Raw") <= RAW_LIMIT_BYTES);
    }

    #[test]
    fn two_long_ids_that_share_a_prefix_stay_two_events() {
        let id = |tail: &str| format!("{}{tail}", "a".repeat(NAME_LIMIT_BYTES));
        let key = |id: String| {
            let event = AuditEvent {
                provider: "vercel",
                provider_event_id: id,
                ..AuditEvent::default()
            };
            row(&event)["Id"].clone()
        };

        assert_ne!(key(id("1")), key(id("2")));
    }

    // The table is partitioned by the month an event happened and drops rows by
    // age: a sender's own clock must not pick the partition or the expiry.
    #[test]
    fn a_time_the_table_could_not_hold_is_replaced_by_the_time_of_receipt() {
        let at = |timestamp: i64| {
            let mut event = parse(VERCEL_EVENT);
            event.insert("timestamp".into(), json!(timestamp));
            vercel_event(&event, NOW).map(|event| event.occurred_at_ms)
        };
        let day = 24 * 60 * 60 * 1000;

        assert_eq!(at(NOW - 399 * day), Some(NOW - 399 * day));
        assert_eq!(at(NOW + day / 2), Some(NOW + day / 2));
        assert_eq!(at(NOW - 401 * day), Some(NOW));
        assert_eq!(at(NOW + 2 * day), Some(NOW));
        // Seconds where milliseconds belong: 1970, which would expire on arrival.
        assert_eq!(at(NOW / 1000), Some(NOW));
    }

    #[test]
    fn a_vercel_action_is_filed_by_the_words_in_its_name() {
        for (action, category) in [
            ("team.member.role.updated", "permission"),
            ("team.member.added", "membership"),
            ("access-group.created", "permission"),
            ("project.env-var.created", "credential"),
            ("project.environment.created", "resource"),
            ("password_protection.enabled", "configuration"),
            ("token.created", "credential"),
            ("user.login", "authentication"),
            ("drain-created", "configuration"),
            ("deployment.deleted", "resource"),
        ] {
            assert_eq!(vercel_category(action), category, "{action}");
        }
    }

    #[test]
    fn a_vercel_event_points_at_what_its_payload_names() {
        let event = parse(
            r#"{"id":"evt_3","action":"drain-created","payload":{"drainId":"drn_1","projectId":"prj_1","name":"Maple logs"}}"#,
        );
        let event = vercel_event(&event, NOW).expect("an event with an action");

        assert_eq!(
            (
                event.target_type.as_str(),
                event.target_id.as_str(),
                event.target_name.as_str()
            ),
            ("drain", "drn_1", "Maple logs")
        );
    }

    #[test]
    fn a_google_call_is_filed_by_its_service_and_the_call_itself() {
        for (service, method, category) in [
            (
                "storage.googleapis.com",
                "storage.setIamPermissions",
                "permission",
            ),
            (
                "iam.googleapis.com",
                "google.iam.admin.v1.CreateRole",
                "permission",
            ),
            (
                "iam.googleapis.com",
                "google.iam.admin.v1.CreateServiceAccount",
                "resource",
            ),
            (
                "cloudresourcemanager.googleapis.com",
                "SetOrgPolicy",
                "configuration",
            ),
            (
                "logging.googleapis.com",
                "google.logging.v2.ConfigServiceV2.DeleteSink",
                "configuration",
            ),
            (
                "secretmanager.googleapis.com",
                "google.cloud.secretmanager.v1.SecretManagerService.DeleteSecret",
                "credential",
            ),
            (
                "compute.googleapis.com",
                "v1.compute.instances.insert",
                "resource",
            ),
        ] {
            assert_eq!(gcp_category(service, method), category, "{method}");
        }
    }

    // A cluster's controllers write to the Kubernetes API all day, and Google
    // files every write under Admin Activity.
    #[test]
    fn a_kubernetes_api_write_stays_a_log() {
        let mut entry = parse(GCP_ACTIVITY);
        let payload = entry["protoPayload"].as_object_mut().unwrap();
        payload.insert("serviceName".into(), json!("k8s.io"));
        payload.insert("methodName".into(), json!("io.k8s.core.v1.pods.create"));

        assert_eq!(gcp_entry(&entry, NOW), None);
    }

    #[test]
    fn a_federated_workload_is_a_service_named_by_its_subject() {
        let subject = "principal://iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/ci/subject/repo";
        let mut entry = parse(GCP_ACTIVITY);
        entry["protoPayload"].as_object_mut().unwrap().insert(
            "authenticationInfo".into(),
            json!({ "principalSubject": subject }),
        );
        let event = gcp_entry(&entry, NOW).expect("an Admin Activity entry");

        assert_eq!(
            (
                event.actor_type,
                event.actor_id.as_str(),
                event.actor_email.as_str()
            ),
            ("service", subject, "")
        );
    }
}
