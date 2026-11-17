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

// What a connection's `audit_last_error` holds. The customer reads it on the
// connection: one sentence of cause, one of what to do.

/// The gateway is not storing audit events yet (`INGEST_AUDIT_TRAIL_ENABLED` off).
pub const AWS_AUDIT_NOT_STORED_YET: &str = "Maple is not storing AWS audit events in this \
    region yet. Nothing to do: they start arriving once it does.";

/// A delivery, or a record in it, that is not EventBridge events as JSON.
pub const AWS_AUDIT_UNREADABLE_DELIVERY: &str = "Maple could not read an AWS audit event \
    delivery. Check that the EventBridge rule targets the Firehose stream Maple set up, with no \
    input transformer. Audit events sent meanwhile are lost.";

/// A delivery over the decoded size or event count Maple accepts.
pub const AWS_AUDIT_DELIVERY_TOO_LARGE: &str = "An AWS audit event delivery was larger than \
    Maple accepts. Lower the Firehose stream's buffer size. Audit events sent meanwhile are lost.";

/// A delivery Maple accepted but could not hand to storage.
pub const AWS_AUDIT_NOT_STORED: &str = "Maple could not store an AWS audit event delivery just \
    now. Firehose retries it. Nothing to do.";

/// The EventBridge `detail-type`s, and the matching CloudTrail `eventType`s,
/// that are audit events. A service event is AWS acting on its own.
const AWS_DETAIL_TYPES: [&str; 3] = [
    "AWS API Call via CloudTrail",
    "AWS Console Signin via CloudTrail",
    "AWS Console Action via CloudTrail",
];
const AWS_EVENT_TYPES: [&str; 3] = ["AwsApiCall", "AwsConsoleSignIn", "AwsConsoleAction"];

/// The EventBridge events in one Firehose record: one JSON object as a rule
/// delivers it, or several concatenated or newline-separated. `None` when the
/// record holds anything else.
pub fn aws_record_events(record: &[u8]) -> Option<Vec<JsonObject>> {
    serde_json::Deserializer::from_slice(record)
        .into_iter::<JsonValue>()
        .map(|value| match value {
            Ok(JsonValue::Object(object)) => Some(object),
            _ => None,
        })
        .collect()
}

/// `errorCode`s AWS returns for a call the caller was not allowed to make.
const AWS_DENIED_CODES: [&str; 5] = [
    "AccessDenied",
    "AccessDeniedException",
    "UnauthorizedOperation",
    "UnauthorizedAccess",
    "Client.UnauthorizedOperation",
];

fn aws_is_denied(error_code: &str) -> bool {
    AWS_DENIED_CODES.contains(&error_code)
        || error_code.contains("AccessDenied")
        || error_code.contains("Unauthorized")
}

/// Services whose every change is to how the account is watched or governed.
const AWS_CONFIGURATION_SERVICES: [&str; 8] = [
    "cloudtrail",
    "config",
    "guardduty",
    "securityhub",
    "access-analyzer",
    "organizations",
    "logs",
    "events",
];

const AWS_BILLING_SERVICES: [&str; 12] = [
    "billing",
    "billingconsole",
    "ce",
    "budgets",
    "account",
    "payments",
    "purchase-orders",
    "tax",
    "invoicing",
    "freetier",
    "cur",
    "aws-portal",
];

/// Calls that add or remove a person, a group or an account.
const AWS_MEMBERSHIP_CALLS: [&str; 9] = [
    "CreateUser",
    "DeleteUser",
    "CreateGroup",
    "DeleteGroup",
    "CreateAccount",
    "CloseAccount",
    "InviteAccountToOrganization",
    "RemoveAccountFromOrganization",
    "LeaveOrganization",
];

const AWS_SIGNIN_CALLS: [&str; 5] = [
    "ConsoleLogin",
    "CheckMfa",
    "SwitchRole",
    "ExitRole",
    "GetSigninToken",
];

