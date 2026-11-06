//! What decoding an OTLP payload will allocate, estimated without allocating: each
//! element's decoded size, list growth and strings. Malformed input is left to the
//! decoder; the walker is never stricter, so all it would allocate for was charged.
//! Also the process-wide memory budget request bodies are decoded inside.

use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::common::v1::{
    AnyValue, ArrayValue, EntityRef, InstrumentationScope, KeyValue, KeyValueList,
};
use opentelemetry_proto::tonic::logs::v1::{LogRecord, ResourceLogs, ScopeLogs};
use opentelemetry_proto::tonic::metrics::v1::{
    exponential_histogram_data_point::Buckets, summary_data_point::ValueAtQuantile, Exemplar,
    ExponentialHistogram, ExponentialHistogramDataPoint, Gauge, Histogram, HistogramDataPoint,
    Metric, NumberDataPoint, ResourceMetrics, ScopeMetrics, Sum, Summary, SummaryDataPoint,
};
use opentelemetry_proto::tonic::resource::v1::Resource;
use opentelemetry_proto::tonic::trace::v1::{span, ResourceSpans, ScopeSpans, Span, Status};
use std::mem::size_of;
use std::sync::Arc;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// The process-wide budget for request bodies being decoded: their raw bytes, the
/// inflated bytes and the decoded form, reserved before each is allocated. A
/// reservation that does not fit fails at once, so the caller can shed the request.
#[derive(Clone, Debug)]
pub struct DecodeMemory {
    kibibytes: Arc<Semaphore>,
    total_bytes: u64,
}

/// Memory reserved for one request's decode, returned when dropped.
#[derive(Debug)]
pub struct DecodeReservation {
    memory: DecodeMemory,
    held: Option<OwnedSemaphorePermit>,
}

impl DecodeMemory {
    const UNIT: u64 = 1024;

    /// `total_bytes`, rounded down to whole KiB.
    pub fn new(total_bytes: u64) -> Self {
        let kibibytes = usize::try_from(total_bytes / Self::UNIT)
            .unwrap_or(Semaphore::MAX_PERMITS)
            .min(Semaphore::MAX_PERMITS);
        Self {
            kibibytes: Arc::new(Semaphore::new(kibibytes)),
            total_bytes,
        }
    }

    pub const fn total_bytes(&self) -> u64 {
        self.total_bytes
    }

    /// An empty reservation against this budget.
    pub fn reservation(&self) -> DecodeReservation {
        DecodeReservation {
            memory: self.clone(),
            held: None,
        }
    }

    /// Bytes reserved right now, across every request.
    pub fn reserved_bytes(&self) -> u64 {
        let total = self.total_bytes / Self::UNIT;
        total.saturating_sub(self.kibibytes.available_permits() as u64) * Self::UNIT
    }

    fn report(&self) {
        crate::metrics::decode_memory_reserved(self.reserved_bytes());
    }
}

impl DecodeReservation {
    /// Adds `bytes`, rounded up to whole KiB; `false` when they are not free now.
    pub fn try_add(&mut self, bytes: u64) -> bool {
        let Ok(kibibytes) = u32::try_from(bytes.div_ceil(DecodeMemory::UNIT)) else {
            return false;
        };
        if kibibytes == 0 {
            return true;
        }
        let Ok(permit) = Arc::clone(&self.memory.kibibytes).try_acquire_many_owned(kibibytes)
        else {
            return false;
        };
        match &mut self.held {
            Some(held) => held.merge(permit),
            None => self.held = Some(permit),
        }
        self.memory.report();
        true
    }

    /// Gives back all but `keep` bytes (rounded up to whole KiB) of what is held.
    pub fn shrink_to(&mut self, keep: u64) {
        let keep = usize::try_from(keep.div_ceil(DecodeMemory::UNIT)).unwrap_or(usize::MAX);
        if let Some(held) = &mut self.held {
            if let Some(release) = held.num_permits().checked_sub(keep) {
                drop(held.split(release));
                self.memory.report();
            }
        }
    }
}

