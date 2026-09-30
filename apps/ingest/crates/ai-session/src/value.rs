//! AnyValue rendering shared by the gateway's row encoder and the AI stamps,
//! so a stamped value reads exactly like the attribute it came from.

use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue};
use serde_json::Value;

pub fn any_value_string(value: &AnyValue) -> String {
    match value.value.as_ref() {
        Some(any_value::Value::StringValue(value)) => value.clone(),
        Some(any_value::Value::BoolValue(value)) => value.to_string(),
        Some(any_value::Value::IntValue(value)) => value.to_string(),
        Some(any_value::Value::DoubleValue(value)) => value.to_string(),
        // Text sent as bytes (LangSmith's prompt and completion) stays
        // readable. Binary is hex, including binary that happens to be valid
        // UTF-8: a control character other than whitespace marks it.
        Some(any_value::Value::BytesValue(value)) => match std::str::from_utf8(value) {
            Ok(text)
                if !text
                    .chars()
                    .any(|c| c.is_control() && !matches!(c, '\t' | '\n' | '\r')) =>
            {
                text.to_owned()
            }
            _ => bytes_hex(value),
        },
        Some(any_value::Value::ArrayValue(_) | any_value::Value::KvlistValue(_)) => {
            serde_json::to_string(&any_value_json(value)).unwrap_or_default()
        }
        // String-table references (OTLP 1.9 experimental encoding) cannot be resolved
        // without the sender's dictionary, which the gateway does not accept yet.
        Some(any_value::Value::StringValueStrindex(_)) | None => String::new(),
    }
}

pub fn any_value_json(value: &AnyValue) -> Value {
    match value.value.as_ref() {
        Some(any_value::Value::ArrayValue(array)) => {
            Value::Array(array.values.iter().map(any_value_json).collect())
        }
        Some(any_value::Value::KvlistValue(kvlist)) => Value::Object(
            kvlist
                .values
                .iter()
                .map(|kv| {
                    let value = kv.value.as_ref().map_or(Value::from(""), any_value_json);
                    (kv.key.clone(), value)
                })
                .collect(),
        ),
        _ => Value::String(any_value_string(value)),
    }
}

pub fn bytes_hex(bytes: &[u8]) -> String {
    if bytes.is_empty() || bytes.iter().all(|byte| *byte == 0) {
        return String::new();
    }
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}
