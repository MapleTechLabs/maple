//! OTLP profiles (the pprof-shaped `v1development` export) flattened to rows of
//! `profiles`: one row per stack, span link and attribute set per profile, the
//! producer's samples of it summed. The dictionary is resolved here, never stored.
//!
//! The rows mirror the TypeScript flattener Maple Local runs
//! (`packages/local-server/src/otlp/profiles.ts`). The two must agree: one export
//! has to read the same in both warehouses.

use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::marker::PhantomData;

use base64::alphabet;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};
use base64::engine::DecodePaddingMode;
use base64::Engine;
use opentelemetry_proto::tonic::collector::profiles::v1development::ExportProfilesServiceRequest;
use opentelemetry_proto::tonic::common::v1::{
    any_value, AnyValue, ArrayValue, KeyValue, KeyValueList,
};
use opentelemetry_proto::tonic::profiles::v1development::{
    Function, KeyValueAndUnit, Line, Link, Location, Mapping, Profile, ProfilesDictionary,
    ResourceProfiles, Sample, ScopeProfiles, Stack, ValueType,
};
use opentelemetry_proto::tonic::resource::v1::Resource;
use serde::de::{self, Deserializer, Visitor};
use serde::{Deserialize, Serialize, Serializer};

use crate::telemetry::{any_value_string, bytes_hex, format_timestamp_nano};

/// The datasource profiles land in unless the deployment renames it.
pub const DATASOURCE: &str = "profiles";

/// Stacks deeper than this keep their leaf side under one `(truncated)` root.
pub const MAX_STACK_DEPTH: usize = 256;

/// A function name or file path longer than this many characters is cut, so one
/// row stays bounded.
pub const MAX_FRAME_TEXT: usize = 1024;

/// The most one row may serialize to: the default export batch. It holds the
/// deepest stack of clipped text, so only sender-sized attributes pass it.
pub const MAX_ROW_BYTES: usize = 4 * 1024 * 1024;

/// Names the wire layout a sender speaks while the signal is in development.
pub const VERSION_HEADER: &str = "otlp-profiles-development-version";

/// The only Profiles development version this decoder reads.
const SUPPORTED_VERSION: &str = "1";

const TRACE_ID_BYTES: usize = 16;
const SPAN_ID_BYTES: usize = 8;

/// Whether a request's version header names a layout this decoder reads. Absent means 1.
pub fn is_supported_version(header: Option<&str>) -> bool {
    header.is_none_or(|version| version.trim() == SUPPORTED_VERSION)
}

/// Why an export could not be flattened.
#[derive(Debug, PartialEq, Eq)]
pub enum FlattenError {
    /// A trace, span or profile id that is not the length its field has.
    InvalidId {
        field: &'static str,
        expected: usize,
        actual: usize,
    },
    /// The rows need more memory than the caller would reserve.
    OverBudget,
    Encode(String),
}

impl fmt::Display for FlattenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidId {
                field,
                expected,
                actual,
            } => write!(f, "{field} must be {expected} bytes, got {actual}"),
            Self::OverBudget => f.write_str("the profiles flatten to more rows than fit in memory"),
            Self::Encode(detail) => write!(f, "failed to encode a profile row: {detail}"),
        }
    }
}

/// What the gateway sets on every resource before its rows are written, the way
/// it does for logs: the sender never decides the org or the source.
#[derive(Debug, Default)]
pub struct ResourceStamps {
    /// Keys only the gateway may set: the sender's values are dropped.
    pub reserved: &'static [&'static str],
    /// Set where the sender left the key out.
    pub defaults: Vec<(String, String)>,
    /// Set whatever the sender sent.
    pub set: Vec<(String, String)>,
    /// The period the rows' source keeps profiles for, written on every row.
    pub retention_days: Option<u16>,
}

/// A source's resource overrides: `set` replaces whatever the sender sent, `defaults` fill a
/// key it left out. The gateway's own `maple_*` stamps are not overrides: they stay in
/// `ResourceStamps`, applied by the flatten where nothing can redact them.
#[derive(Debug, Default, Clone)]
pub struct ResourceOverrides {
    pub defaults: Vec<(String, String)>,
    pub set: Vec<(String, String)>,
}

impl ResourceOverrides {
    pub fn is_empty(&self) -> bool {
        self.defaults.is_empty() && self.set.is_empty()
    }
}

/// Applies `overrides` to every resource of `request` before the org's rules run, so the rules
/// see an override as they do on traces and logs. Keys named by string-table index count as
/// their text. Each resource's added pairs and key set are charged to `charge` first; false
/// when it refuses.
pub fn apply_resource_overrides(
    request: &mut ExportProfilesServiceRequest,
    overrides: &ResourceOverrides,
    mut charge: impl FnMut(u64) -> bool,
) -> bool {
    if overrides.is_empty() {
        return true;
    }
    let strings = request
        .dictionary
        .as_ref()
        .map_or(&[][..], |dictionary| dictionary.string_table.as_slice());
    let added: u64 = overrides
        .defaults
        .iter()
        .chain(&overrides.set)
        .map(|(key, value)| {
            (key.len() + value.len() + size_of::<KeyValue>() + size_of::<AnyValue>()) as u64
        })
        .sum();
    // Each override key's role: replaced (`set`) and which default it is.
    let mut roles: HashMap<&str, KeyRole> = HashMap::new();
    for (index, (key, _)) in overrides.defaults.iter().enumerate() {
        roles.entry(key.as_str()).or_default().default = Some(index);
    }
    for (key, _) in &overrides.set {
        roles.entry(key.as_str()).or_default().set = true;
    }
    // A string-table key's role, worked out once per index for the whole request: a reference
    // costs a few wire bytes, and its text is hashed only the first time it is named.
    let mut by_index: HashMap<i32, Option<KeyRole>> = HashMap::new();
    let mut role_of = |kv: &KeyValue| -> Option<KeyRole> {
        if !kv.key.is_empty() {
            return roles.get(kv.key.as_str()).copied();
        }
        if kv.key_strindex == 0 {
            return None;
        }
        *by_index.entry(kv.key_strindex).or_insert_with(|| {
            usize::try_from(kv.key_strindex)
                .ok()
                .and_then(|index| strings.get(index))
                .and_then(|text| roles.get(text.as_str()).copied())
        })
    };
    for resource_profiles in &mut request.resource_profiles {
        let resource = resource_profiles.resource.get_or_insert_with(Resource::default);
        // The pairs added, and a cached role per attribute's string-table index at most.
        let lookups = (resource.attributes.len() * size_of::<(i32, Option<KeyRole>)>()) as u64;
        if !charge(added.saturating_add(lookups)) {
            return false;
        }
        let mut present = vec![false; overrides.defaults.len()];
        resource.attributes.retain(|kv| {
            let Some(role) = role_of(kv) else {
                return true;
            };
            if let Some(index) = role.default {
                present[index] = true;
            }
            !role.set
        });
        let text = |key: &str, value: &str| KeyValue {
            key: key.to_owned(),
            value: Some(AnyValue {
                value: Some(any_value::Value::StringValue(value.to_owned())),
            }),
            ..KeyValue::default()
        };
        for (index, (key, value)) in overrides.defaults.iter().enumerate() {
            let replaced = roles.get(key.as_str()).is_some_and(|role| role.set);
            if !present[index] && !replaced {
                resource.attributes.push(text(key, value));
            }
        }
        for (key, value) in &overrides.set {
            resource.attributes.push(text(key, value));
        }
    }
    true
}

/// What an override does to a key: `set` replaces the sender's value, `default` (the index of
/// the default naming it) fills it only when the sender left it out.
#[derive(Clone, Copy, Debug, Default)]
struct KeyRole {
    set: bool,
    default: Option<usize>,
}

/// The total of per-key JSON lengths.
fn sum_lens(lens: &BTreeMap<i32, usize>) -> usize {
    lens.values().fold(0, |sum, len| sum.saturating_add(*len))
}

/// The rows of one export, each one NDJSON line for the `profiles` datasource.
#[derive(Debug, Default)]
pub struct Flattened {
    pub rows: Vec<Vec<u8>>,
    /// Profiles in the request, the unit OTLP's partial success counts.
    pub profile_count: usize,
    /// Rows left out because they would serialize past the row ceiling.
    pub dropped_rows: usize,
    /// Profiles that lost at least one row to the ceiling: OTLP's `rejected_profiles`.
    pub rejected_profiles: usize,
}

/// An id for a profile sent without one: sixteen random bytes.
pub fn random_profile_id() -> [u8; 16] {
    uuid::Uuid::new_v4().into_bytes()
}

/// Flattens `request` into rows. `now_nano` stamps a profile that carries no time
/// of its own, and `new_profile_id` names one that carries no id. A row that would
/// pass `max_row_bytes` is dropped and counted. `reserve` is asked for memory before
/// anything takes it, and refusing ends the flatten: a small export can name one
/// long stack from a million samples, or one attribute that expands as it is read.
pub fn flatten<'a>(
    request: &'a ExportProfilesServiceRequest,
    stamps: &'a ResourceStamps,
    now_nano: u64,
    new_profile_id: &mut dyn FnMut() -> [u8; 16],
    max_row_bytes: usize,
    reserve: &mut dyn FnMut(u64) -> bool,
) -> Result<Flattened, FlattenError> {
    let mut dictionary = Dictionary::new(request.dictionary.as_ref());
    // Escaped lengths and attribute costs, worked out once per request: a sample can
    // name one attribute, and attributes one long string, any number of times.
    let mut meter = Meter {
        reserve,
        held: 0,
        spent: 0,
    };
    meter.charge(
        dictionary.strings.len() * (size_of::<usize>() + size_of::<i32>() + 3 * NODE_BYTES / 4)
            + dictionary.attributes.len() * size_of::<Option<Cost>>(),
    )?;
    let string_lens: Vec<usize> = dictionary
        .strings
        .iter()
        .map(|text| json_text_len(text))
        .collect();
    dictionary.string_lens = &string_lens;
    // One index per distinct text: a table may hold the same key twice, and a key named
    // through either index replaces the other in a map.
    let mut first_of: HashMap<&str, i32> = HashMap::with_capacity(dictionary.strings.len());
    let string_ids: Vec<i32> = (0..dictionary.strings.len())
        .map(|at| {
            let at = i32::try_from(at).unwrap_or(i32::MAX);
            *first_of.entry(dictionary.string(at)).or_insert(at)
        })
        .collect();
    drop(first_of);
    dictionary.string_ids = &string_ids;
    let attribute_costs: Vec<Option<Cost>> = dictionary
        .attributes
        .iter()
        .map(|entry| dictionary.entry_cost(entry))
        .collect();
    dictionary.attribute_costs = &attribute_costs;
    let mut flattener = Flattener {
        dictionary,
        stacks: HashMap::new(),
        meter,
        new_profile_id,
        max_row_bytes,
        retention_days: stamps.retention_days,
        rows: Vec::new(),
        dropped_rows: 0,
        rejected_profiles: 0,
    };
    let mut profile_count = 0;
    for resource_profiles in &request.resource_profiles {
        let resource = flattener.dictionary.resource(
            resource_profiles.resource.as_ref(),
            stamps,
            &mut flattener.meter,
        )?;
        for scope_profiles in &resource_profiles.scope_profiles {
            for profile in &scope_profiles.profiles {
                profile_count += 1;
                flattener.profile(profile, &resource, now_nano)?;
            }
        }
    }
    Ok(Flattened {
        rows: flattener.rows,
        profile_count,
        dropped_rows: flattener.dropped_rows,
        rejected_profiles: flattener.rejected_profiles,
    })
}

type Attributes<'a> = BTreeMap<Cow<'a, str>, Cow<'a, str>>;

/// Bytes `text` takes inside a JSON string, escaped the way `serde_json` writes it.
fn json_text_len(text: &str) -> usize {
    text.bytes()
        .map(|byte| match byte {
            b'"' | b'\\' | 0x08 | b'\t' | b'\n' | 0x0c | b'\r' => 2,
            // Every other control character is written as `\u00XX`.
            0x00..=0x1f => 6,
            _ => 1,
        })
        .sum()
}

/// What a value costs once read: the bytes its string form takes inside a JSON
/// string, escaping included, and the heap building it takes. Both are bounds,
/// worked out from the wire form before anything is built.
#[derive(Clone, Copy, Default)]
struct Cost {
    json_len: usize,
    heap: usize,
}

/// A map entry, or a node of a JSON tree, beyond the text it holds.
const NODE_BYTES: usize = 128;

/// One entry of a hash map from a small key to a small value, growth included.
const MAP_ENTRY_BYTES: usize = 64;

/// `text` cut to its first `MAX_FRAME_TEXT` characters, with nothing appended.
fn clip(text: &str) -> &str {
    // Characters are never more than bytes, so short text is not scanned.
    if text.len() <= MAX_FRAME_TEXT {
        return text;
    }
    text.char_indices()
        .nth(MAX_FRAME_TEXT)
        .map_or(text, |(end, _)| &text[..end])
}