impl Drop for DecodeReservation {
    fn drop(&mut self) {
        if self.held.take().is_some() {
            self.memory.report();
        }
    }
}

/// The uncompressed size a gzip body declares in its trailer, or `None` when it is
/// not gzip. The decoder verifies it, so a stream inflating past it is refused.
pub fn gzip_declared_len(body: &[u8]) -> Option<u64> {
    let (Some([0x1f, 0x8b, 0x08]), Some(trailer)) =
        (body.first_chunk::<3>(), body.last_chunk::<4>())
    else {
        return None;
    };
    (body.len() >= 18).then(|| u64::from(u32::from_le_bytes(*trailer)))
}

/// The OTLP export requests this module can cost.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OtlpSignal {
    Traces,
    Logs,
    Metrics,
}

/// The payload decodes to more than the budget allows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OverBudget;

/// Estimated bytes `prost` allocates decoding `payload`, failing once past `budget`.
pub fn protobuf_cost(signal: OtlpSignal, payload: &[u8], budget: u64) -> Result<u64, OverBudget> {
    let root = match signal {
        OtlpSignal::Traces => Msg::ExportTraces,
        OtlpSignal::Logs => Msg::ExportLogs,
        OtlpSignal::Metrics => Msg::ExportMetrics,
    };
    let mut meter = Meter::new(budget);
    meter.charge(root.size())?;
    match walk(root, payload, 0, &mut meter) {
        Ok(()) | Err(Stop::Malformed) => Ok(meter.total()),
        Err(Stop::OverBudget) => Err(OverBudget),
    }
}

/// Estimated bytes parsing `payload` as OTLP/JSON allocates: the `serde_json::Value`
/// tree and the typed request built from it are both alive at the peak.
pub fn json_cost(payload: &[u8], budget: u64) -> Result<u64, OverBudget> {
    let mut meter = Meter::new(budget);
    // Each open container; deeper than serde_json's limit fails to parse.
    let mut open = [JsonContainer::default(); JSON_MAX_DEPTH];
    let mut depth = 0_usize;
    let mut bytes = payload.iter().copied().enumerate();
    while let Some((start, byte)) = bytes.next() {
        // A value directly inside an array is one of its elements.
        let parent = depth.checked_sub(1).map(|top| &mut open[top]);
        let in_array = parent.is_some_and(|parent| {
            if parent.array && byte != b']' && !matches!(byte, b',' | b' ' | b'\n' | b'\r' | b'\t')
            {
                parent.elements += 1;
                parent.objects += u64::from(byte == b'{');
            }
            parent.array
        });
        match byte {
            b'"' => {
                let mut escaped = false;
                let end = bytes
                    .by_ref()
                    .find(|&(_, byte)| {
                        let closes = byte == b'"' && !escaped;
                        escaped = byte == b'\\' && !escaped;
                        closes
                    })
                    .map_or(payload.len(), |(end, _)| end);
                // Held once by the `Value` tree and once by the typed request,
                // where an array's string is an element of its own.
                let slot = if in_array {
                    size_of::<String>() as u64
                } else {
                    0
                };
                meter.charge(JSON_VALUE + slot + 2 * heap_len(end - start - 1))?;
            }
            b'{' | b'[' => {
                meter.charge(JSON_VALUE)?;
                if depth == JSON_MAX_DEPTH {
                    return Ok(meter.total());
                }
                open[depth] = JsonContainer {
                    array: byte == b'[',
                    ..JsonContainer::default()
                };
                depth += 1;
            }
            b'}' | b']' => {
                let Some(top) = depth.checked_sub(1) else {
                    return Ok(meter.total());
                };
                depth = top;
                let closed = open[top];
                if byte == b'}' {
                    // A map node per (up to) eleven entries, and the typed message
                    // the object decodes into. Each value already paid for its slot.
                    let nodes = closed.elements.div_ceil(BTREE_NODE_ENTRIES);
                    meter.charge(nodes * BTREE_NODE + JSON_TYPED)?;
                } else if closed.elements > 0 {
                    // The `Vec<Value>` and the typed list it becomes: up to twice their
                    // elements, and a parse builds the first while normalizing the second.
                    let list = closed.elements * JSON_VALUE + closed.objects * JSON_TYPED;
                    let first = if closed.elements == 1 { 2 * list } else { 0 };
                    meter.charge(2 * list + first)?;
                    meter.note_list(list)?;
                }
            }
            b':' => {
                if let Some(top) = depth.checked_sub(1) {
                    open[top].elements += 1;
                }
            }
            b'0'..=b'9' | b'-' | b't' | b'f' | b'n' => {
                // Its `Value`, the typed field, and the string `normalize` makes of
                // a 64-bit number.
                meter.charge(JSON_VALUE + JSON_SCALAR)?;
                // Skip the rest of the scalar so its digits are charged once.
                while bytes.clone().next().is_some_and(|(_, next)| {
                    !matches!(next, b',' | b']' | b'}' | b' ' | b'\n' | b'\r' | b'\t')
                }) {
                    bytes.next();
                }
            }
            _ => {}
        }
    }
    Ok(meter.total())
}