/// What an AWS call is about, read off its service (`eventSource` without
/// `.amazonaws.com`) and name. The order decides a name with two readings: an
/// SCP attach is governance, a security group rule is network configuration.
fn aws_category(service: &str, event_name: &str, event_type: &str) -> &'static str {
    let words = words(event_name);
    let has = |needles: &[&str]| has_word(&words, needles);
    // `MFADevice` reads as one word, so MFA is matched inside the name.
    let mfa = event_name.to_ascii_lowercase().contains("mfa");
    if event_type == "AwsConsoleSignIn"
        || AWS_SIGNIN_CALLS.contains(&event_name)
        || service == "signin"
        || (service == "sso"
            && (mfa
                || has(&[
                    "login",
                    "logout",
                    "signin",
                    "signout",
                    "authenticate",
                    "federate",
                ])))
    {
        "authentication"
    } else if AWS_MEMBERSHIP_CALLS.contains(&event_name)
        && ["iam", "identitystore", "sso-directory", "organizations"].contains(&service)
    {
        "membership"
    } else if AWS_CONFIGURATION_SERVICES.contains(&service)
        || (has(&["security"]) && has(&["group"]))
        || (has(&["network"]) && has(&["acl"]))
        || (has(&["flow"]) && has(&["log"]))
    {
        "configuration"
    } else if AWS_BILLING_SERVICES.contains(&service) {
        "billing"
    } else if has(&["role", "permission", "acl", "grant"])
        || (has(&["policy"]) && !has(&["scaling", "lifecycle", "retention", "backup"]))
        || (has(&["public"]) && has(&["access"]))
        || matches!(event_name, "AddUserToGroup" | "RemoveUserFromGroup")
    {
        "permission"
    } else if mfa
        || has(&["key", "password", "credential", "secret", "certificate"])
        || (has(&["login"]) && has(&["profile"]))
        || ["kms", "secretsmanager", "acm", "acm-pca"].contains(&service)
    {
        "credential"
    } else {
        "resource"
    }
}

/// `value` when it is an email address, else "".
fn email_in(value: &str) -> &str {
    if value.contains('@') {
        value
    } else {
        ""
    }
}

/// Who made an AWS call: `(type, id, name, email)`.
///
/// Root is always the account's person. A call a service made for a principal
/// (`invokedBy` beside an IAM user or role, as CloudFormation does) stays that
/// principal's; only an `AWSService` identity is the service itself. An assumed
/// role is a person when IAM Identity Center issued it or its session is named
/// by an email, and a workload otherwise.
fn aws_actor(identity: Option<&JsonObject>) -> (&'static str, String, String, String) {
    let Some(identity) = identity else {
        return ("unknown", String::new(), String::new(), String::new());
    };
    let get = |key: &str| text(identity, key).unwrap_or_default();
    let arn = get("arn");
    let user_name = get("userName");
    let issuer =
        object(identity, "sessionContext").and_then(|context| object(context, "sessionIssuer"));
    let issuer_name = issuer
        .and_then(|issuer| text(issuer, "userName"))
        .unwrap_or_default();
    // `AROA...:session-name` for an assumed role.
    let session = get("principalId")
        .split_once(':')
        .map_or("", |(_, session)| session);
    let kind = get("type");
    let invoked_by = get("invokedBy");
    if kind == "Root" {
        let id = if arn.is_empty() { "root" } else { arn };
        return ("user", id.to_owned(), "root".to_owned(), String::new());
    }
    let first = |values: &[&str]| {
        values
            .iter()
            .find(|value| !value.is_empty())
            .copied()
            .unwrap_or_default()
            .to_owned()
    };
    match kind {
        "IAMUser" | "IdentityCenterUser" => (
            "user",
            first(&[arn, get("principalId")]),
            user_name.to_owned(),
            email_in(user_name).to_owned(),
        ),
        "FederatedUser" => (
            "user",
            first(&[arn, get("principalId")]),
            first(&[session, issuer_name, user_name]),
            email_in(session).to_owned(),
        ),
        "AssumedRole" => {
            let person = session.contains('@') || issuer_name.starts_with("AWSReservedSSO_");
            if person {
                (
                    "user",
                    arn.to_owned(),
                    first(&[session, issuer_name]),
                    email_in(session).to_owned(),
                )
            } else {
                (
                    "service",
                    arn.to_owned(),
                    issuer_name.to_owned(),
                    String::new(),
                )
            }
        }
        "AWSService" | "AWSAccount" => (
            "service",
            first(&[invoked_by, get("accountId"), get("principalId"), arn]),
            invoked_by.to_owned(),
            String::new(),
        ),
        _ => (
            "unknown",
            first(&[arn, get("principalId")]),
            user_name.to_owned(),
            email_in(user_name).to_owned(),
        ),
    }
}