/// A line number as the Int32 column holds it: a sender's nonsense reads as unknown.
fn line_cell(line: i64) -> i64 {
    if (0..=i64::from(i32::MAX)).contains(&line) {
        line
    } else {
        0
    }
}

/// Memory the flatten holds beyond the decoded request, reserved ahead in steps.
struct Meter<'r> {
    reserve: &'r mut dyn FnMut(u64) -> bool,
    held: u64,
    spent: u64,
}

impl Meter<'_> {
    const STEP: u64 = 256 * 1024;

    fn charge(&mut self, bytes: usize) -> Result<(), FlattenError> {
        self.spent = self.spent.saturating_add(bytes as u64);
        if self.spent > self.held {
            let ask = (self.spent - self.held).max(Self::STEP);
            if !(self.reserve)(ask) {
                return Err(FlattenError::OverBudget);
            }
            self.held = self.held.saturating_add(ask);
        }
        Ok(())
    }
}

/// The request's dictionary tables. An index outside a table reads as absent.
#[derive(Clone, Copy)]
struct Dictionary<'a> {
    strings: &'a [String],
    mappings: &'a [Mapping],
    locations: &'a [Location],
    functions: &'a [Function],
    links: &'a [Link],
    attributes: &'a [KeyValueAndUnit],
    stacks: &'a [Stack],
    /// Each string's length inside a JSON string, by string-table index.
    string_lens: &'a [usize],
    /// The first index holding each string's text, by string-table index.
    string_ids: &'a [i32],
    /// What reading each attribute-table entry costs; `None` for one never read.
    attribute_costs: &'a [Option<Cost>],
}

fn at<T>(table: &[T], index: i32) -> Option<&T> {
    usize::try_from(index)
        .ok()
        .and_then(|index| table.get(index))
}

fn base_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Lowercase hex of an id, empty when the id is absent or all zero.
fn id_hex(bytes: &[u8], expected: usize, field: &'static str) -> Result<String, FlattenError> {
    if !bytes.is_empty() && bytes.len() != expected {
        return Err(FlattenError::InvalidId {
            field,
            expected,
            actual: bytes.len(),
        });
    }
    Ok(bytes_hex(bytes))
}

impl<'a> Dictionary<'a> {
    fn new(dictionary: Option<&'a ProfilesDictionary>) -> Self {
        let Some(dictionary) = dictionary else {
            return Self {
                strings: &[],
                mappings: &[],
                locations: &[],
                functions: &[],
                links: &[],
                attributes: &[],
                stacks: &[],
                string_lens: &[],
                string_ids: &[],
                attribute_costs: &[],
            };
        };
        Self {
            strings: &dictionary.string_table,
            mappings: &dictionary.mapping_table,
            locations: &dictionary.location_table,
            functions: &dictionary.function_table,
            links: &dictionary.link_table,
            attributes: &dictionary.attribute_table,
            stacks: &dictionary.stack_table,
            string_lens: &[],
            string_ids: &[],
            attribute_costs: &[],
        }
    }

    /// Index 0 is the empty string, as the spec has it, whatever a sender put there: the
    /// gateway's redaction reads keys and values the same way.
    fn string(&self, index: i32) -> &'a str {
        if index == 0 {
            return "";
        }
        at(self.strings, index).map_or("", String::as_str)
    }

    /// `json_text_len` of a string-table entry, looked up rather than scanned.
    fn string_len(&self, index: i32) -> usize {
        if index == 0 {
            return json_text_len("");
        }
        at(self.string_lens, index).copied().unwrap_or(0)
    }

    /// `json_text_len` of a key, looked up when it is a string-table index.
    fn key_len(&self, attribute: &KeyValue) -> usize {
        if attribute.key.is_empty() {
            self.string_len(attribute.key_strindex)
        } else {
            json_text_len(&attribute.key)
        }
    }

    /// A key spelled out, or named by string-table index as collectors send them.
    fn key(&self, attribute: &'a KeyValue) -> &'a str {
        if attribute.key.is_empty() {
            self.string(attribute.key_strindex)
        } else {
            attribute.key.as_str()
        }
    }

    /// A value's string form. Since proto v1.10 a string may be a string-table index,
    /// at any depth of an array or a map.
    fn value(&self, value: Option<&'a AnyValue>) -> Cow<'a, str> {
        match value.and_then(|any| any.value.as_ref().map(|inner| (any, inner))) {
            Some((_, any_value::Value::StringValueStrindex(index))) => {
                Cow::Borrowed(self.string(*index))
            }
            Some((_, any_value::Value::StringValue(text))) => Cow::Borrowed(text.as_str()),
            Some((any, any_value::Value::ArrayValue(_) | any_value::Value::KvlistValue(_))) => {
                // Written into the bound it was charged for, so it never grows past it.
                let mut text = Vec::with_capacity(self.json_bound(any).0);
                serde_json::to_writer(&mut text, &self.json(any)).unwrap_or_default();
                Cow::Owned(String::from_utf8(text).unwrap_or_default())
            }
            Some((any, _)) => Cow::Owned(any_value_string(any)),
            None => Cow::Borrowed(""),
        }
    }

    /// An array or map as `any_value_json` writes it, with string-table references
    /// resolved, keys included.
    fn json(&self, value: &'a AnyValue) -> serde_json::Value {
        match value.value.as_ref() {
            Some(any_value::Value::ArrayValue(array)) => {
                serde_json::Value::Array(array.values.iter().map(|each| self.json(each)).collect())
            }
            Some(any_value::Value::KvlistValue(list)) => serde_json::Value::Object(
                list.values
                    .iter()
                    .map(|entry| {
                        let value = entry
                            .value
                            .as_ref()
                            .map_or(serde_json::Value::from(""), |each| self.json(each));
                        (self.key(entry).to_owned(), value)
                    })
                    .collect(),
            ),
            _ => serde_json::Value::String(self.value(Some(value)).into_owned()),
        }
    }

    /// Bytes a scalar's string form takes inside a JSON string, at most.
    fn scalar_len(&self, value: &AnyValue) -> usize {
        match value.value.as_ref() {
            Some(any_value::Value::StringValue(text)) => json_text_len(text),
            Some(any_value::Value::StringValueStrindex(index)) => self.string_len(*index),
            Some(any_value::Value::BoolValue(_)) => 5,
            Some(any_value::Value::IntValue(_)) => 20,
            // `f64` displays every digit: `f64::MAX` is 309 of them.
            Some(any_value::Value::DoubleValue(_)) => 330,
            // Readable text as itself, binary as hex: two bytes per byte at most.
            Some(any_value::Value::BytesValue(bytes)) => 2 * bytes.len(),
            Some(any_value::Value::ArrayValue(_) | any_value::Value::KvlistValue(_)) | None => 0,
        }
    }

    /// Bytes `value` takes as JSON text, quotes included, and the nodes of the tree
    /// it is written from.
    fn json_bound(&self, value: &AnyValue) -> (usize, usize) {
        match value.value.as_ref() {
            Some(any_value::Value::ArrayValue(array)) => {
                array.values.iter().fold((2, 1), |(len, nodes), each| {
                    let (each_len, each_nodes) = self.json_bound(each);
                    (len + each_len + 1, nodes + each_nodes)
                })
            }
            Some(any_value::Value::KvlistValue(list)) => {
                list.values.iter().fold((2, 1), |(len, nodes), entry| {
                    let (each_len, each_nodes) = entry
                        .value
                        .as_ref()
                        .map_or((2, 1), |each| self.json_bound(each));
                    let key = self.key_len(entry);
                    (len + key + 4 + each_len, nodes + each_nodes + 1)
                })
            }
            _ => (self.scalar_len(value) + 2, 1),
        }
    }

    /// What reading `value` costs, before it is read.
    fn value_cost(&self, value: Option<&AnyValue>) -> Cost {
        let Some(any) = value else {
            return Cost::default();
        };
        match any.value.as_ref() {
            Some(any_value::Value::StringValue(_) | any_value::Value::StringValueStrindex(_))
            | None => Cost {
                json_len: self.scalar_len(any),
                heap: 0,
            },
            Some(any_value::Value::ArrayValue(_) | any_value::Value::KvlistValue(_)) => {
                let (len, nodes) = self.json_bound(any);
                // The text is escaped again inside the row; building it holds the
                // tree's strings, its nodes and the text at once.
                Cost {
                    json_len: 2 * len,
                    heap: 2 * len + nodes * NODE_BYTES,
                }
            }
            Some(_) => {
                let len = self.scalar_len(any);
                Cost {
                    json_len: len,
                    heap: len,
                }
            }
        }
    }

    /// A resource's attributes with the gateway's stamps applied, each charged to
    /// `meter` before it is read.
    fn resource(
        &self,
        resource: Option<&'a Resource>,
        stamps: &'a ResourceStamps,
        meter: &mut Meter<'_>,
    ) -> Result<StampedResource<'a>, FlattenError> {
        let mut attributes = Attributes::new();
        // Each entry's JSON length, carried beside it: a value is never rescanned to size the
        // map, however many keys share it.
        let mut lens: BTreeMap<&'a str, usize> = BTreeMap::new();
        let listed = resource.map_or(&[][..], |resource| resource.attributes.as_slice());
        // A key named by string-table index counts at its last naming only, so the maps below
        // compare each such key's text once however often it repeats.
        // Charged before it is built: its size is the sender's.
        meter.charge(listed.len() * MAP_ENTRY_BYTES)?;
        let mut last_named: HashMap<i32, usize> = HashMap::new();
        for (at, attribute) in listed.iter().enumerate() {
            if attribute.key.is_empty() {
                last_named.insert(self.key_id(attribute.key_strindex), at);
            }
        }
        let kept = listed.iter().enumerate().filter(|(at, attribute)| {
            !attribute.key.is_empty()
                || last_named.get(&self.key_id(attribute.key_strindex)) == Some(at)
        });
        for (_, attribute) in kept {
            // An attribute needs a key, as a table entry does: one without is left out.
            let key = self.key(attribute);
            if key.is_empty() {
                continue;
            }
            let cost = self.value_cost(attribute.value.as_ref());
            meter.charge(2 * NODE_BYTES + cost.heap)?;
            lens.insert(key, self.key_len(attribute) + cost.json_len + 6);
            attributes.insert(Cow::Borrowed(key), self.value(attribute.value.as_ref()));
        }
        for key in stamps.reserved {
            attributes.remove(*key);
            lens.remove(*key);
        }
        meter.charge(2 * NODE_BYTES * (stamps.defaults.len() + stamps.set.len()))?;
        let stamped = |key: &str, value: &str| json_text_len(key) + json_text_len(value) + 6;
        for (key, value) in &stamps.defaults {
            if !lens.contains_key(key.as_str()) {
                lens.insert(key, stamped(key, value));
                attributes.insert(Cow::Borrowed(key.as_str()), Cow::Borrowed(value.as_str()));
            }
        }
        for (key, value) in &stamps.set {
            lens.insert(key, stamped(key, value));
            attributes.insert(Cow::Borrowed(key.as_str()), Cow::Borrowed(value.as_str()));
        }
        let mut resource = StampedResource {
            attributes,
            json_len: 0,
        };
        // The map, and the four columns that repeat a value of it.
        let columns = [
            resource.get("service.name").unwrap_or(""),
            resource.get("service.version").unwrap_or(""),
            resource.environment(),
            resource.get("service.instance.id").unwrap_or(""),
        ];
        resource.json_len = lens.values().sum::<usize>()
            + columns.into_iter().map(json_text_len).sum::<usize>();
        Ok(resource)
    }

    /// The dictionary attributes `indices` name, as `indexed_attributes` reads them.
    fn indexed_entries(
        &self,
        indices: &'a [i32],
    ) -> impl Iterator<Item = (&'a str, &'a KeyValueAndUnit)> + '_ {
        indices.iter().filter_map(|index| {
            let entry = at(self.attributes, *index)?;
            let key = self.string(entry.key_strindex);
            (!key.is_empty()).then_some((key, entry))
        })
    }

    /// What reading one attribute-table entry costs; `None` for one with no key,
    /// which is never read.
    fn entry_cost(&self, entry: &KeyValueAndUnit) -> Option<Cost> {
        if self.string(entry.key_strindex).is_empty() {
            return None;
        }
        let value = self.value_cost(entry.value.as_ref());
        Some(Cost {
            json_len: self.string_len(entry.key_strindex) + value.json_len + 6,
            heap: NODE_BYTES + value.heap,
        })
    }

    /// What reading the attributes `indices` name costs, before they are read: one
    /// lookup per index, whatever the entries hold.
    fn indexed_cost(&self, indices: &[i32]) -> Cost {
        indices
            .iter()
            .filter_map(|index| at(self.attribute_costs, *index).copied().flatten())
            .fold(Cost::default(), |cost, each| Cost {
                json_len: cost.json_len.saturating_add(each.json_len),
                heap: cost.heap.saturating_add(each.heap),
            })
    }

    /// The JSON length of the map the attributes `indices` name: a key named again replaces
    /// its earlier value, so each key counts once, at its last value. Keys are compared by
    /// the first index holding their text, never by scanning the text again.
    fn indexed_json_len(&self, indices: &[i32]) -> usize {
        sum_lens(&self.indexed_json_lens(indices))
    }

    /// Each key's JSON length in the map the attributes `indices` name, by key id, at its
    /// last value.
    fn indexed_json_lens(&self, indices: &[i32]) -> BTreeMap<i32, usize> {
        let mut entries: BTreeMap<i32, usize> = BTreeMap::new();
        for index in indices {
            let Some(entry) = at(self.attributes, *index) else {
                continue;
            };
            if let Some(cost) = at(self.attribute_costs, *index).copied().flatten() {
                entries.insert(self.key_id(entry.key_strindex), cost.json_len);
            }
        }
        entries
    }

    /// Sample and profile attributes, looked up in the dictionary's attribute table.
    /// A key named again replaces its earlier value, so each key is resolved once, at its
    /// last reference, before any text is compared.
    fn indexed_attributes(&self, indices: &'a [i32], out: &mut Attributes<'a>) {
        let mut last: BTreeMap<i32, (&'a str, &'a KeyValueAndUnit)> = BTreeMap::new();
        for (key, entry) in self.indexed_entries(indices) {
            last.insert(self.key_id(entry.key_strindex), (key, entry));
        }
        for (key, entry) in last.into_values() {
            out.insert(Cow::Borrowed(key), self.value(entry.value.as_ref()));
        }
    }

    /// The first string-table index holding the same text as `index`.
    fn key_id(&self, index: i32) -> i32 {
        at(self.string_ids, index).copied().unwrap_or(index)
    }

    /// A producer that counts samples (the eBPF profiler: `samples`/`count` every
    /// `period` CPU nanoseconds) is stored in the period's terms, so its rows sum
    /// with a time-valued producer's.
    fn value_terms(&self, profile: &Profile) -> ValueTerms<'a> {
        let text = |value_type: Option<ValueType>, pick: fn(ValueType) -> i32| {
            self.string(value_type.map_or(0, pick))
        };
        let sample_type = text(profile.sample_type, |value| value.type_strindex);
        let unit = text(profile.sample_type, |value| value.unit_strindex);
        let period_unit = text(profile.period_type, |value| value.unit_strindex);
        if unit == "count" && period_unit == "nanoseconds" && profile.period > 0 {
            let period_type = text(profile.period_type, |value| value.type_strindex);
            return ValueTerms {
                sample_type: if period_type.is_empty() {
                    sample_type
                } else {
                    period_type
                },
                unit: period_unit,
                scale: i128::from(profile.period),
            };
        }
        ValueTerms {
            sample_type: if sample_type.is_empty() {
                "unknown"
            } else {
                sample_type
            },
            unit,
            scale: 1,
        }
    }

    /// A stack's frames as the wire has them: leaf first, and a location's inlined
    /// lines innermost first. Lazy, so a hostile stack is never built whole.
    fn frames(self, index: i32) -> impl Iterator<Item = Frame<'a>> {
        let locations = at(self.stacks, index).map_or(&[][..], |stack| &stack.location_indices);
        locations
            .iter()
            .filter_map(move |index| at(self.locations, *index))
            .flat_map(move |location| {
                let unsymbolized = location
                    .lines
                    .is_empty()
                    .then(|| self.address_frame(location));
                let lines = location.lines.iter().map(move |line| self.line_frame(line));
                unsymbolized.into_iter().chain(lines)
            })
    }

    /// Unsymbolized (native, eBPF): the mapping's file and the address inside it.
    fn address_frame(self, location: &Location) -> Frame<'a> {
        let mapping = at(self.mappings, location.mapping_index);
        let file = self.string(mapping.map_or(0, |mapping| mapping.filename_strindex));
        Frame {
            name: FrameName::Address {
                file: (!file.is_empty()).then(|| clip(base_name(file))),
                address: location.address,
            },
            file: clip(file),
            line: 0,
        }
    }

    fn line_frame(self, line: &Line) -> Frame<'a> {
        let function = at(self.functions, line.function_index);
        let text = |pick: fn(&Function) -> i32| self.string(function.map_or(0, pick));
        let name = [
            text(|function| function.name_strindex),
            text(|function| function.system_name_strindex),
        ]
        .into_iter()
        .find(|name| !name.is_empty())
        .unwrap_or("(anonymous)");
        Frame {
            name: FrameName::Function(clip(name)),
            file: clip(text(|function| function.filename_strindex)),
            line: line_cell(if line.line == 0 {
                function.map_or(0, |function| function.start_line)
            } else {
                line.line
            }),
        }
    }

    /// How many frames `stack` will hold for this index: what it allocates.
    fn stack_depth(self, index: i32) -> usize {
        self.frames(index).take(MAX_STACK_DEPTH + 1).count()
    }

    /// Root first, in a `Vec` of `depth` frames (`stack_depth`). One frame past the
    /// cap says the cap was passed: the frames kept are the first ones on the wire.
    fn stack(self, index: i32, depth: usize) -> ResolvedStack<'a> {
        let mut frames: Vec<Frame<'a>> = Vec::with_capacity(depth);
        frames.extend(self.frames(index).take(depth));
        if frames.len() > MAX_STACK_DEPTH {
            frames.truncate(MAX_STACK_DEPTH - 1);
            frames.push(Frame {
                name: FrameName::Function("(truncated)"),
                file: "",
                line: 0,
            });
        }
        frames.reverse();
        // Each frame's name, file and line as JSON writes them, escaping included.
        let json_len = frames
            .iter()
            .map(|frame| frame.name.json_len() + json_text_len(frame.file) + 32)
            .sum();
        ResolvedStack { frames, json_len }
    }
}