#[derive(Clone, Copy, Default)]
struct JsonContainer {
    array: bool,
    /// An object's entries or an array's elements.
    elements: u64,
    /// An array's elements that are objects.
    objects: u64,
}

const JSON_SCALAR: u64 = 8 + size_of::<String>() as u64 + 24;
const JSON_MAX_DEPTH: usize = 128;
const JSON_VALUE: u64 = size_of::<serde_json::Value>() as u64;
/// A `BTreeMap<String, Value>` leaf: eleven keys, eleven values, and its header.
const BTREE_NODE_ENTRIES: u64 = 11;
const BTREE_NODE: u64 =
    BTREE_NODE_ENTRIES * (size_of::<String>() as u64 + size_of::<serde_json::Value>() as u64) + 16;
/// The largest message a JSON object can decode into.
const JSON_TYPED: u64 = {
    let sizes = [
        Msg::ResourceSpans.size(),
        Msg::ScopeSpans.size(),
        Msg::Span.size(),
        Msg::Event.size(),
        Msg::Link.size(),
        Msg::ResourceLogs.size(),
        Msg::ScopeLogs.size(),
        Msg::LogRecord.size(),
        Msg::ResourceMetrics.size(),
        Msg::ScopeMetrics.size(),
        Msg::Metric.size(),
        Msg::NumberDataPoint.size(),
        Msg::HistogramDataPoint.size(),
        Msg::ExponentialHistogramDataPoint.size(),
        Msg::SummaryDataPoint.size(),
        Msg::Exemplar.size(),
        Msg::KeyValue.size(),
        Msg::AnyValue.size(),
        Msg::EntityRef.size(),
    ];
    let mut max = 0;
    let mut i = 0;
    while i < sizes.len() {
        if sizes[i] > max {
            max = sizes[i];
        }
        i += 1;
    }
    max
};

struct Meter {
    spent: u64,
    /// Element bytes of the largest list, held twice while it reallocates.
    largest_list: u64,
    budget: u64,
}

impl Meter {
    const fn new(budget: u64) -> Self {
        Self {
            spent: 0,
            largest_list: 0,
            budget,
        }
    }

    const fn total(&self) -> u64 {
        self.spent.saturating_add(self.largest_list)
    }

    fn check(&self) -> Result<(), Stop> {
        if self.total() > self.budget {
            Err(Stop::OverBudget)
        } else {
            Ok(())
        }
    }

    fn charge(&mut self, bytes: u64) -> Result<(), Stop> {
        self.spent = self.spent.saturating_add(bytes);
        self.check()
    }