/// The `requestParameters` that name what a call was done to, most specific first.
const AWS_TARGET_NAME_KEYS: [&str; 7] = [
    "userName",
    "roleName",
    "bucketName",
    "groupName",
    "policyName",
    "functionName",
    "instanceId",
];

/// One CloudTrail management event as EventBridge delivers it. `None` for a
/// read-only call, an AWS service event, or anything with no event name.
pub fn aws_event(envelope: &JsonObject, now_ms: i64) -> Option<AuditEvent> {
    let detail = object(envelope, "detail")?;
    let event_name = text(detail, "eventName")?;
    let read_only = match detail.get("readOnly") {
        Some(JsonValue::Bool(read_only)) => *read_only,
        Some(JsonValue::String(read_only)) => read_only.eq_ignore_ascii_case("true"),
        _ => false,
    };
    if read_only {
        return None;
    }
    if text(envelope, "detail-type").is_some_and(|kind| !AWS_DETAIL_TYPES.contains(&kind)) {
        return None;
    }
    let event_type = text(detail, "eventType").unwrap_or_default();
    if !event_type.is_empty() && !AWS_EVENT_TYPES.contains(&event_type) {
        return None;
    }

    let event_source = text(detail, "eventSource").unwrap_or_default();
    let service = event_source
        .strip_suffix(".amazonaws.com")
        .unwrap_or(event_source);
    let action = if service.is_empty() {
        event_name.to_owned()
    } else {
        format!("{service}:{event_name}")
    };

    let error_code = text(detail, "errorCode").unwrap_or_default();
    // A sign-in step reports itself under its own name: `{"CheckMfa": "Failure"}`.
    let login_failed = object(detail, "responseElements")
        .and_then(|response| text(response, event_name))
        == Some("Failure");
    let outcome = if login_failed {
        "failure"
    } else if error_code.is_empty() {
        "success"
    } else if aws_is_denied(error_code) {
        "denied"
    } else {
        "failure"
    };
    let outcome_reason = text(detail, "errorMessage")
        .filter(|message| !message.is_empty())
        .unwrap_or(error_code);

    let (actor_type, actor_id, actor_name, actor_email) = aws_actor(object(detail, "userIdentity"));
    let resource = detail
        .get("resources")
        .and_then(JsonValue::as_array)
        .and_then(|resources| resources.first())
        .and_then(JsonValue::as_object);
    let target_type = resource
        .and_then(|resource| text(resource, "type"))
        .unwrap_or(service);
    let request = object(detail, "requestParameters");
    let target_name = request.and_then(|request| {
        AWS_TARGET_NAME_KEYS
            .iter()
            .find_map(|key| text(request, key))
    });
    let source_ip = text(detail, "sourceIPAddress").unwrap_or_default();
    let origin_ip = if source_ip.parse::<std::net::IpAddr>().is_ok() {
        source_ip
    } else {
        ""
    };
    let claimed_ms = text(detail, "eventTime")
        .or_else(|| text(envelope, "time"))
        .and_then(|time| DateTime::parse_from_rfc3339(time).ok())
        .map(|time| time.timestamp_millis());
    let account = text(detail, "recipientAccountId")
        .or_else(|| text(envelope, "account"))
        .unwrap_or_default();
    let provider_event_id = text(detail, "eventID")
        .or_else(|| text(envelope, "id"))
        .map_or_else(|| content_id(detail), str::to_owned);

    Some(AuditEvent {
        provider: "aws",
        account: account.to_owned(),
        provider_event_id,
        occurred_at_ms: occurred_at_ms(claimed_ms, now_ms),
        actor_type,
        actor_id,
        actor_name,
        actor_email,
        category: aws_category(service, event_name, event_type),
        action,
        outcome,
        outcome_reason: outcome_reason.to_owned(),
        target_type: target_type.to_owned(),
        target_id: owned(resource.and_then(|resource| text(resource, "ARN"))),
        target_name: owned(target_name),
        origin_ip: origin_ip.to_owned(),
        user_agent: owned(text(detail, "userAgent")),
        raw: raw_of(detail),
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

    /// An IAM user creating an access key for another user, as EventBridge delivers it.
    const AWS_CREATE_ACCESS_KEY: &str = r#"{"version":"0","id":"6a7e8feb-b491-4cf7-a9f1-bf3703467718","detail-type":"AWS API Call via CloudTrail","source":"aws.iam","account":"123456789012","time":"2023-11-14T22:13:20Z","region":"us-east-1","resources":[],"detail":{"eventVersion":"1.09","userIdentity":{"type":"IAMUser","principalId":"AIDAEXAMPLE","arn":"arn:aws:iam::123456789012:user/ada","accountId":"123456789012","accessKeyId":"AKIAEXAMPLE","userName":"ada"},"eventTime":"2023-11-14T22:13:20Z","eventSource":"iam.amazonaws.com","eventName":"CreateAccessKey","awsRegion":"us-east-1","sourceIPAddress":"203.0.113.7","userAgent":"aws-cli/2.15.0","requestParameters":{"userName":"deploy-bot"},"responseElements":{"accessKey":{"accessKeyId":"AKIANEW","status":"Active","userName":"deploy-bot"}},"requestID":"req-1","eventID":"0d3c9f2e-1111-4a5b-9c8d-000000000001","readOnly":false,"resources":[{"accountId":"123456789012","type":"AWS::IAM::User","ARN":"arn:aws:iam::123456789012:user/deploy-bot"}],"eventType":"AwsApiCall","managementEvent":true,"recipientAccountId":"123456789012","eventCategory":"Management"}}"#;

    const AWS_CONSOLE_LOGIN: &str = r#"{"version":"0","id":"evb-2","detail-type":"AWS Console Signin via CloudTrail","source":"aws.signin","account":"123456789012","time":"2023-11-14T22:13:20Z","region":"us-east-1","resources":[],"detail":{"eventVersion":"1.09","userIdentity":{"type":"IAMUser","principalId":"AIDAEXAMPLE","arn":"arn:aws:iam::123456789012:user/ada","accountId":"123456789012","userName":"ada"},"eventTime":"2023-11-14T22:13:20Z","eventSource":"signin.amazonaws.com","eventName":"ConsoleLogin","awsRegion":"us-east-1","sourceIPAddress":"198.51.100.4","userAgent":"Mozilla/5.0","errorMessage":"Failed authentication","requestParameters":null,"responseElements":{"ConsoleLogin":"Failure"},"additionalEventData":{"MFAUsed":"No"},"eventID":"login-1","readOnly":false,"eventType":"AwsConsoleSignIn","managementEvent":true,"recipientAccountId":"123456789012"}}"#;

    fn aws(json: &str) -> AuditEvent {
        aws_event(&parse(json), NOW).expect("a CloudTrail management event")
    }

    /// `AWS_CREATE_ACCESS_KEY` with `detail` fields replaced.
    fn aws_with(detail: &JsonValue) -> JsonObject {
        let mut envelope = parse(AWS_CREATE_ACCESS_KEY);
        let target = envelope["detail"].as_object_mut().unwrap();
        for (key, value) in detail.as_object().unwrap() {
            target.insert(key.clone(), value.clone());
        }
        envelope
    }

    #[test]
    fn an_iam_user_creating_an_access_key_becomes_a_credential_row() {
        let event = aws(AWS_CREATE_ACCESS_KEY);
        let row = row(&event);

        assert_eq!(row["Provider"], "aws");
        assert_eq!(row["Account"], "123456789012");
        assert_eq!(
            row["ProviderEventId"],
            "0d3c9f2e-1111-4a5b-9c8d-000000000001"
        );
        assert_eq!(row["OccurredAt"], "2023-11-14 22:13:20.000");
        assert_eq!(row["ActorType"], "user");
        assert_eq!(row["ActorId"], "arn:aws:iam::123456789012:user/ada");
        assert_eq!(row["ActorName"], "ada");
        assert_eq!(row["ActorEmail"], "");
        assert_eq!(row["Action"], "iam:CreateAccessKey");
        assert_eq!(row["Category"], "credential");
        assert_eq!(row["Outcome"], "success");
        assert_eq!(row["TargetType"], "AWS::IAM::User");
        assert_eq!(row["TargetId"], "arn:aws:iam::123456789012:user/deploy-bot");
        assert_eq!(row["TargetName"], "deploy-bot");
        assert_eq!(row["OriginIp"], "203.0.113.7");
        assert_eq!(row["UserAgent"], "aws-cli/2.15.0");
        // The CloudTrail record is kept, not the EventBridge envelope around it.
        let raw: JsonObject = serde_json::from_str(row["Raw"].as_str().unwrap()).unwrap();
        assert_eq!(raw["eventName"], "CreateAccessKey");
        assert!(raw.get("detail-type").is_none());
    }

    #[test]
    fn a_failed_console_login_is_an_authentication_failure() {
        let event = aws(AWS_CONSOLE_LOGIN);

        assert_eq!(event.action, "signin:ConsoleLogin");
        assert_eq!(event.category, "authentication");
        assert_eq!(event.outcome, "failure");
        assert_eq!(event.outcome_reason, "Failed authentication");
        assert_eq!(event.origin_ip, "198.51.100.4");
    }

    #[test]
    fn a_root_console_login_is_the_root_user() {
        let mut envelope = parse(AWS_CONSOLE_LOGIN);
        let detail = envelope["detail"].as_object_mut().unwrap();
        detail.remove("errorMessage");
        detail.insert(
            "responseElements".into(),
            json!({ "ConsoleLogin": "Success" }),
        );
        detail.insert(
            "userIdentity".into(),
            json!({ "type": "Root", "principalId": "123456789012", "arn": "arn:aws:iam::123456789012:root", "accountId": "123456789012" }),
        );
        let event = aws_event(&envelope, NOW).expect("a console sign-in");

        assert_eq!(
            (
                event.actor_type,
                event.actor_id.as_str(),
                event.actor_name.as_str()
            ),
            ("user", "arn:aws:iam::123456789012:root", "root")
        );
        assert_eq!(
            (event.category, event.outcome),
            ("authentication", "success")
        );
    }

    #[test]
    fn a_refused_call_by_an_assumed_role_is_denied_with_its_reason() {
        let envelope = aws_with(&json!({
            "eventSource": "s3.amazonaws.com",
            "eventName": "PutBucketPolicy",
            "errorCode": "AccessDenied",
            "errorMessage": "User is not authorized to perform s3:PutBucketPolicy",
            "requestParameters": { "bucketName": "acme-logs" },
            "resources": [{ "type": "AWS::S3::Bucket", "ARN": "arn:aws:s3:::acme-logs" }],
            "userIdentity": {
                "type": "AssumedRole",
                "principalId": "AROAEXAMPLE:ci-run-42",
                "arn": "arn:aws:sts::123456789012:assumed-role/deployer/ci-run-42",
                "sessionContext": { "sessionIssuer": { "type": "Role", "userName": "deployer", "arn": "arn:aws:iam::123456789012:role/deployer" } }
            }
        }));
        let event = aws_event(&envelope, NOW).expect("an API call");

        assert_eq!(event.outcome, "denied");
        assert_eq!(
            event.outcome_reason,
            "User is not authorized to perform s3:PutBucketPolicy"
        );
        // Filed by what was attempted, not by the refusal.
        assert_eq!(event.category, "permission");
        assert_eq!(event.action, "s3:PutBucketPolicy");
        assert_eq!(event.target_name, "acme-logs");
        assert_eq!(
            (event.actor_type, event.actor_name.as_str()),
            ("service", "deployer")
        );
    }

    #[test]
    fn a_failed_call_that_was_not_refused_is_a_failure_with_its_code() {
        let envelope = aws_with(&json!({ "errorCode": "LimitExceeded" }));
        let event = aws_event(&envelope, NOW).expect("an API call");

        assert_eq!(
            (event.outcome, event.outcome_reason.as_str()),
            ("failure", "LimitExceeded")
        );
    }

    #[test]
    fn a_role_from_identity_center_is_the_person_signed_in() {
        let envelope = aws_with(&json!({
            "userIdentity": {
                "type": "AssumedRole",
                "principalId": "AROAEXAMPLE:ada@acme.test",
                "arn": "arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_Admin_0123/ada@acme.test",
                "sessionContext": { "sessionIssuer": { "type": "Role", "userName": "AWSReservedSSO_Admin_0123" } }
            }
        }));
        let event = aws_event(&envelope, NOW).expect("an API call");

        assert_eq!(
            (
                event.actor_type,
                event.actor_name.as_str(),
                event.actor_email.as_str()
            ),
            ("user", "ada@acme.test", "ada@acme.test")
        );
    }

    #[test]
    fn a_call_a_service_made_has_that_service_as_actor_and_no_origin_ip() {
        let envelope = aws_with(&json!({
            "eventSource": "ec2.amazonaws.com",
            "eventName": "RunInstances",
            "sourceIPAddress": "autoscaling.amazonaws.com",
            "userAgent": "autoscaling.amazonaws.com",
            "requestParameters": { "instanceType": "m7g.large" },
            "resources": [],
            "userIdentity": {
                "type": "AssumedRole",
                "principalId": "AROAEXAMPLE:AutoScaling",
                "arn": "arn:aws:sts::123456789012:assumed-role/AWSServiceRoleForAutoScaling/AutoScaling",
                "invokedBy": "autoscaling.amazonaws.com",
                "sessionContext": { "sessionIssuer": { "type": "Role", "userName": "AWSServiceRoleForAutoScaling" } }
            }
        }));
        let event = aws_event(&envelope, NOW).expect("an API call");

        assert_eq!(
            (event.actor_type, event.actor_name.as_str()),
            ("service", "AWSServiceRoleForAutoScaling")
        );
        assert_eq!(event.origin_ip, "");
        assert_eq!(event.category, "resource");
        assert_eq!(event.target_type, "ec2");
    }

    // CloudFormation, SSM and the like act for the person who asked: the trail
    // must still say who deleted the bucket.
    #[test]
    fn a_person_acting_through_a_service_stays_the_actor() {
        let envelope = aws_with(&json!({
            "eventSource": "s3.amazonaws.com",
            "eventName": "DeleteBucket",
            "sourceIPAddress": "cloudformation.amazonaws.com",
            "userIdentity": {
                "type": "IAMUser",
                "principalId": "AIDAEXAMPLE",
                "arn": "arn:aws:iam::123456789012:user/ada",
                "userName": "ada",
                "invokedBy": "cloudformation.amazonaws.com"
            }
        }));
        let event = aws_event(&envelope, NOW).expect("an API call");

        assert_eq!(
            (
                event.actor_type,
                event.actor_id.as_str(),
                event.actor_name.as_str()
            ),
            ("user", "arn:aws:iam::123456789012:user/ada", "ada")
        );
        assert_eq!(event.origin_ip, "");
    }

    #[test]
    fn a_failed_sign_in_step_is_a_failure_though_it_has_no_error_code() {
        let envelope = aws_with(&json!({
            "eventSource": "signin.amazonaws.com",
            "eventName": "CheckMfa",
            "eventType": "AwsConsoleSignIn",
            "responseElements": { "CheckMfa": "Failure" }
        }));
        let event = aws_event(&envelope, NOW).expect("a sign-in step");

        assert_eq!(
            (event.category, event.outcome),
            ("authentication", "failure")
        );
    }

    #[test]
    fn identities_without_a_person_behind_them_are_services_or_unknown() {
        let actor = |identity: JsonValue| {
            let envelope = aws_with(&json!({ "userIdentity": identity }));
            let event = aws_event(&envelope, NOW).expect("an API call");
            (event.actor_type, event.actor_id)
        };

        assert_eq!(
            actor(json!({ "type": "AWSService", "invokedBy": "config.amazonaws.com" })),
            ("service", "config.amazonaws.com".to_owned())
        );
        assert_eq!(
            actor(
                json!({ "type": "AWSAccount", "principalId": "AIDAX", "accountId": "210987654321" })
            ),
            ("service", "210987654321".to_owned())
        );
        assert_eq!(
            actor(
                json!({ "type": "FederatedUser", "principalId": "123456789012:grace@acme.test", "arn": "arn:aws:sts::123456789012:federated-user/grace" })
            ),
            (
                "user",
                "arn:aws:sts::123456789012:federated-user/grace".to_owned()
            )
        );
        assert_eq!(
            actor(
                json!({ "type": "IdentityCenterUser", "principalId": "1234-abcd", "userName": "grace@acme.test" })
            ),
            ("user", "1234-abcd".to_owned())
        );
        assert_eq!(actor(JsonValue::Null), ("unknown", String::new()));
    }

    // StopLogging and DeleteTrail are how an intruder blinds an account.
    #[test]
    fn stopping_a_trail_and_opening_a_security_group_are_configuration() {
        for (source, name) in [
            ("cloudtrail.amazonaws.com", "StopLogging"),
            ("ec2.amazonaws.com", "AuthorizeSecurityGroupIngress"),
        ] {
            let envelope = aws_with(&json!({ "eventSource": source, "eventName": name }));
            let event = aws_event(&envelope, NOW).expect("an API call");
            assert_eq!(event.category, "configuration", "{name}");
        }
    }

    #[test]
    fn read_only_calls_and_service_events_are_not_audit_events() {
        assert_eq!(
            aws_event(&aws_with(&json!({ "readOnly": true })), NOW),
            None
        );
        let mut service_event = aws_with(&json!({ "eventType": "AwsServiceEvent" }));
        assert_eq!(aws_event(&service_event, NOW), None);
        service_event.insert(
            "detail-type".into(),
            json!("AWS Service Event via CloudTrail"),
        );
        service_event["detail"]
            .as_object_mut()
            .unwrap()
            .insert("eventType".into(), json!("AwsApiCall"));
        assert_eq!(aws_event(&service_event, NOW), None);
        let mut no_detail = parse(AWS_CREATE_ACCESS_KEY);
        no_detail.remove("detail");
        assert_eq!(aws_event(&no_detail, NOW), None);
    }

    // Firehose retries a delivery it did not see acked, and EventBridge delivers
    // at least once: both must land on the row already there.
    #[test]
    fn a_redelivered_aws_event_lands_on_the_same_key() {
        let first = row(&aws(AWS_CREATE_ACCESS_KEY));
        let again: JsonObject = serde_json::from_slice(
            &aws_event(&parse(AWS_CREATE_ACCESS_KEY), NOW + 90_000)
                .expect("a CloudTrail management event")
                .to_row("org_1", NOW + 90_000),
        )
        .unwrap();

        assert_eq!(first["Id"], again["Id"]);
        assert_eq!(
            first["Id"],
            event_id(
                "aws",
                "123456789012",
                "0d3c9f2e-1111-4a5b-9c8d-000000000001"
            )
        );
    }

    #[test]
    fn an_aws_call_is_filed_by_its_service_and_name() {
        for (service, name, event_type, category) in [
            (
                "signin",
                "ConsoleLogin",
                "AwsConsoleSignIn",
                "authentication",
            ),
            ("sts", "GetSigninToken", "AwsApiCall", "authentication"),
            ("sso", "Federate", "AwsApiCall", "authentication"),
            ("iam", "CreateUser", "AwsApiCall", "membership"),
            ("identitystore", "DeleteUser", "AwsApiCall", "membership"),
            ("organizations", "CreateAccount", "AwsApiCall", "membership"),
            (
                "organizations",
                "AttachPolicy",
                "AwsApiCall",
                "configuration",
            ),
            ("cloudtrail", "DeleteTrail", "AwsApiCall", "configuration"),
            ("guardduty", "DeleteDetector", "AwsApiCall", "configuration"),
            (
                "logs",
                "DeleteRetentionPolicy",
                "AwsApiCall",
                "configuration",
            ),
            (
                "ec2",
                "RevokeSecurityGroupEgress",
                "AwsApiCall",
                "configuration",
            ),
            (
                "ec2",
                "CreateNetworkAclEntry",
                "AwsApiCall",
                "configuration",
            ),
            ("ec2", "DeleteFlowLogs", "AwsApiCall", "configuration"),
            ("budgets", "DeleteBudget", "AwsApiCall", "billing"),
            ("account", "PutAlternateContact", "AwsApiCall", "billing"),
            ("iam", "PutRolePolicy", "AwsApiCall", "permission"),
            ("iam", "AttachUserPolicy", "AwsApiCall", "permission"),
            ("iam", "AddUserToGroup", "AwsApiCall", "permission"),
            ("iam", "UpdateAssumeRolePolicy", "AwsApiCall", "permission"),
            ("s3", "PutBucketAcl", "AwsApiCall", "permission"),
            ("s3", "DeletePublicAccessBlock", "AwsApiCall", "permission"),
            ("lambda", "AddPermission", "AwsApiCall", "permission"),
            ("kms", "CreateGrant", "AwsApiCall", "permission"),
            ("sso", "CreatePermissionSet", "AwsApiCall", "permission"),
            ("iam", "CreateAccessKey", "AwsApiCall", "credential"),
            ("iam", "UpdateLoginProfile", "AwsApiCall", "credential"),
            ("iam", "ChangePassword", "AwsApiCall", "credential"),
            ("iam", "DeactivateMFADevice", "AwsApiCall", "credential"),
            ("iam", "UploadSSHPublicKey", "AwsApiCall", "credential"),
            ("ec2", "CreateKeyPair", "AwsApiCall", "credential"),
            ("kms", "ScheduleKeyDeletion", "AwsApiCall", "credential"),
            (
                "secretsmanager",
                "PutSecretValue",
                "AwsApiCall",
                "credential",
            ),
            ("autoscaling", "PutScalingPolicy", "AwsApiCall", "resource"),
            ("ec2", "ModifySnapshotAttribute", "AwsApiCall", "resource"),
            ("ec2", "RunInstances", "AwsApiCall", "resource"),
            ("s3", "DeleteBucket", "AwsApiCall", "resource"),
        ] {
            assert_eq!(
                aws_category(service, name, event_type),
                category,
                "{service}:{name}"
            );
        }
    }

    #[test]
    fn a_firehose_record_may_hold_several_events_and_must_hold_only_events() {
        let one = serde_json::to_string(&parse(AWS_CREATE_ACCESS_KEY)).unwrap();
        let two = format!("{one}\n{one}{one}\n");

        assert_eq!(
            aws_record_events(one.as_bytes()).map(|events| events.len()),
            Some(1)
        );
        assert_eq!(
            aws_record_events(two.as_bytes()).map(|events| events.len()),
            Some(3)
        );
        assert_eq!(aws_record_events(b"not json"), None);
        assert_eq!(aws_record_events(format!("{one}\n[1]").as_bytes()), None);
    }
}