struct ValueTerms<'a> {
    sample_type: &'a str,
    unit: &'a str,
    scale: i128,
}

/// A resource's stamped attributes, which every row of it repeats.
struct StampedResource<'a> {
    attributes: Attributes<'a>,
    json_len: usize,
}

impl StampedResource<'_> {
    fn get(&self, key: &str) -> Option<&str> {
        self.attributes.get(key).map(|value| &**value)
    }

    fn environment(&self) -> &str {
        self.get("deployment.environment.name")
            .or_else(|| self.get("deployment.environment"))
            .unwrap_or("")
    }
}

/// A frame's name: borrowed from the string table, so a stack costs no text.
enum FrameName<'a> {
    Function(&'a str),
    /// `<file>+0x<address>`, or the address alone when the mapping names no file.
    Address {
        file: Option<&'a str>,
        address: u64,
    },
}

impl FrameName<'_> {
    /// `+0x` and the sixteen hex digits of an address.
    const ADDRESS_LEN: usize = 19;

    /// Bytes the name takes inside a JSON string, at most.
    fn json_len(&self) -> usize {
        match self {
            Self::Function(name) => json_text_len(name),
            Self::Address { file, .. } => file.map_or(0, json_text_len) + Self::ADDRESS_LEN,
        }
    }
}

impl fmt::Display for FrameName<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Function(name) => f.write_str(name),
            Self::Address {
                file: None,
                address,
            } => write!(f, "0x{address:x}"),
            Self::Address {
                file: Some(file),
                address,
            } if file.len() + Self::ADDRESS_LEN <= MAX_FRAME_TEXT => {
                write!(f, "{file}+0x{address:x}")
            }
            // Clipped as one name: a file name near the cap leaves the address less room.
            Self::Address {
                file: Some(file),
                address,
            } => {
                let room = MAX_FRAME_TEXT.saturating_sub(file.chars().count());
                let address = format!("+0x{address:x}");
                f.write_str(file)?;
                f.write_str(address.get(..room).unwrap_or(&address))
            }
        }
    }
}

impl Serialize for FrameName<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Function(name) => serializer.serialize_str(name),
            Self::Address { .. } => serializer.collect_str(self),
        }
    }
}

struct Frame<'a> {
    name: FrameName<'a>,
    file: &'a str,
    line: i64,
}

struct ResolvedStack<'a> {
    frames: Vec<Frame<'a>>,
    json_len: usize,
}

/// One column of a stack's parallel `frames`, `frame_files` and `frame_lines`.
struct FrameColumn<'s, 'a, T>(&'s [Frame<'a>], fn(&'s Frame<'a>) -> T);

impl<T: Serialize> Serialize for FrameColumn<'_, '_, T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_seq(self.0.iter().map(self.1))
    }
}

/// An Int64 cell: a number while a double holds it exactly, else the decimal
/// string ClickHouse also reads.
struct Int64Cell(i128);

impl Int64Cell {
    /// `value` as an Int64 column holds it: past either bound is the bound.
    fn clamped(value: i128) -> Self {
        Self(value.clamp(i128::from(i64::MIN), i128::from(i64::MAX)))
    }
}

impl Serialize for Int64Cell {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        const MAX_SAFE_INTEGER: i128 = 9_007_199_254_740_991;
        match i64::try_from(self.0) {
            Ok(value) if self.0.abs() <= MAX_SAFE_INTEGER => serializer.serialize_i64(value),
            _ => serializer.collect_str(&self.0),
        }
    }
}

/// The samples of one stack, span link and attribute set within a profile.
struct Group<'a> {
    stack_index: i32,
    link_index: i32,
    attribute_indices: &'a [i32],
    value: i128,
    samples: u64,
    /// The earliest sample timestamp, 0 when the samples carry none.
    first_nano: u64,
}

/// Keys in the order the `profiles` insert mapping selects them.
#[derive(Serialize)]
struct Row<'r, 'a> {
    timestamp: String,
    service_name: &'r str,
    service_version: &'r str,
    environment: &'r str,
    service_instance_id: &'r str,
    resource_attributes: &'r Attributes<'a>,
    profile_id: &'r str,
    sample_type: &'r str,
    sample_unit: &'r str,
    value: Int64Cell,
    samples: u64,
    duration_nano: Int64Cell,
    frames: FrameColumn<'r, 'a, &'r FrameName<'a>>,
    frame_files: FrameColumn<'r, 'a, &'a str>,
    frame_lines: FrameColumn<'r, 'a, i64>,
    trace_id: String,
    span_id: String,
    sample_attributes: Attributes<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    retention_days: Option<u16>,
}

/// The keys, ids and numbers of a row, before anything the sender sized.
const ROW_FIXED_BYTES: usize = 672;
/// A resolved stack or a group in its map, beyond what its frames take.
const ENTRY_BYTES: usize = 256;

struct Flattener<'a, 'r> {
    dictionary: Dictionary<'a>,
    /// Resolved once per stack index: most samples share a few stacks.
    stacks: HashMap<i32, ResolvedStack<'a>>,
    meter: Meter<'r>,
    new_profile_id: &'r mut dyn FnMut() -> [u8; 16],
    max_row_bytes: usize,
    /// What every row is stamped with; the gateway's, never the sender's.
    retention_days: Option<u16>,
    rows: Vec<Vec<u8>>,
    dropped_rows: usize,
    rejected_profiles: usize,
}