    /// Charges `count` elements of `size` bytes to the list `lists[tag]`: twice, for
    /// a `Vec`'s spare capacity (four times for its first, as `Vec` starts at four),
    /// and the list's running size towards `largest_list`.
    fn charge_list(
        &mut self,
        lists: &mut [u64; LIST_TAGS],
        tag: u64,
        size: u64,
        count: u64,
    ) -> Result<(), Stop> {
        let bytes = size.saturating_mul(count);
        let Some(list) = usize::try_from(tag).ok().and_then(|tag| lists.get_mut(tag)) else {
            return self.charge(bytes.saturating_mul(2));
        };
        let first = if *list == 0 { 2 * size } else { 0 };
        *list = list.saturating_add(bytes);
        let list = *list;
        self.spent = self.spent.saturating_add(bytes.saturating_mul(2) + first);
        self.note_list(list)
    }

    /// A list of `bytes` elements, held twice while it reallocates.
    fn note_list(&mut self, bytes: u64) -> Result<(), Stop> {
        self.largest_list = self.largest_list.max(bytes);
        self.check()
    }
}

/// Every repeated field's tag is below this.
const LIST_TAGS: usize = 16;

impl From<Stop> for OverBudget {
    fn from(_: Stop) -> Self {
        Self
    }
}

enum Stop {
    OverBudget,
    /// Not valid protobuf: left for the decoder to reject.
    Malformed,
}

/// Heap bytes behind a string or byte field of `len` bytes.
const fn heap_len(len: usize) -> u64 {
    if len == 0 {
        0
    } else {
        (len as u64).next_multiple_of(8)
    }
}

/// Deeper than this the decoder has already refused (its limit is 100).
const MAX_DEPTH: u32 = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Msg {
    ExportTraces,
    ResourceSpans,
    ScopeSpans,
    Span,
    Event,
    Link,
    Status,
    ExportLogs,
    ResourceLogs,
    ScopeLogs,
    LogRecord,
    ExportMetrics,
    ResourceMetrics,
    ScopeMetrics,
    Metric,
    Gauge,
    Sum,
    Histogram,
    ExponentialHistogram,
    Summary,
    NumberDataPoint,
    HistogramDataPoint,
    ExponentialHistogramDataPoint,
    Buckets,
    SummaryDataPoint,
    ValueAtQuantile,
    Exemplar,
    Resource,
    Scope,
    EntityRef,
    KeyValue,
    AnyValue,
    ArrayValue,
    KeyValueList,
}

/// How a field's wire bytes turn into heap.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Field {
    /// A nested message; a repeated one is a `Vec` element of its own.
    Message(Msg, Repeated),
    /// `string` or `bytes`.
    Text,
    /// `repeated string`.
    TextList,
    /// `repeated` 64-bit numbers, packed or not.
    NumberList,
    /// Scalars, which live inside the message already, and unknown fields.
    Inline,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Repeated {
    Yes,
    No,
}

impl Msg {
    const fn size(self) -> u64 {
        (match self {
            Self::ExportTraces => size_of::<ExportTraceServiceRequest>(),
            Self::ResourceSpans => size_of::<ResourceSpans>(),
            Self::ScopeSpans => size_of::<ScopeSpans>(),
            Self::Span => size_of::<Span>(),
            Self::Event => size_of::<span::Event>(),
            Self::Link => size_of::<span::Link>(),
            Self::Status => size_of::<Status>(),
            Self::ExportLogs => size_of::<ExportLogsServiceRequest>(),
            Self::ResourceLogs => size_of::<ResourceLogs>(),
            Self::ScopeLogs => size_of::<ScopeLogs>(),
            Self::LogRecord => size_of::<LogRecord>(),
            Self::ExportMetrics => size_of::<ExportMetricsServiceRequest>(),
            Self::ResourceMetrics => size_of::<ResourceMetrics>(),
            Self::ScopeMetrics => size_of::<ScopeMetrics>(),
            Self::Metric => size_of::<Metric>(),
            Self::Gauge => size_of::<Gauge>(),
            Self::Sum => size_of::<Sum>(),
            Self::Histogram => size_of::<Histogram>(),
            Self::ExponentialHistogram => size_of::<ExponentialHistogram>(),
            Self::Summary => size_of::<Summary>(),
            Self::NumberDataPoint => size_of::<NumberDataPoint>(),
            Self::HistogramDataPoint => size_of::<HistogramDataPoint>(),
            Self::ExponentialHistogramDataPoint => size_of::<ExponentialHistogramDataPoint>(),
            Self::Buckets => size_of::<Buckets>(),
            Self::SummaryDataPoint => size_of::<SummaryDataPoint>(),
            Self::ValueAtQuantile => size_of::<ValueAtQuantile>(),
            Self::Exemplar => size_of::<Exemplar>(),
            Self::Resource => size_of::<Resource>(),
            Self::Scope => size_of::<InstrumentationScope>(),
            Self::EntityRef => size_of::<EntityRef>(),
            Self::KeyValue => size_of::<KeyValue>(),
            Self::AnyValue => size_of::<AnyValue>(),
            Self::ArrayValue => size_of::<ArrayValue>(),
            Self::KeyValueList => size_of::<KeyValueList>(),
        }) as u64
    }