impl<'a> Flattener<'a, '_> {
    fn has_frames(&mut self, stack_index: i32) -> Result<bool, FlattenError> {
        if let Some(stack) = self.stacks.get(&stack_index) {
            return Ok(!stack.frames.is_empty());
        }
        // Counted first, so the frames are charged before they are allocated.
        let depth = self.dictionary.stack_depth(stack_index);
        self.meter
            .charge(ENTRY_BYTES + depth * size_of::<Frame<'_>>())?;
        let stack = self.dictionary.stack(stack_index, depth);
        let has_frames = !stack.frames.is_empty();
        self.stacks.insert(stack_index, stack);
        Ok(has_frames)
    }

    /// A profile's samples summed per stack, link and attribute set, in the order
    /// each first appears.
    fn groups(&mut self, profile: &'a Profile) -> Result<Vec<Group<'a>>, FlattenError> {
        let mut groups: Vec<Group<'a>> = Vec::new();
        let mut group_of: HashMap<(i32, i32, &'a [i32]), usize> = HashMap::new();
        for sample in &profile.samples {
            // A sample whose stack resolves to nothing has nowhere to be drawn.
            if !self.has_frames(sample.stack_index)? {
                continue;
            }
            // Timestamps without values are one observation each.
            let value = if sample.values.is_empty() {
                sample.timestamps_unix_nano.len() as i128
            } else {
                sample.values.iter().copied().map(i128::from).sum()
            };
            let samples = sample
                .values
                .len()
                .max(sample.timestamps_unix_nano.len())
                .max(1) as u64;
            let first_nano = sample
                .timestamps_unix_nano
                .iter()
                .copied()
                .filter(|nano| *nano > 0)
                .min()
                .unwrap_or(0);
            let key = (
                sample.stack_index,
                sample.link_index,
                sample.attribute_indices.as_slice(),
            );
            let Some(index) = group_of.get(&key) else {
                self.meter.charge(ENTRY_BYTES)?;
                group_of.insert(key, groups.len());
                groups.push(Group {
                    stack_index: sample.stack_index,
                    link_index: sample.link_index,
                    attribute_indices: &sample.attribute_indices,
                    value,
                    samples,
                    first_nano,
                });
                continue;
            };
            let group = &mut groups[*index];
            group.value = group.value.saturating_add(value);
            group.samples = group.samples.saturating_add(samples);
            if first_nano > 0 && (group.first_nano == 0 || first_nano < group.first_nano) {
                group.first_nano = first_nano;
            }
        }
        Ok(groups)
    }

    fn profile(
        &mut self,
        profile: &'a Profile,
        resource: &StampedResource<'a>,
        now_nano: u64,
    ) -> Result<(), FlattenError> {
        let groups = self.groups(profile)?;
        if groups.is_empty() {
            return Ok(());
        }

        let terms = self.dictionary.value_terms(profile);
        let profile_nano = if profile.time_unix_nano == 0 {
            now_nano
        } else {
            profile.time_unix_nano
        };
        let mut profile_id = id_hex(&profile.profile_id, TRACE_ID_BYTES, "profile.profileId")?;
        // Every row of a profile shares its id, so one sent without gets its own.
        if profile_id.is_empty() {
            profile_id = bytes_hex(&(self.new_profile_id)());
        }
        let profile_cost = self.dictionary.indexed_cost(&profile.attribute_indices);
        self.meter.charge(profile_cost.heap)?;
        let mut profile_attributes = Attributes::new();
        self.dictionary
            .indexed_attributes(&profile.attribute_indices, &mut profile_attributes);
        // Summed from the entries' worked-out lengths, never by rescanning their values; the
        // heap charge above still counts every reference.
        let profile_lens = self.dictionary.indexed_json_lens(&profile.attribute_indices);
        let profile_attributes_len = sum_lens(&profile_lens);
        let shared_len = ROW_FIXED_BYTES
            + resource.json_len
            + json_text_len(terms.sample_type)
            + json_text_len(terms.unit);
        let mut rejected = false;

        for group in &groups {
            let Some(stack) = self.stacks.get(&group.stack_index) else {
                continue;
            };
            // The most the row can serialize to, escaping included, known before
            // anything of it is built: a row repeats text the wire held once.
            let sample_cost = self.dictionary.indexed_cost(group.attribute_indices);
            // The merged map: a sample's value replaces the profile's for the same key, so
            // that key is counted once, at the sample's length.
            self.meter
                .charge(group.attribute_indices.len() * MAP_ENTRY_BYTES)?;
            let sample_lens = self.dictionary.indexed_json_lens(group.attribute_indices);
            let replaced = sample_lens
                .keys()
                .filter_map(|key| profile_lens.get(key))
                .fold(0_usize, |sum, len| sum.saturating_add(*len));
            let row_len = shared_len + stack.json_len + profile_attributes_len - replaced
                + sum_lens(&sample_lens);
            if row_len > self.max_row_bytes {
                self.dropped_rows += 1;
                rejected = true;
                continue;
            }
            // The row, the copy of it the WAL frame is built from, and the
            // attributes it is built from.
            self.meter
                .charge(2 * row_len + profile_cost.heap + sample_cost.heap)?;
            let mut sample_attributes = profile_attributes.clone();
            self.dictionary
                .indexed_attributes(group.attribute_indices, &mut sample_attributes);

            let link = at(self.dictionary.links, group.link_index);
            let id = |pick: fn(&Link) -> &[u8], bytes: usize, field: &'static str| {
                id_hex(link.map_or(&[][..], pick), bytes, field)
            };
            let row = Row {
                timestamp: format_timestamp_nano(if group.first_nano == 0 {
                    profile_nano
                } else {
                    group.first_nano
                }),
                service_name: resource.get("service.name").unwrap_or(""),
                service_version: resource.get("service.version").unwrap_or(""),
                environment: resource.environment(),
                service_instance_id: resource.get("service.instance.id").unwrap_or(""),
                resource_attributes: &resource.attributes,
                profile_id: &profile_id,
                sample_type: terms.sample_type,
                sample_unit: terms.unit,
                value: Int64Cell::clamped(group.value.saturating_mul(terms.scale)),
                samples: group.samples,
                duration_nano: Int64Cell::clamped(i128::from(profile.duration_nano)),
                frames: FrameColumn(&stack.frames, |frame| &frame.name),
                frame_files: FrameColumn(&stack.frames, |frame| frame.file),
                frame_lines: FrameColumn(&stack.frames, |frame| frame.line),
                trace_id: id(|link| &link.trace_id, TRACE_ID_BYTES, "link.traceId")?,
                span_id: id(|link| &link.span_id, SPAN_ID_BYTES, "link.spanId")?,
                sample_attributes,
                retention_days: self.retention_days,
            };
            let mut line = Vec::with_capacity(row_len);
            serde_json::to_writer(&mut line, &row)
                .map_err(|error| FlattenError::Encode(error.to_string()))?;
            debug_assert!(line.len() <= row_len, "a row outgrew its bound");
            self.rows.push(line);
        }
        if rejected {
            self.rejected_profiles += 1;
        }
        Ok(())
    }
}

/// Decodes an OTLP/JSON profiles export. The generated types' serde derives do not
/// read it (they want every field present, 64-bit integers as numbers and link ids
/// as byte arrays), so the body is read into the shapes below and converted.
pub fn decode_json(payload: &[u8]) -> Result<ExportProfilesServiceRequest, String> {
    if payload.iter().find(|byte| !byte.is_ascii_whitespace()) != Some(&b'{') {
        return Err("an export request is a JSON object".to_owned());
    }
    serde_json::from_slice::<JsonRequest>(payload)
        .map_err(|error| error.to_string())?
        .into_request()
}

/// Forgiving the way `atob` is, which is what the TypeScript flattener reads ids with.
const BASE64: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_padding_mode(DecodePaddingMode::Indifferent)
        .with_decode_allow_trailing_bits(true),
);

/// An id as bytes. OTLP/JSON writes ids as hex; proto3 JSON, which some senders
/// emit, writes base64. The two never collide at an id's exact hex length.
fn id_bytes(text: Option<String>, bytes: usize, field: &str) -> Result<Vec<u8>, String> {
    let text = text.unwrap_or_default();
    if text.len() == bytes * 2 && text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        let nibble = |byte: u8| match byte {
            b'0'..=b'9' => byte - b'0',
            b'a'..=b'f' => byte - b'a' + 10,
            _ => byte - b'A' + 10,
        };
        return Ok(text
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| nibble(pair[0]) << 4 | nibble(pair[1]))
            .collect());
    }
    BASE64
        .decode(text.as_bytes())
        .map_err(|_| format!("{field} is neither {} hex characters nor base64", bytes * 2))
}

/// An integer the JSON form is read into. A value past its bounds is the bound:
/// a sender's nonsense is stored, never a refused export.
trait JsonInt: Sized {
    fn saturating(value: i128) -> Self;
}

macro_rules! json_int {
    ($($int:ty),*) => {$(
        impl JsonInt for $int {
            fn saturating(value: i128) -> Self {
                Self::try_from(value).unwrap_or(if value < 0 { Self::MIN } else { Self::MAX })
            }
        }
    )*};
}

json_int!(i32, i64, u64);

/// An OTLP/JSON integer: a number, or a decimal string as 64-bit ones are written.
struct Int<T>(T);

impl<'de, T: JsonInt> Deserialize<'de> for Int<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct IntVisitor<T>(PhantomData<T>);

        impl<T: JsonInt> Visitor<'_> for IntVisitor<T> {
            type Value = Int<T>;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("an integer as a number or a decimal string")
            }

            fn visit_i64<E: de::Error>(self, value: i64) -> Result<Self::Value, E> {
                Ok(Int(T::saturating(i128::from(value))))
            }

            fn visit_u64<E: de::Error>(self, value: u64) -> Result<Self::Value, E> {
                Ok(Int(T::saturating(i128::from(value))))
            }

            /// An integer written with a fraction part or an exponent (`12.0`, `1e3`).
            fn visit_f64<E: de::Error>(self, value: f64) -> Result<Self::Value, E> {
                if value.fract() != 0.0 {
                    return Err(E::invalid_value(de::Unexpected::Float(value), &self));
                }
                #[expect(
                    clippy::cast_possible_truncation,
                    reason = "integral, and a float past an i128 saturates at its bounds"
                )]
                let wide = value as i128;
                Ok(Int(T::saturating(wide)))
            }

            fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
                let digits = value.strip_prefix('-').unwrap_or(value);
                if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
                    return Err(E::invalid_value(de::Unexpected::Str(value), &self));
                }
                // Digits past an i128 are past every column: the sign names the bound.
                let wide = value
                    .parse::<i128>()
                    .unwrap_or(if digits.len() == value.len() {
                        i128::MAX
                    } else {
                        i128::MIN
                    });
                Ok(Int(T::saturating(wide)))
            }
        }

        deserializer.deserialize_any(IntVisitor(PhantomData))
    }
}

fn ints<T>(values: Option<Vec<Int<T>>>) -> Vec<T> {
    values
        .unwrap_or_default()
        .into_iter()
        .map(|Int(value)| value)
        .collect()
}

fn int<T: Default>(value: Option<Int<T>>) -> T {
    value.map_or_else(T::default, |Int(value)| value)
}

#[derive(Deserialize)]
#[serde(untagged)]
enum JsonDouble {
    Number(f64),
    Text(String),
}