    /// The field table of opentelemetry-proto's generated types; the fixtures in
    /// `tests/decode_heap.rs` stop compiling when those gain a field.
    #[expect(
        clippy::match_same_arms,
        reason = "one arm per (message, tag), mirroring the .proto files"
    )]
    const fn field(self, tag: u64) -> Field {
        use Field::{Inline, Message, NumberList, Text, TextList};
        use Repeated::{No, Yes};
        match (self, tag) {
            (Self::ExportTraces, 1) => Message(Self::ResourceSpans, Yes),
            (
                Self::ResourceSpans
                | Self::ScopeSpans
                | Self::ResourceLogs
                | Self::ScopeLogs
                | Self::ResourceMetrics
                | Self::ScopeMetrics,
                3,
            ) => Text,
            (Self::ResourceSpans, 1) => Message(Self::Resource, No),
            (Self::ResourceSpans, 2) => Message(Self::ScopeSpans, Yes),
            (Self::ScopeSpans, 1) => Message(Self::Scope, No),
            (Self::ScopeSpans, 2) => Message(Self::Span, Yes),
            (Self::Span, 1..=5) => Text,
            (Self::Span, 9) => Message(Self::KeyValue, Yes),
            (Self::Span, 11) => Message(Self::Event, Yes),
            (Self::Span, 13) => Message(Self::Link, Yes),
            (Self::Span, 15) => Message(Self::Status, No),
            (Self::Event, 2) => Text,
            (Self::Event, 3) => Message(Self::KeyValue, Yes),
            (Self::Link, 1..=3) => Text,
            (Self::Link, 4) => Message(Self::KeyValue, Yes),
            (Self::Status, 2) => Text,

            (Self::ExportLogs, 1) => Message(Self::ResourceLogs, Yes),
            (Self::ResourceLogs, 1) => Message(Self::Resource, No),
            (Self::ResourceLogs, 2) => Message(Self::ScopeLogs, Yes),
            (Self::ScopeLogs, 1) => Message(Self::Scope, No),
            (Self::ScopeLogs, 2) => Message(Self::LogRecord, Yes),
            (Self::LogRecord, 3 | 9 | 10 | 12) => Text,
            (Self::LogRecord, 5) => Message(Self::AnyValue, No),
            (Self::LogRecord, 6) => Message(Self::KeyValue, Yes),

            (Self::ExportMetrics, 1) => Message(Self::ResourceMetrics, Yes),
            (Self::ResourceMetrics, 1) => Message(Self::Resource, No),
            (Self::ResourceMetrics, 2) => Message(Self::ScopeMetrics, Yes),
            (Self::ScopeMetrics, 1) => Message(Self::Scope, No),
            (Self::ScopeMetrics, 2) => Message(Self::Metric, Yes),
            (Self::Metric, 1..=3) => Text,
            (Self::Metric, 5) => Message(Self::Gauge, No),
            (Self::Metric, 7) => Message(Self::Sum, No),
            (Self::Metric, 9) => Message(Self::Histogram, No),
            (Self::Metric, 10) => Message(Self::ExponentialHistogram, No),
            (Self::Metric, 11) => Message(Self::Summary, No),
            (Self::Metric, 12) => Message(Self::KeyValue, Yes),
            (Self::Gauge | Self::Sum, 1) => Message(Self::NumberDataPoint, Yes),
            (Self::Histogram, 1) => Message(Self::HistogramDataPoint, Yes),
            (Self::ExponentialHistogram, 1) => Message(Self::ExponentialHistogramDataPoint, Yes),
            (Self::Summary, 1) => Message(Self::SummaryDataPoint, Yes),
            (Self::NumberDataPoint, 7) => Message(Self::KeyValue, Yes),
            (Self::NumberDataPoint, 5) => Message(Self::Exemplar, Yes),
            (Self::HistogramDataPoint, 9) => Message(Self::KeyValue, Yes),
            (Self::HistogramDataPoint, 6 | 7) => NumberList,
            (Self::HistogramDataPoint, 8) => Message(Self::Exemplar, Yes),
            (Self::ExponentialHistogramDataPoint, 1) => Message(Self::KeyValue, Yes),
            (Self::ExponentialHistogramDataPoint, 8 | 9) => Message(Self::Buckets, No),
            (Self::ExponentialHistogramDataPoint, 11) => Message(Self::Exemplar, Yes),
            (Self::Buckets, 2) => NumberList,
            (Self::SummaryDataPoint, 7) => Message(Self::KeyValue, Yes),
            (Self::SummaryDataPoint, 6) => Message(Self::ValueAtQuantile, Yes),
            (Self::Exemplar, 7) => Message(Self::KeyValue, Yes),
            (Self::Exemplar, 4 | 5) => Text,

            (Self::Resource, 1) => Message(Self::KeyValue, Yes),
            (Self::Resource, 3) => Message(Self::EntityRef, Yes),
            (Self::Scope, 1 | 2) => Text,
            (Self::Scope, 3) => Message(Self::KeyValue, Yes),
            (Self::EntityRef, 1 | 2) => Text,
            (Self::EntityRef, 3 | 4) => TextList,
            (Self::KeyValue, 1) => Text,
            (Self::KeyValue, 2) => Message(Self::AnyValue, No),
            (Self::AnyValue, 1 | 7) => Text,
            (Self::AnyValue, 5) => Message(Self::ArrayValue, No),
            (Self::AnyValue, 6) => Message(Self::KeyValueList, No),
            (Self::ArrayValue, 1) => Message(Self::AnyValue, Yes),
            (Self::KeyValueList, 1) => Message(Self::KeyValue, Yes),
            _ => Inline,
        }
    }
}

const WIRE_VARINT: u64 = 0;
const WIRE_FIXED64: u64 = 1;
const WIRE_LEN: u64 = 2;
const WIRE_START_GROUP: u64 = 3;
const WIRE_END_GROUP: u64 = 4;
const WIRE_FIXED32: u64 = 5;

fn walk(msg: Msg, mut buf: &[u8], depth: u32, meter: &mut Meter) -> Result<(), Stop> {
    if depth > MAX_DEPTH {
        return Err(Stop::Malformed);
    }
    // Element bytes of each repeated field of this message, by tag.
    let mut lists = [0_u64; LIST_TAGS];
    while !buf.is_empty() {
        let key = varint(&mut buf)?;
        let (tag, wire) = (key >> 3, key & 7);
        if tag == 0 {
            return Err(Stop::Malformed);
        }
        let field = msg.field(tag);
        match wire {
            WIRE_VARINT => {
                varint(&mut buf)?;
                if field == Field::NumberList {
                    meter.charge_list(&mut lists, tag, 8, 1)?;
                }
            }
            WIRE_FIXED64 | WIRE_FIXED32 => {
                let width = if wire == WIRE_FIXED64 { 8 } else { 4 };
                buf = buf.get(width..).ok_or(Stop::Malformed)?;
                if field == Field::NumberList {
                    meter.charge_list(&mut lists, tag, 8, 1)?;
                }
            }
            WIRE_LEN => {
                let len = usize::try_from(varint(&mut buf)?).map_err(|_| Stop::Malformed)?;
                if len > buf.len() {
                    return Err(Stop::Malformed);
                }
                let (body, rest) = buf.split_at(len);
                buf = rest;
                match field {
                    Field::Message(child, repeated) => {
                        if repeated == Repeated::Yes {
                            meter.charge_list(&mut lists, tag, child.size(), 1)?;
                        }
                        walk(child, body, depth + 1, meter)?;
                    }
                    Field::Text => meter.charge(heap_len(len))?,
                    Field::TextList => {
                        meter.charge_list(&mut lists, tag, size_of::<String>() as u64, 1)?;
                        meter.charge(heap_len(len))?;
                    }
                    // Packed: one element per varint, or per eight bytes when fixed.
                    Field::NumberList => {
                        let varints = body.iter().filter(|byte| **byte < 0x80).count();
                        meter.charge_list(&mut lists, tag, 8, varints.max(len / 8) as u64)?;
                    }
                    Field::Inline => {}
                }
            }
            WIRE_START_GROUP => skip_group(tag, &mut buf, depth + 1)?,
            _ => return Err(Stop::Malformed),
        }
    }
    Ok(())
}

/// Skips an unknown group up to its end marker, as the decoder does.
fn skip_group(tag: u64, buf: &mut &[u8], depth: u32) -> Result<(), Stop> {
    if depth > MAX_DEPTH {
        return Err(Stop::Malformed);
    }
    loop {
        let key = varint(buf)?;
        let (inner, wire) = (key >> 3, key & 7);
        match wire {
            WIRE_VARINT => {
                varint(buf)?;
            }
            WIRE_FIXED64 => *buf = buf.get(8..).ok_or(Stop::Malformed)?,
            WIRE_FIXED32 => *buf = buf.get(4..).ok_or(Stop::Malformed)?,
            WIRE_LEN => {
                let len = usize::try_from(varint(buf)?).map_err(|_| Stop::Malformed)?;
                *buf = buf.get(len..).ok_or(Stop::Malformed)?;
            }
            WIRE_START_GROUP => skip_group(inner, buf, depth + 1)?,
            WIRE_END_GROUP if inner == tag => return Ok(()),
            _ => return Err(Stop::Malformed),
        }
    }
}