// Every field is optional and may be null, as proto3 JSON allows.

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct JsonRequest {
    resource_profiles: Option<Vec<JsonResourceProfiles>>,
    dictionary: Option<JsonDictionary>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct JsonResourceProfiles {
    resource: Option<JsonResource>,
    scope_profiles: Option<Vec<JsonScopeProfiles>>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct JsonResource {
    attributes: Option<Vec<JsonKeyValue>>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct JsonScopeProfiles {
    profiles: Option<Vec<JsonProfile>>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct JsonProfile {
    sample_type: Option<JsonValueType>,
    samples: Option<Vec<JsonSample>>,
    time_unix_nano: Option<Int<u64>>,
    duration_nano: Option<Int<u64>>,
    period_type: Option<JsonValueType>,
    period: Option<Int<i64>>,
    profile_id: Option<String>,
    attribute_indices: Option<Vec<Int<i32>>>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct JsonValueType {
    type_strindex: Option<Int<i32>>,
    unit_strindex: Option<Int<i32>>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct JsonSample {
    stack_index: Option<Int<i32>>,
    attribute_indices: Option<Vec<Int<i32>>>,
    link_index: Option<Int<i32>>,
    values: Option<Vec<Int<i64>>>,
    timestamps_unix_nano: Option<Vec<Int<u64>>>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
#[expect(clippy::struct_field_names, reason = "the wire's own field names")]
struct JsonDictionary {
    mapping_table: Option<Vec<JsonMapping>>,
    location_table: Option<Vec<JsonLocation>>,
    function_table: Option<Vec<JsonFunction>>,
    link_table: Option<Vec<JsonLink>>,
    string_table: Option<Vec<String>>,
    attribute_table: Option<Vec<JsonKeyValue>>,
    stack_table: Option<Vec<JsonStack>>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct JsonMapping {
    filename_strindex: Option<Int<i32>>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct JsonLocation {
    mapping_index: Option<Int<i32>>,
    address: Option<Int<u64>>,
    lines: Option<Vec<JsonLine>>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct JsonLine {
    function_index: Option<Int<i32>>,
    line: Option<Int<i64>>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct JsonFunction {
    name_strindex: Option<Int<i32>>,
    system_name_strindex: Option<Int<i32>>,
    filename_strindex: Option<Int<i32>>,
    start_line: Option<Int<i64>>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct JsonLink {
    trace_id: Option<String>,
    span_id: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct JsonStack {
    location_indices: Option<Vec<Int<i32>>>,
}

/// A resource attribute or an attribute-table entry: both name their key by
/// string-table index, and a resource attribute may spell it out instead.
#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct JsonKeyValue {
    key: Option<String>,
    key_strindex: Option<Int<i32>>,
    value: Option<JsonAnyValue>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct JsonAnyValue {
    string_value: Option<String>,
    bool_value: Option<bool>,
    int_value: Option<Int<i64>>,
    double_value: Option<JsonDouble>,
    array_value: Option<JsonArrayValue>,
    kvlist_value: Option<JsonKeyValueList>,
    bytes_value: Option<String>,
    string_value_strindex: Option<Int<i32>>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct JsonArrayValue {
    values: Option<Vec<JsonAnyValue>>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct JsonKeyValueList {
    values: Option<Vec<JsonKeyValue>>,
}

/// Each element of an optional JSON list, converted.
fn each<J, T>(
    list: Option<Vec<J>>,
    convert: impl FnMut(J) -> Result<T, String>,
) -> Result<Vec<T>, String> {
    list.unwrap_or_default().into_iter().map(convert).collect()
}

impl JsonAnyValue {
    /// The one value the object holds, picked in the order the TypeScript reads them.
    fn into_any_value(self) -> Result<AnyValue, String> {
        use any_value::Value;
        let value = if let Some(text) = self.string_value {
            Some(Value::StringValue(text))
        } else if let Some(Int(index)) = self.string_value_strindex {
            Some(Value::StringValueStrindex(index))
        } else if let Some(value) = self.bool_value {
            Some(Value::BoolValue(value))
        } else if let Some(Int(value)) = self.int_value {
            Some(Value::IntValue(value))
        } else if let Some(value) = self.double_value {
            Some(Value::DoubleValue(match value {
                JsonDouble::Number(value) => value,
                JsonDouble::Text(text) => text
                    .parse()
                    .map_err(|_| "doubleValue is not a number".to_owned())?,
            }))
        } else if let Some(text) = self.bytes_value {
            Some(Value::BytesValue(
                BASE64
                    .decode(text.as_bytes())
                    .map_err(|_| "bytesValue is not base64".to_owned())?,
            ))
        } else if let Some(array) = self.array_value {
            Some(Value::ArrayValue(ArrayValue {
                values: each(array.values, Self::into_any_value)?,
            }))
        } else if let Some(list) = self.kvlist_value {
            Some(Value::KvlistValue(KeyValueList {
                values: each(list.values, JsonKeyValue::into_key_value)?,
            }))
        } else {
            None
        };
        Ok(AnyValue { value })
    }
}

impl JsonKeyValue {
    fn any_value(value: Option<JsonAnyValue>) -> Result<Option<AnyValue>, String> {
        value.map(JsonAnyValue::into_any_value).transpose()
    }

    fn into_key_value(self) -> Result<KeyValue, String> {
        Ok(KeyValue {
            key: self.key.unwrap_or_default(),
            key_strindex: int(self.key_strindex),
            value: Self::any_value(self.value)?,
        })
    }

    /// A table entry names its key by `keyStrindex` only: the wire type has no inline key, so
    /// one sent with `key` is refused rather than stored without its attribute.
    fn into_table_entry(self) -> Result<KeyValueAndUnit, String> {
        if self.key.as_deref().is_some_and(|key| !key.is_empty()) {
            return Err("attributeTable entries name their key by keyStrindex, not key".to_owned());
        }
        Ok(KeyValueAndUnit {
            key_strindex: int(self.key_strindex),
            value: Self::any_value(self.value)?,
            unit_strindex: 0,
        })
    }
}

impl JsonValueType {
    fn into_value_type(self) -> ValueType {
        ValueType {
            type_strindex: int(self.type_strindex),
            unit_strindex: int(self.unit_strindex),
        }
    }
}

impl JsonProfile {
    fn into_profile(self) -> Result<Profile, String> {
        Ok(Profile {
            sample_type: self.sample_type.map(JsonValueType::into_value_type),
            samples: each(self.samples, |sample| {
                Ok(Sample {
                    stack_index: int(sample.stack_index),
                    attribute_indices: ints(sample.attribute_indices),
                    link_index: int(sample.link_index),
                    values: ints(sample.values),
                    timestamps_unix_nano: ints(sample.timestamps_unix_nano),
                })
            })?,
            time_unix_nano: int(self.time_unix_nano),
            duration_nano: int(self.duration_nano),
            period_type: self.period_type.map(JsonValueType::into_value_type),
            period: int(self.period),
            profile_id: id_bytes(self.profile_id, TRACE_ID_BYTES, "profileId")?,
            attribute_indices: ints(self.attribute_indices),
            ..Profile::default()
        })
    }
}

impl JsonDictionary {
    fn into_dictionary(self) -> Result<ProfilesDictionary, String> {
        Ok(ProfilesDictionary {
            mapping_table: each(self.mapping_table, |mapping| {
                Ok(Mapping {
                    filename_strindex: int(mapping.filename_strindex),
                    ..Mapping::default()
                })
            })?,
            location_table: each(self.location_table, |location| {
                Ok(Location {
                    mapping_index: int(location.mapping_index),
                    address: int(location.address),
                    lines: each(location.lines, |line| {
                        Ok(Line {
                            function_index: int(line.function_index),
                            line: int(line.line),
                            column: 0,
                        })
                    })?,
                    attribute_indices: Vec::new(),
                })
            })?,
            function_table: each(self.function_table, |function| {
                Ok(Function {
                    name_strindex: int(function.name_strindex),
                    system_name_strindex: int(function.system_name_strindex),
                    filename_strindex: int(function.filename_strindex),
                    start_line: int(function.start_line),
                })
            })?,
            link_table: each(self.link_table, |link| {
                Ok(Link {
                    trace_id: id_bytes(link.trace_id, TRACE_ID_BYTES, "traceId")?,
                    span_id: id_bytes(link.span_id, SPAN_ID_BYTES, "spanId")?,
                })
            })?,
            string_table: self.string_table.unwrap_or_default(),
            attribute_table: each(self.attribute_table, JsonKeyValue::into_table_entry)?,
            stack_table: each(self.stack_table, |stack| {
                Ok(Stack {
                    location_indices: ints(stack.location_indices),
                })
            })?,
        })
    }
}

impl JsonRequest {
    fn into_request(self) -> Result<ExportProfilesServiceRequest, String> {
        Ok(ExportProfilesServiceRequest {
            resource_profiles: each(self.resource_profiles, |resource_profiles| {
                Ok(ResourceProfiles {
                    resource: resource_profiles
                        .resource
                        .map(|resource| {
                            Ok::<_, String>(Resource {
                                attributes: each(
                                    resource.attributes,
                                    JsonKeyValue::into_key_value,
                                )?,
                                ..Resource::default()
                            })
                        })
                        .transpose()?,
                    scope_profiles: each(resource_profiles.scope_profiles, |scope_profiles| {
                        Ok(ScopeProfiles {
                            scope: None,
                            profiles: each(scope_profiles.profiles, JsonProfile::into_profile)?,
                            schema_url: String::new(),
                        })
                    })?,
                    schema_url: String::new(),
                })
            })?,
            dictionary: self
                .dictionary
                .map(JsonDictionary::into_dictionary)
                .transpose()?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use prost::Message;
    use serde_json::{json, Value};

    const NOW_NANO: u64 = 1_763_200_000_000_000_000;

    /// The id a profile sent without one is given in these tests.
    const GIVEN_PROFILE_ID: [u8; 16] = [0xab; 16];

    fn test_profile_id() -> [u8; 16] {
        GIVEN_PROFILE_ID
    }
    const TRACE_ID: &str = "0af7651916cd43dd8448eb211c80319c";
    const SPAN_ID: &str = "b7ad6b7169203331";

    /// The fixture of `packages/local-server/src/otlp/profiles.test.ts`: the same
    /// tables and samples have to give the same rows here. Index 0 of every table
    /// is the spec's zero entry.
    fn dictionary() -> Value {
        json!({
            "stringTable": [
                "", "cpu", "nanoseconds", "main", "handleRequest", "parseBody",
                "/app/server.js", "service.name", "checkout", "thread.name",
                "samples", "count", "libc.so.6",
            ],
            "functionTable": [
                {},
                { "nameStrindex": 3, "filenameStrindex": 6, "startLine": 1 },
                { "nameStrindex": 4, "filenameStrindex": 6, "startLine": 10 },
                { "nameStrindex": 5, "filenameStrindex": 6, "startLine": 40 },
            ],
            "mappingTable": [{}, { "filenameStrindex": 12 }],
            "locationTable": [
                {},
                { "lines": [{ "functionIndex": 1, "line": 3 }] },
                { "lines": [{ "functionIndex": 2, "line": 12 }] },
                // Inlined: parseBody was inlined into handleRequest, innermost first.
                { "lines": [{ "functionIndex": 3, "line": 44 }, { "functionIndex": 2, "line": 15 }] },
                { "mappingIndex": 1, "address": 4660 },
            ],
            // Leaf first on the wire.
            "stackTable": [
                {},
                { "locationIndices": [2, 1] },
                { "locationIndices": [3, 1] },
                { "locationIndices": [4, 2, 1] },
            ],
            // Base64, as the reference's fixture has them; hex is read too.
            "linkTable": [
                {},
                { "traceId": "CvdlGRbNQ92ESOshHIAxnA==", "spanId": "t61rcWkgMzE=" },
                { "traceId": TRACE_ID, "spanId": SPAN_ID },
            ],
            "attributeTable": [{}, { "keyStrindex": 9, "value": { "stringValue": "worker-1" } }],
        })
    }

    #[expect(
        clippy::needless_pass_by_value,
        reason = "every caller builds the samples inline"
    )]
    fn cpu_request(samples: Value) -> Value {
        json!({
            "resourceProfiles": [{
                "resource": {
                    "attributes": [
                        // Key and value both interned, as collectors from v0.161 send them.
                        { "keyStrindex": 7, "value": { "stringValueStrindex": 8 } },
                        { "key": "service.version", "value": { "stringValue": "1.4.0" } },
                        { "key": "deployment.environment.name", "value": { "stringValue": "prod" } },
                    ],
                },
                "scopeProfiles": [{
                    "profiles": [{
                        "sampleType": { "typeStrindex": 1, "unitStrindex": 2 },
                        "timeUnixNano": "1763200000000000000",
                        "durationNano": "10000000000",
                        "profileId": TRACE_ID,
                        "samples": samples,
                    }],
                }],
            }],
            "dictionary": dictionary(),
        })
    }

    fn decode(request: &Value) -> ExportProfilesServiceRequest {
        decode_json(&serde_json::to_vec(request).unwrap()).expect("the fixture decodes")
    }

    fn rows_with(request: &ExportProfilesServiceRequest, stamps: &ResourceStamps) -> Vec<Value> {
        flatten(
            request,
            stamps,
            NOW_NANO,
            &mut test_profile_id,
            MAX_ROW_BYTES,
            &mut |_| true,
        )
        .expect("the fixture flattens")
        .rows
        .iter()
        .map(|row| serde_json::from_slice(row).expect("a row is JSON"))
        .collect()
    }

    fn rows_of(request: &Value) -> Vec<Value> {
        rows_with(&decode(request), &ResourceStamps::default())
    }

    #[test]
    fn writes_one_row_per_stack_with_root_first_frames_and_the_samples_summed() {
        let request = decode(&cpu_request(json!([
            { "stackIndex": 1, "values": ["4000000", "6000000"] },
            { "stackIndex": 1, "values": ["5000000"] },
            { "stackIndex": 2, "values": ["1000000"] },
        ])));
        let flattened = flatten(
            &request,
            &ResourceStamps::default(),
            NOW_NANO,
            &mut test_profile_id,
            MAX_ROW_BYTES,
            &mut |_| true,
        )
        .expect("the fixture flattens");
        assert_eq!(flattened.profile_count, 1);
        let rows = rows_with(&request, &ResourceStamps::default());
        let summary: Vec<_> = rows
            .iter()
            .map(|row| (&row["frames"], &row["value"], &row["samples"]))
            .collect();
        assert_eq!(
            summary,
            vec![
                (
                    &json!(["main", "handleRequest"]),
                    &json!(15_000_000),
                    &json!(3)
                ),
                (
                    &json!(["main", "handleRequest", "parseBody"]),
                    &json!(1_000_000),
                    &json!(1)
                ),
            ]
        );
        assert_eq!(
            rows[0]["frame_files"],
            json!(["/app/server.js", "/app/server.js"])
        );
        assert_eq!(rows[0]["frame_lines"], json!([3, 12]));
        assert_eq!(rows[1]["frame_lines"], json!([3, 15, 44]));
        assert_eq!(rows[0]["timestamp"], "2025-11-15 09:46:40.000000000");
        assert_eq!(rows[0]["duration_nano"], json!(10_000_000_000_u64));
        assert_eq!(rows[0]["profile_id"], TRACE_ID);
    }

    #[test]
    fn resolves_resource_attributes_sent_as_string_table_indices() {
        let rows = rows_of(&cpu_request(json!([{ "stackIndex": 1, "values": ["1"] }])));
        let row = &rows[0];
        assert_eq!(
            (
                &row["service_name"],
                &row["service_version"],
                &row["environment"]
            ),
            (&json!("checkout"), &json!("1.4.0"), &json!("prod"))
        );
        assert_eq!(row["resource_attributes"]["service.name"], "checkout");
    }

    #[test]
    fn resolves_string_table_indices_inside_lists_and_maps() {
        let mut request = cpu_request(json!([{ "stackIndex": 1, "values": ["1"] }]));
        request["resourceProfiles"][0]["resource"]["attributes"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "key": "process.threads",
                "value": { "arrayValue": { "values": [
                    { "stringValueStrindex": 8 },
                    { "kvlistValue": { "values": [
                        { "keyStrindex": 9, "value": { "stringValueStrindex": 3 } },
                    ] } },
                ] } },
            }));
        let rows = rows_of(&request);
        assert_eq!(
            rows[0]["resource_attributes"]["process.threads"],
            r#"["checkout",{"thread.name":"main"}]"#
        );
    }

    #[test]
    fn names_a_profile_sent_without_an_id() {
        let mut request = cpu_request(json!([
            { "stackIndex": 1, "values": ["1"] },
            { "stackIndex": 2, "values": ["1"] },
        ]));
        let profile = &mut request["resourceProfiles"][0]["scopeProfiles"][0]["profiles"][0];
        profile.as_object_mut().unwrap().remove("profileId");
        let rows = rows_of(&request);
        let given = "ab".repeat(16);
        assert_eq!(
            rows.iter()
                .map(|row| &row["profile_id"])
                .collect::<Vec<_>>(),
            vec![&json!(given), &json!(given)]
        );
    }

    /// A sample naming attributes `refs` times, each entry keyed by one long string:
    /// `entries` is how many attribute-table entries share that key.
    fn repeated_long_key(entries: usize, refs: usize) -> ExportProfilesServiceRequest {
        let mut request = decode(&cpu_request(json!([{ "stackIndex": 1, "values": ["1"] }])));
        let dictionary = request.dictionary.as_mut().unwrap();
        let key = i32::try_from(dictionary.string_table.len()).unwrap();
        dictionary.string_table.push("k".repeat(1024 * 1024));
        let first = i32::try_from(dictionary.attribute_table.len()).unwrap();
        dictionary
            .attribute_table
            .extend((0..entries).map(|_| KeyValueAndUnit {
                key_strindex: key,
                value: Some(AnyValue {
                    value: Some(any_value::Value::StringValueStrindex(key)),
                }),
                ..Default::default()
            }));
        let sample = &mut request.resource_profiles[0].scope_profiles[0].profiles[0].samples[0];
        sample.attribute_indices = (0..refs)
            .map(|at| first + i32::try_from(at % entries).unwrap())
            .collect();
        request
    }

    /// Flattens `request`, which must take nowhere near the seconds a rescan of its
    /// long string per reference would: about 100 GB of text here.
    fn flatten_quickly(request: &ExportProfilesServiceRequest) -> Flattened {
        let started = std::time::Instant::now();
        let flattened = flatten(
            request,
            &ResourceStamps::default(),
            NOW_NANO,
            &mut test_profile_id,
            MAX_ROW_BYTES,
            &mut |_| true,
        )
        .expect("the export flattens");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "took {:?}",
            started.elapsed()
        );
        flattened
    }

    /// `keys` distinct keys whose values all name one long string-table entry.
    fn shared_long_value(keys: usize) -> (ExportProfilesServiceRequest, i32) {
        let mut request = decode(&cpu_request(json!([{ "stackIndex": 1, "values": ["1"] }])));
        let dictionary = request.dictionary.as_mut().unwrap();
        let long = i32::try_from(dictionary.string_table.len()).unwrap();
        dictionary.string_table.push("v".repeat(1024 * 1024));
        let resource = request.resource_profiles[0].resource.as_mut().unwrap();
        resource.attributes.extend((0..keys).map(|at| KeyValue {
            key: format!("key.{at}"),
            value: Some(AnyValue {
                value: Some(any_value::Value::StringValueStrindex(long)),
            }),
            ..Default::default()
        }));
        (request, long)
    }

    #[test]
    fn sizes_resource_attributes_sharing_one_long_value_without_rescanning_it() {
        let (request, _) = shared_long_value(100_000);
        assert_eq!(flatten_quickly(&request).profile_count, 1);
    }

    #[test]
    fn sizes_profile_attributes_sharing_one_long_value_without_rescanning_it() {
        let (mut request, long) = shared_long_value(0);
        let dictionary = request.dictionary.as_mut().unwrap();
        let first_key = i32::try_from(dictionary.string_table.len()).unwrap();
        dictionary
            .string_table
            .extend((0..100_000).map(|at| format!("key.{at}")));
        let first_entry = i32::try_from(dictionary.attribute_table.len()).unwrap();
        dictionary
            .attribute_table
            .extend((0..100_000).map(|at| KeyValueAndUnit {
                key_strindex: first_key + at,
                value: Some(AnyValue {
                    value: Some(any_value::Value::StringValueStrindex(long)),
                }),
                ..Default::default()
            }));
        request.resource_profiles[0].scope_profiles[0].profiles[0].attribute_indices =
            (first_entry..first_entry + 100_000).collect();
        assert_eq!(flatten_quickly(&request).profile_count, 1);
    }

    #[test]
    fn counts_a_profile_attribute_named_again_once() {
        // One 1 MiB attribute, named four times: the row holds it once, well under 4 MiB.
        let mut request = decode(&cpu_request(json!([{ "stackIndex": 1, "values": ["1"] }])));
        let dictionary = request.dictionary.as_mut().unwrap();
        let long = i32::try_from(dictionary.string_table.len()).unwrap();
        dictionary.string_table.push("v".repeat(1024 * 1024));
        let entry = i32::try_from(dictionary.attribute_table.len()).unwrap();
        dictionary.attribute_table.push(KeyValueAndUnit {
            key_strindex: 9,
            value: Some(AnyValue {
                value: Some(any_value::Value::StringValueStrindex(long)),
            }),
            ..Default::default()
        });
        request.resource_profiles[0].scope_profiles[0].profiles[0].attribute_indices =
            vec![entry; 4];
        let flattened = flatten(
            &request,
            &ResourceStamps::default(),
            NOW_NANO,
            &mut test_profile_id,
            2 * 1024 * 1024,
            &mut |_| true,
        )
        .expect("the export flattens");
        assert_eq!((flattened.rows.len(), flattened.dropped_rows), (1, 0));
    }

    #[test]
    fn counts_one_key_held_twice_in_the_string_table_once() {
        // Two entries, the same key text at two string-table indices, a 1 MiB value each:
        // the row keeps the last, well under 2 MiB.
        let mut request = decode(&cpu_request(json!([{ "stackIndex": 1, "values": ["1"] }])));
        let dictionary = request.dictionary.as_mut().unwrap();
        let long = i32::try_from(dictionary.string_table.len()).unwrap();
        dictionary.string_table.push("v".repeat(1024 * 1024));
        let again = i32::try_from(dictionary.string_table.len()).unwrap();
        dictionary.string_table.push("thread.name".to_owned());
        let first = i32::try_from(dictionary.attribute_table.len()).unwrap();
        for key in [9, again] {
            dictionary.attribute_table.push(KeyValueAndUnit {
                key_strindex: key,
                value: Some(AnyValue {
                    value: Some(any_value::Value::StringValueStrindex(long)),
                }),
                ..Default::default()
            });
        }
        request.resource_profiles[0].scope_profiles[0].profiles[0].attribute_indices =
            vec![first, first + 1];
        let flattened = flatten(
            &request,
            &ResourceStamps::default(),
            NOW_NANO,
            &mut test_profile_id,
            2 * 1024 * 1024,
            &mut |_| true,
        )
        .expect("the export flattens");
        assert_eq!((flattened.rows.len(), flattened.dropped_rows), (1, 0));
    }

    #[test]
    fn builds_maps_of_long_keys_held_twice_without_comparing_them_per_reference() {
        // 100,000 references alternating between two copies of one 1 MiB key, in the
        // profile's attributes and in the resource's.
        let mut request = decode(&cpu_request(json!([{ "stackIndex": 1, "values": ["1"] }])));
        let dictionary = request.dictionary.as_mut().unwrap();
        let key = "k".repeat(1024 * 1024);
        let first = i32::try_from(dictionary.string_table.len()).unwrap();
        dictionary.string_table.extend([key.clone(), key]);
        let entry = i32::try_from(dictionary.attribute_table.len()).unwrap();
        for at in [first, first + 1] {
            dictionary.attribute_table.push(KeyValueAndUnit {
                key_strindex: at,
                value: Some(AnyValue {
                    value: Some(any_value::Value::StringValue("v".to_owned())),
                }),
                ..Default::default()
            });
        }
        request.resource_profiles[0].scope_profiles[0].profiles[0].attribute_indices =
            (0..100_000).map(|at| entry + at % 2).collect();
        let resource = request.resource_profiles[0].resource.as_mut().unwrap();
        resource
            .attributes
            .extend((0..100_000).map(|at| KeyValue {
                key_strindex: first + at % 2,
                value: Some(AnyValue {
                    value: Some(any_value::Value::StringValue("v".to_owned())),
                }),
                ..Default::default()
            }));
        assert_eq!(flatten_quickly(&request).profile_count, 1);
    }

    #[test]
    fn sizes_a_long_key_named_many_times_without_rescanning_it() {
        let flattened = flatten_quickly(&repeated_long_key(1, 100_000));
        assert_eq!(flattened.profile_count, 1);
    }

    #[test]
    fn sizes_many_entries_sharing_one_long_string_without_rescanning_it() {
        let flattened = flatten_quickly(&repeated_long_key(100_000, 100_000));
        assert_eq!(flattened.profile_count, 1);
    }

    #[test]
    fn counts_a_profile_that_lost_a_row_to_the_ceiling_once() {
        let mut request = cpu_request(json!([
            { "stackIndex": 1, "values": ["1"] },
            { "stackIndex": 1, "values": ["1"], "attributeIndices": [1] },
        ]));
        request["dictionary"]["attributeTable"][1]["value"]["stringValue"] =
            json!("x".repeat(4_096));
        let second = request["resourceProfiles"][0]["scopeProfiles"][0]["profiles"][0].clone();
        request["resourceProfiles"][0]["scopeProfiles"][0]["profiles"]
            .as_array_mut()
            .unwrap()
            .push(second);
        let flattened = flatten(
            &decode(&request),
            &ResourceStamps::default(),
            NOW_NANO,
            &mut test_profile_id,
            2_048,
            &mut |_| true,
        )
        .expect("the export flattens");
        assert_eq!(
            (
                flattened.rows.len(),
                flattened.dropped_rows,
                flattened.rejected_profiles,
                flattened.profile_count
            ),
            (2, 2, 2, 2)
        );
    }

    #[test]
    fn keeps_a_spans_samples_apart_and_stamps_them_with_its_first_sample() {
        let rows = rows_of(&cpu_request(json!([
            { "stackIndex": 1, "values": ["2"] },
            {
                "stackIndex": 1,
                "linkIndex": 1,
                "attributeIndices": [1],
                "values": ["3", "4"],
                "timestampsUnixNano": ["1763200005000000000", "1763200004000000000"],
            },
        ])));
        let links: Vec<_> = rows
            .iter()
            .map(|row| (&row["span_id"], &row["trace_id"], &row["value"]))
            .collect();
        assert_eq!(
            links,
            vec![
                (&json!(""), &json!(""), &json!(2)),
                (&json!(SPAN_ID), &json!(TRACE_ID), &json!(7)),
            ]
        );
        assert_eq!(rows[1]["timestamp"], "2025-11-15 09:46:44.000000000");
        assert_eq!(
            rows[1]["sample_attributes"],
            json!({ "thread.name": "worker-1" })
        );
        assert_eq!(rows[0]["sample_attributes"], json!({}));
    }

    #[test]
    fn reads_link_ids_as_hex_or_base64() {
        let rows = rows_of(&cpu_request(json!([
            { "stackIndex": 1, "linkIndex": 1, "values": ["1"] },
            { "stackIndex": 1, "linkIndex": 2, "values": ["1"] },
        ])));
        for row in &rows {
            assert_eq!(
                (&row["trace_id"], &row["span_id"]),
                (&json!(TRACE_ID), &json!(SPAN_ID))
            );
        }
    }

    #[test]
    fn stores_a_sample_counting_producer_in_the_periods_terms() {
        let mut request =
            cpu_request(json!([{ "stackIndex": 1, "timestampsUnixNano": ["1", "2", "3"] }]));
        let profile = &mut request["resourceProfiles"][0]["scopeProfiles"][0]["profiles"][0];
        profile["sampleType"] = json!({ "typeStrindex": 10, "unitStrindex": 11 });
        profile["periodType"] = json!({ "typeStrindex": 1, "unitStrindex": 2 });
        profile["period"] = json!("50000000");
        let rows = rows_of(&request);
        let row = &rows[0];
        assert_eq!(
            (
                &row["sample_type"],
                &row["sample_unit"],
                &row["value"],
                &row["samples"]
            ),
            (
                &json!("cpu"),
                &json!("nanoseconds"),
                &json!(150_000_000),
                &json!(3)
            )
        );
        // The earliest sample timestamp, not the profile's.
        assert_eq!(row["timestamp"], "1970-01-01 00:00:00.000000001");
    }

    #[test]
    fn names_a_sample_type_the_export_left_out() {
        let mut request = cpu_request(json!([{ "stackIndex": 1, "values": ["1"] }]));
        let profile = &mut request["resourceProfiles"][0]["scopeProfiles"][0]["profiles"][0];
        profile["sampleType"] = json!({});
        profile["timeUnixNano"] = json!(0);
        let rows = rows_of(&request);
        assert_eq!(rows[0]["sample_type"], "unknown");
        assert_eq!(rows[0]["sample_unit"], "");
        // A profile without a time of its own is stamped with the receipt time.
        assert_eq!(rows[0]["timestamp"], "2025-11-15 09:46:40.000000000");
    }

    #[test]
    fn names_an_unsymbolized_frame_by_its_mapping_and_address() {
        let mut request = cpu_request(json!([{ "stackIndex": 3, "values": ["1"] }]));
        let rows = rows_of(&request);
        assert_eq!(
            rows[0]["frames"],
            json!(["main", "handleRequest", "libc.so.6+0x1234"])
        );
        assert_eq!(
            rows[0]["frame_files"],
            json!(["/app/server.js", "/app/server.js", "libc.so.6"])
        );
        assert_eq!(rows[0]["frame_lines"], json!([3, 12, 0]));

        // A mapping with a path keeps its base name; one without a file is the address alone.
        request["dictionary"]["stringTable"][12] = json!("/usr/lib/libc.so.6");
        assert_eq!(rows_of(&request)[0]["frames"][2], "libc.so.6+0x1234");
        request["dictionary"]["mappingTable"] = json!([{}, {}]);
        assert_eq!(rows_of(&request)[0]["frames"][2], "0x1234");
    }

    #[test]
    fn drops_a_sample_whose_stack_is_empty() {
        let rows = rows_of(&cpu_request(json!([
            { "stackIndex": 0, "values": ["9"] },
            { "stackIndex": 99, "values": ["9"] },
            { "stackIndex": -1, "values": ["9"] },
        ])));
        assert_eq!(rows, Vec::<Value>::new());
    }

    #[test]
    fn keeps_the_leaf_side_of_a_stack_deeper_than_the_cap() {
        let depth = MAX_STACK_DEPTH + 40;
        let mut request = cpu_request(json!([{ "stackIndex": 1, "values": ["1"] }]));
        // Leaf first: location 2 (handleRequest) is the leaf, the rest are `main`.
        let mut locations = vec![2];
        locations.resize(depth, 1);
        request["dictionary"]["stackTable"] = json!([{}, { "locationIndices": locations }]);
        let rows = rows_of(&request);
        let frames = rows[0]["frames"].as_array().expect("frames is an array");
        assert_eq!(frames.len(), MAX_STACK_DEPTH);
        assert_eq!(
            (&frames[0], &frames[MAX_STACK_DEPTH - 1]),
            (&json!("(truncated)"), &json!("handleRequest"))
        );
        assert_eq!(
            rows[0]["frame_files"].as_array().map(Vec::len),
            Some(MAX_STACK_DEPTH)
        );
        assert_eq!(rows[0]["frame_lines"][0], 0);

        // A stack exactly at the cap is whole.
        locations.truncate(MAX_STACK_DEPTH);
        request["dictionary"]["stackTable"] = json!([{}, { "locationIndices": locations }]);
        let rows = rows_of(&request);
        let frames = rows[0]["frames"].as_array().expect("frames is an array");
        assert_eq!(
            (frames.len(), &frames[0]),
            (MAX_STACK_DEPTH, &json!("main"))
        );
    }

    #[test]
    fn reads_a_protobuf_export_the_same_as_its_json_form() {
        let request = decode(&cpu_request(json!([
            { "stackIndex": 2, "linkIndex": 1, "values": ["5"], "timestampsUnixNano": ["1763200001000000000"] },
            { "stackIndex": 3, "attributeIndices": [1], "values": [7, "8"] },
        ])));
        let via_protobuf = ExportProfilesServiceRequest::decode(request.encode_to_vec().as_slice())
            .expect("the request round-trips through protobuf");
        let stamps = ResourceStamps::default();
        let rows = rows_with(&request, &stamps);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows_with(&via_protobuf, &stamps), rows);
    }

    #[test]
    fn emits_exactly_the_fields_the_insert_mapping_reads() {
        let rows = rows_of(&cpu_request(json!([{ "stackIndex": 1, "values": ["1"] }])));
        let mut emitted: Vec<&str> = rows[0]
            .as_object()
            .expect("a row is an object")
            .keys()
            .map(String::as_str)
            .collect();
        emitted.sort_unstable();
        let mapping = crate::clickhouse_insert_mappings::mapping_for(DATASOURCE)
            .expect("the profiles mapping");
        let mut selects: Vec<&str> = mapping
            .selects
            .iter()
            .copied()
            .filter(|select| *select != crate::clickhouse_insert_mappings::ORG_PLACEHOLDER)
            .collect();
        selects.sort_unstable();
        assert_eq!(emitted, selects);
    }

    #[test]
    fn the_gateway_decides_the_org_whatever_the_sender_names() {
        let mut request = cpu_request(json!([{ "stackIndex": 1, "values": ["1"] }]));
        // Spelled out, and interned: neither may survive.
        request["dictionary"]["stringTable"]
            .as_array_mut()
            .expect("the string table")
            .extend([json!("maple_org_id"), json!("org_evil")]);
        request["resourceProfiles"][0]["resource"]["attributes"]
            .as_array_mut()
            .expect("the resource attributes")
            .extend([
                json!({ "key": "maple_org_id", "value": { "stringValue": "org_evil" } }),
                json!({ "keyStrindex": 13, "value": { "stringValueStrindex": 14 } }),
                json!({ "key": "org_id", "value": { "stringValue": "org_evil" } }),
            ]);
        let stamps = ResourceStamps {
            reserved: &["org_id", "maple_org_id"],
            defaults: vec![
                ("service.version".to_owned(), "0.0.0".to_owned()),
                ("team".to_owned(), "payments".to_owned()),
            ],
            set: vec![("maple_org_id".to_owned(), "org_real".to_owned())],
            retention_days: None,
        };
        let rows = rows_with(&decode(&request), &stamps);
        let attributes = &rows[0]["resource_attributes"];
        assert_eq!(attributes["maple_org_id"], "org_real");
        assert_eq!(attributes.get("org_id"), None);
        // A default fills a gap and leaves the sender's own value alone.
        assert_eq!(attributes["team"], "payments");
        assert_eq!(rows[0]["service_version"], "1.4.0");
    }

    #[test]
    fn an_id_of_the_wrong_length_is_refused() {
        let mut request =
            cpu_request(json!([{ "stackIndex": 1, "linkIndex": 1, "values": ["1"] }]));
        request["dictionary"]["linkTable"][1]["spanId"] = json!("b7ad6b71");
        let error = flatten(
            &decode(&request),
            &ResourceStamps::default(),
            NOW_NANO,
            &mut test_profile_id,
            MAX_ROW_BYTES,
            &mut |_| true,
        )
        .expect_err("a four-byte span id is not a span id");
        assert_eq!(
            error,
            FlattenError::InvalidId {
                field: "link.spanId",
                expected: 8,
                actual: 6
            }
        );
    }

    #[test]
    fn a_value_past_a_double_is_written_as_a_decimal_string() {
        let rows = rows_of(&cpu_request(json!([
            { "stackIndex": 1, "values": ["9007199254740991"] },
            { "stackIndex": 2, "values": ["9007199254740992"] },
        ])));
        assert_eq!(rows[0]["value"], json!(9_007_199_254_740_991_i64));
        assert_eq!(rows[1]["value"], json!("9007199254740992"));
    }

    #[test]
    fn the_flatten_stops_when_its_memory_is_refused() {
        let samples: Vec<Value> = (0..2_000)
            .map(|link| json!({ "stackIndex": 2, "linkIndex": link, "values": ["1"] }))
            .collect();
        let request = decode(&cpu_request(json!(samples)));
        let mut asked = 0_u64;
        let refused = flatten(
            &request,
            &ResourceStamps::default(),
            NOW_NANO,
            &mut test_profile_id,
            MAX_ROW_BYTES,
            &mut |bytes| {
                asked += bytes;
                asked <= 512 * 1024
            },
        );
        assert_eq!(
            refused.map(|flattened| flattened.rows.len()),
            Err(FlattenError::OverBudget)
        );

        // What it asks for covers the rows it goes on to build.
        let mut reserved = 0_u64;
        let flattened = flatten(
            &request,
            &ResourceStamps::default(),
            NOW_NANO,
            &mut test_profile_id,
            MAX_ROW_BYTES,
            &mut |bytes| {
                reserved += bytes;
                true
            },
        )
        .expect("an unbounded reserve never refuses");
        let row_bytes: usize = flattened.rows.iter().map(Vec::capacity).sum();
        assert_eq!(flattened.rows.len(), 2_000);
        assert!(
            reserved >= 2 * row_bytes as u64,
            "reserved {reserved} for {row_bytes} row bytes"
        );
    }

    /// The reference's `describe("hostile input", ...)`: a location inlining
    /// thousands of lines, on a stack that lists it thousands of times.
    fn hostile_stack(request: &mut Value) {
        let lines = vec![json!({ "functionIndex": 1, "line": 1 }); 5_000];
        request["dictionary"]["locationTable"] = json!([{}, { "lines": lines }]);
        request["dictionary"]["stackTable"] = json!([{}, { "locationIndices": vec![1; 5_000] }]);
    }

    #[test]
    fn never_builds_a_stack_whole() {
        let mut request = cpu_request(json!([{ "stackIndex": 1, "values": ["1"] }]));
        hostile_stack(&mut request);
        let rows = rows_of(&request);
        let frames = rows[0]["frames"].as_array().expect("frames is an array");
        assert_eq!(frames.len(), MAX_STACK_DEPTH);
        assert_eq!(
            (&frames[0], &frames[MAX_STACK_DEPTH - 1]),
            (&json!("(truncated)"), &json!("main"))
        );
    }

    #[test]
    fn a_hostile_stack_of_control_characters_stays_inside_the_row_ceiling_and_a_small_budget() {
        let mut request = cpu_request(json!([{ "stackIndex": 1, "values": ["1"] }]));
        hostile_stack(&mut request);
        // Every character of the name and the file escapes to six bytes.
        let control = "\u{1}".repeat(50_000);
        request["dictionary"]["stringTable"][3] = json!(control);
        request["dictionary"]["stringTable"][6] = json!(control);
        let request = decode(&request);
        let mut reserved = 0_u64;
        let flattened = flatten(
            &request,
            &ResourceStamps::default(),
            NOW_NANO,
            &mut test_profile_id,
            MAX_ROW_BYTES,
            &mut |bytes| {
                reserved += bytes;
                reserved <= 8 * 1024 * 1024
            },
        )
        .expect("one bounded row fits a small budget");
        assert_eq!((flattened.rows.len(), flattened.dropped_rows), (1, 0));
        let row = &flattened.rows[0];
        assert!(row.len() <= MAX_ROW_BYTES, "a row of {} bytes", row.len());
        // Charged before it was built: the row never outgrew what was reserved for it.
        assert!(
            reserved >= 2 * row.capacity() as u64,
            "reserved {reserved} for a row of {} bytes",
            row.capacity()
        );
        let row: Value = serde_json::from_slice(row).expect("a row is JSON");
        assert_eq!(
            row["frames"].as_array().map(Vec::len),
            Some(MAX_STACK_DEPTH)
        );
        let name = row["frames"][1].as_str().expect("a frame is a string");
        assert_eq!(name.chars().count(), MAX_FRAME_TEXT);
    }

    #[test]
    fn cuts_a_function_name_or_file_path_to_its_first_characters() {
        let mut request = cpu_request(json!([
            { "stackIndex": 1, "values": ["1"] },
            { "stackIndex": 3, "values": ["1"] },
        ]));
        let strings = &mut request["dictionary"]["stringTable"];
        strings[3] = json!("x".repeat(50_000));
        // Characters, not bytes: two bytes each here, and four each in the mapping's file.
        strings[6] = json!(format!("/{}", "\u{e9}".repeat(2_000)));
        strings[12] = json!(format!("/lib/{}", "\u{1f600}".repeat(MAX_FRAME_TEXT - 2)));
        let rows = rows_of(&request);
        let text = |value: &Value| value.as_str().expect("a string").to_owned();

        assert_eq!(text(&rows[0]["frames"][0]), "x".repeat(MAX_FRAME_TEXT));
        assert_eq!(
            text(&rows[0]["frame_files"][0]),
            format!("/{}", "\u{e9}".repeat(MAX_FRAME_TEXT - 1))
        );
        // Text at the cap is whole, and nothing is appended to text past it.
        assert_eq!(text(&rows[0]["frames"][1]), "handleRequest");

        // An unsymbolized frame's name is clipped as one text: the address gives way.
        let base = "\u{1f600}".repeat(MAX_FRAME_TEXT - 2);
        assert_eq!(text(&rows[1]["frames"][2]), format!("{base}+0"));
        assert_eq!(
            text(&rows[1]["frame_files"][2]),
            format!("/lib/{}", "\u{1f600}".repeat(MAX_FRAME_TEXT - 5))
        );
    }

    #[test]
    fn stores_values_the_columns_cannot_hold_as_their_nearest_bound() {
        let mut request =
            cpu_request(json!([{ "stackIndex": 1, "values": ["99999999999999999999"] }]));
        request["resourceProfiles"][0]["scopeProfiles"][0]["profiles"][0]["durationNano"] =
            json!("-5");
        // A line number no Int32 holds, as a JSON sender can write it.
        request["dictionary"]["locationTable"][1]["lines"][0]["line"] =
            json!("100000000000000000000");
        let rows = rows_of(&request);
        assert_eq!(
            (
                &rows[0]["value"],
                &rows[0]["duration_nano"],
                &rows[0]["frame_lines"]
            ),
            (&json!("9223372036854775807"), &json!(0), &json!([0, 12]))
        );

        // The protobuf form holds its own nonsense: the same bounds apply.
        let mut request = decode(&cpu_request(json!([
            { "stackIndex": 1, "values": [i64::MIN, i64::MIN] },
            { "stackIndex": 2, "values": [i64::MAX, 1] },
        ])));
        request.resource_profiles[0].scope_profiles[0].profiles[0].duration_nano = u64::MAX;
        let dictionary = request.dictionary.as_mut().expect("the dictionary");
        dictionary.location_table[1].lines[0].line = -7;
        dictionary.location_table[2].lines[0].line = i64::from(i32::MAX);
        dictionary.location_table[3].lines[0].line = i64::from(i32::MAX) + 1;
        let rows = rows_with(&request, &ResourceStamps::default());
        assert_eq!(rows[0]["value"], json!("-9223372036854775808"));
        assert_eq!(rows[1]["value"], json!("9223372036854775807"));
        assert_eq!(rows[0]["duration_nano"], json!("9223372036854775807"));
        assert_eq!(rows[0]["frame_lines"], json!([0, i32::MAX]));
        assert_eq!(rows[1]["frame_lines"], json!([0, 15, 0]));
    }

    #[test]
    fn reads_an_integer_written_as_a_float() {
        let mut request = cpu_request(json!([
            { "stackIndex": 1.0, "linkIndex": 0.0, "values": [3.0, 1e3], "attributeIndices": [1.0] },
        ]));
        request["dictionary"]["locationTable"][2]["lines"][0]["line"] = json!(12.0);
        request["resourceProfiles"][0]["scopeProfiles"][0]["profiles"][0]["durationNano"] =
            json!(2.5e9);
        let rows = rows_of(&request);
        assert_eq!(rows[0]["frame_lines"], json!([3, 12]));
        assert_eq!(rows[0]["value"], json!(1_003));
        assert_eq!(rows[0]["duration_nano"], json!(2_500_000_000_u64));
        assert_eq!(
            rows[0]["sample_attributes"],
            json!({ "thread.name": "worker-1" })
        );

        // A number with a fraction is not an integer, however it is written.
        for body in [
            r#"{"dictionary":{"locationTable":[{"lines":[{"line":12.5}]}]}}"#,
            r#"{"dictionary":{"stackTable":[{"locationIndices":[1.5]}]}}"#,
            r#"{"resourceProfiles":[{"scopeProfiles":[{"profiles":[{"period":"12.0"}]}]}]}"#,
        ] {
            assert!(
                decode_json(body.as_bytes()).is_err(),
                "{body} should be refused"
            );
        }
    }

    #[test]
    fn a_row_past_the_ceiling_is_dropped_and_counted() {
        let mut request = cpu_request(json!([
            { "stackIndex": 1, "attributeIndices": [1], "values": ["1"] },
            { "stackIndex": 2, "values": ["1"] },
        ]));
        // Attribute maps are the sender's to size: this one is past the ceiling below.
        request["dictionary"]["attributeTable"][1]["value"] =
            json!({ "stringValue": "v".repeat(4_096) });
        let request = decode(&request);
        let mut reserved = 0_u64;
        let flattened = flatten(
            &request,
            &ResourceStamps::default(),
            NOW_NANO,
            &mut test_profile_id,
            2_048,
            &mut |bytes| {
                reserved += bytes;
                true
            },
        )
        .expect("a dropped row is not an error");
        assert_eq!((flattened.rows.len(), flattened.dropped_rows), (1, 1));
        assert!(flattened.rows[0].len() <= 2_048);
        let kept: Value = serde_json::from_slice(&flattened.rows[0]).expect("a row is JSON");
        assert_eq!(
            kept["frames"],
            json!(["main", "handleRequest", "parseBody"])
        );
        // The dropped row was never built, so it reserved nothing.
        assert_eq!(reserved, Meter::STEP);
    }

    #[test]
    fn refuses_a_json_body_whose_tables_have_the_wrong_shape() {
        for body in [
            r#"{"dictionary":{"stringTable":"nope"}}"#,
            r#"{"resourceProfiles":{"a":1}}"#,
            r#"{"resourceProfiles":[{"scopeProfiles":[{"profiles":[{"period":"soon"}]}]}]}"#,
            r#"{"dictionary":{"linkTable":[{"traceId":"not an id!"}]}}"#,
            "[]",
            "not json",
        ] {
            assert!(
                decode_json(body.as_bytes()).is_err(),
                "{body} should be refused"
            );
        }
        // Absent and null fields are their defaults, as in proto3 JSON.
        let empty = decode_json(br#"{"resourceProfiles":null,"dictionary":{"stringTable":null}}"#)
            .expect("nulls are defaults");
        assert_eq!(empty.resource_profiles, Vec::new());
    }

    #[test]
    fn reads_only_development_version_one() {
        assert!(is_supported_version(None));
        assert!(is_supported_version(Some("1")));
        assert!(is_supported_version(Some(" 1 ")));
        assert!(!is_supported_version(Some("2")));
        assert!(!is_supported_version(Some("")));
    }

    /// A sample's attribute replaces the profile's under the same key, so a value both name is
    /// stored, and sized, once.
    #[test]
    fn sizes_an_attribute_the_profile_and_sample_share_once() {
        let long = "v".repeat(2 * 1024 * 1024 + 100 * 1024);
        let request = decode_json(
            serde_json::to_vec(&serde_json::json!({
                "resourceProfiles": [{ "scopeProfiles": [{ "profiles": [{
                    "attributeIndices": [1],
                    "samples": [{ "stackIndex": 1, "attributeIndices": [1], "values": ["1"] }],
                }] }] }],
                "dictionary": {
                    "stringTable": ["", "main", "shared"],
                    "functionTable": [{}, { "nameStrindex": 1 }],
                    "locationTable": [{}, { "lines": [{ "functionIndex": 1 }] }],
                    "stackTable": [{}, { "locationIndices": [1] }],
                    "attributeTable": [{}, { "keyStrindex": 2, "value": { "stringValue": long } }],
                },
            }))
            .expect("the export encodes")
            .as_slice(),
        )
        .expect("the export decodes");
        let rows = rows_with(&request, &ResourceStamps::default());
        assert_eq!(rows.len(), 1, "one copy of the value fits the row ceiling");
        assert_eq!(rows[0]["sample_attributes"]["shared"].as_str().map(str::len), Some(long.len()));
    }

    /// Overrides land on every resource as the flatten would apply them: `set` replaces the
    /// sender's value under its key (a string-table key included), `defaults` fill a missing key.
    #[test]
    fn applies_a_sources_overrides_to_each_resource() {
        let mut request = decode_json(
            serde_json::to_vec(&serde_json::json!({
                "resourceProfiles": [
                    { "resource": { "attributes": [
                        { "keyStrindex": 1, "value": { "stringValue": "sender" } },
                        { "key": "env", "value": { "stringValue": "staging" } },
                    ] } },
                    {},
                ],
                "dictionary": { "stringTable": ["", "team"] },
            }))
            .expect("the export encodes")
            .as_slice(),
        )
        .expect("the export decodes");
        let overrides = ResourceOverrides {
            set: vec![("team".to_owned(), "payments".to_owned())],
            defaults: vec![
                ("env".to_owned(), "prod".to_owned()),
                ("region".to_owned(), "eu".to_owned()),
            ],
        };
        let mut charged = 0u64;
        assert!(apply_resource_overrides(&mut request, &overrides, |bytes| {
            charged += bytes;
            true
        }));
        assert!(charged > 0);
        let pairs = |index: usize| -> Vec<(String, String)> {
            let mut pairs: Vec<(String, String)> = request.resource_profiles[index]
                .resource
                .as_ref()
                .expect("a resource")
                .attributes
                .iter()
                .map(|kv| {
                    let value = kv.value.as_ref().map(any_value_string).unwrap_or_default();
                    (kv.key.clone(), value)
                })
                .collect();
            pairs.sort();
            pairs
        };
        let pair = |key: &str, value: &str| (key.to_owned(), value.to_owned());
        assert_eq!(pairs(0), vec![pair("env", "staging"), pair("region", "eu"), pair("team", "payments")]);
        assert_eq!(pairs(1), vec![pair("env", "prod"), pair("region", "eu"), pair("team", "payments")]);
        // A refused charge stops before anything is added.
        assert!(!apply_resource_overrides(&mut request, &overrides, |_| false));
    }

    /// A string-table key is classified once per request, however many attributes and resources
    /// name it: a reference is a few wire bytes, its text may be a MiB.
    #[test]
    fn classifies_a_string_table_key_once_however_often_it_is_named() {
        let attribute = KeyValue {
            key_strindex: 1,
            value: Some(AnyValue {
                value: Some(any_value::Value::StringValue("v".to_owned())),
            }),
            ..KeyValue::default()
        };
        let resource = ResourceProfiles {
            resource: Some(Resource {
                attributes: vec![attribute; 10_000],
                ..Resource::default()
            }),
            ..ResourceProfiles::default()
        };
        let mut request = ExportProfilesServiceRequest {
            resource_profiles: vec![resource; 10],
            dictionary: Some(ProfilesDictionary {
                string_table: vec![String::new(), "k".repeat(1024 * 1024)],
                ..ProfilesDictionary::default()
            }),
        };
        let overrides = ResourceOverrides {
            set: vec![("team".to_owned(), "payments".to_owned())],
            defaults: vec![("region".to_owned(), "eu".to_owned())],
        };
        let started = std::time::Instant::now();
        assert!(apply_resource_overrides(&mut request, &overrides, |_| true));
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "took {:?}",
            started.elapsed()
        );
        let attributes = &request.resource_profiles[9].resource.as_ref().expect("a resource").attributes;
        assert_eq!(attributes.len(), 10_002);
    }

    /// An attribute-table entry with an inline key cannot be stored as sent, so the export is
    /// refused, never stored with that attribute silently missing.
    #[test]
    fn refuses_an_attribute_table_entry_with_an_inline_key() {
        let export = |entry: serde_json::Value| {
            serde_json::to_vec(&serde_json::json!({
                "dictionary": { "stringTable": ["", "thread.name"], "attributeTable": [{}, entry] },
            }))
            .expect("the export encodes")
        };
        let refused = decode_json(&export(serde_json::json!({
            "key": "thread.name", "value": { "stringValue": "main" },
        })));
        assert!(
            refused.as_ref().is_err_and(|error| error.to_string().contains("keyStrindex")),
            "{:?}",
            refused.map(|_| ())
        );
        // By index, or with an empty inline key beside the index, it decodes.
        for entry in [
            serde_json::json!({ "keyStrindex": 1, "value": { "stringValue": "main" } }),
            serde_json::json!({ "key": "", "keyStrindex": 1, "value": { "stringValue": "main" } }),
        ] {
            assert!(decode_json(&export(entry)).is_ok());
        }
    }

    /// A real export of the Maple SDK's Node profiler.
    const SDK_EXPORT: &[u8] = include_bytes!("testdata/profiles-sdk-node.json");

    #[test]
    fn flattens_a_real_sdk_export() {
        let request = decode_json(SDK_EXPORT).expect("the SDK's export decodes");
        let rows = rows_with(&request, &ResourceStamps::default());
        // 498 samples, each on a span or a stack of its own.
        assert_eq!(rows.len(), 498);
        let total: i64 = rows.iter().filter_map(|row| row["value"].as_i64()).sum();
        assert_eq!(total, 1_105_584_000);
        let linked = rows.iter().filter(|row| row["span_id"] != "").count();
        assert!(linked > 0, "the export links samples to spans");
        for row in &rows {
            assert_eq!(row["service_name"], "checkout-api");
            assert_eq!(row["environment"], "development");
            assert_eq!(row["sample_type"], "cpu");
            assert_eq!(row["sample_unit"], "nanoseconds");
            assert_eq!(row["profile_id"], "e31d5abeddb0f87424213bd27bc63fcf");
            let depth = row["frames"].as_array().map_or(0, Vec::len);
            assert!(depth > 0);
            assert_eq!(row["frame_files"].as_array().map(Vec::len), Some(depth));
            assert_eq!(row["frame_lines"].as_array().map(Vec::len), Some(depth));
        }
        // The same export as protobuf gives the same rows.
        let via_protobuf = ExportProfilesServiceRequest::decode(request.encode_to_vec().as_slice())
            .expect("the request round-trips through protobuf");
        assert_eq!(rows_with(&via_protobuf, &ResourceStamps::default()), rows);
    }
}