fn varint(buf: &mut &[u8]) -> Result<u64, Stop> {
    let mut value = 0_u64;
    for (i, byte) in buf.iter().copied().enumerate().take(10) {
        value |= u64::from(byte & 0x7f) << (7 * i);
        if byte < 0x80 {
            *buf = &buf[i + 1..];
            return Ok(value);
        }
    }
    Err(Stop::Malformed)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `count` copies of field 1 holding an empty message.
    fn empty_entries(count: usize) -> Vec<u8> {
        [0x0a, 0x00].repeat(count)
    }

    #[test]
    fn a_reservation_shrinks_to_what_is_still_live() {
        let memory = DecodeMemory::new(64 * 1024);
        let mut held = memory.reservation();
        assert!(held.try_add(40 * 1024));
        held.shrink_to(10 * 1024 + 1);
        assert_eq!(memory.reserved_bytes(), 11 * 1024);
        held.shrink_to(20 * 1024);
        assert_eq!(memory.reserved_bytes(), 11 * 1024, "shrinking never grows");
        drop(held);
        assert_eq!(memory.reserved_bytes(), 0);
    }

    #[test]
    fn decode_memory_is_reserved_in_whole_kibibytes_and_returned_on_drop() {
        let kib = 1024;
        let memory = DecodeMemory::new(4 * kib);
        let mut first = memory.reservation();
        assert!(first.try_add(1));
        assert!(first.try_add(2 * kib));
        assert_eq!(
            memory.reserved_bytes(),
            3 * kib,
            "rounded up per reservation"
        );
        let mut second = memory.reservation();
        assert!(!second.try_add(2 * kib), "only one KiB is free");
        assert!(second.try_add(kib));
        drop(first);
        assert_eq!(memory.reserved_bytes(), kib);
        assert!(second.try_add(0), "nothing to reserve always fits");
        assert!(!second.try_add(u64::MAX));
    }

    #[test]
    fn gzip_declared_len_reads_the_trailer_of_a_gzip_stream_only() {
        use std::io::Write as _;
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&[7; 5000]).unwrap();
        let gzip = encoder.finish().unwrap();
        assert_eq!(gzip_declared_len(&gzip), Some(5000));
        assert_eq!(
            gzip_declared_len(b"neither gzip nor protobuf nor json"),
            None
        );
        assert_eq!(gzip_declared_len(&gzip[..10]), None);
    }

    #[test]
    fn a_payload_past_the_budget_is_refused_and_one_within_is_costed() {
        let payload = empty_entries(10_000);
        let cost = protobuf_cost(OtlpSignal::Logs, &payload, u64::MAX).unwrap();
        assert!(cost >= 10_000 * size_of::<ResourceLogs>() as u64);
        assert_eq!(protobuf_cost(OtlpSignal::Logs, &payload, cost), Ok(cost));
        assert_eq!(
            protobuf_cost(OtlpSignal::Logs, &payload, cost - 1),
            Err(OverBudget)
        );
    }

    #[test]
    fn malformed_input_is_left_to_the_decoder() {
        // A truncated length, an invalid wire type and a dangling end-group:
        // each is costed up to the fault rather than refused.
        let mut truncated = empty_entries(3);
        truncated.extend([0x0a, 0x05, 0x00]);
        for payload in [truncated, vec![0x0f], vec![0x0c]] {
            assert!(protobuf_cost(OtlpSignal::Traces, &payload, 1 << 20).is_ok());
        }
    }

    #[test]
    fn unknown_groups_are_skipped_and_the_rest_still_charged() {
        // Field 99 as a group holding a varint, then real entries after it.
        let mut payload = vec![0x9b, 0x06, 0x08, 0x01, 0x9c, 0x06];
        payload.extend(empty_entries(100));
        let with_group = protobuf_cost(OtlpSignal::Metrics, &payload, u64::MAX).unwrap();
        let without = protobuf_cost(OtlpSignal::Metrics, &empty_entries(100), u64::MAX).unwrap();
        assert_eq!(with_group, without);
    }

    #[test]
    fn json_structure_inside_strings_is_not_counted() {
        let plain = br#"{"resourceLogs":[{"schemaUrl":"aaaaaaaaaaaa"}]}"#;
        let braces = br#"{"resourceLogs":[{"schemaUrl":"{[{\"}]}:{[,"}]}"#;
        assert_eq!(plain.len(), braces.len());
        assert_eq!(
            json_cost(plain, u64::MAX).unwrap(),
            json_cost(braces, u64::MAX).unwrap()
        );
        let many = format!("{{\"resourceLogs\":[{}{{}}]}}", "{},".repeat(1_000));
        assert!(json_cost(many.as_bytes(), u64::MAX).unwrap() > 1_000 * JSON_TYPED);
    }
}
