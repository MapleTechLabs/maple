//! The gateway's AI stamping as a WebAssembly module, so the local CLI's
//! ingest (`apps/cli/src/server/otlp/ai-stamp.ts`) runs the same code: a
//! protobuf `ExportTraceServiceRequest` in, the stamped request out.
//!
//! The host writes the request into the buffer `input(len)` returns, calls
//! `stamp()`, then reads `output_len()` bytes at `output()`. The pointers are
//! only valid until the next call, which may grow memory.

use std::cell::RefCell;

use maple_ai_session::stamp_trace_request;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use prost::Message;

thread_local! {
    static INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

#[expect(unsafe_code, reason = "wasm export")]
#[no_mangle]
pub extern "C" fn input(len: usize) -> *mut u8 {
    INPUT.with_borrow_mut(|input| {
        input.clear();
        input.resize(len, 0);
        input.as_mut_ptr()
    })
}

/// False when the input is not a protobuf `ExportTraceServiceRequest`; the
/// output then holds prost's decode error.
#[expect(unsafe_code, reason = "wasm export")]
#[no_mangle]
pub extern "C" fn stamp() -> bool {
    let (stamped, output) = match ExportTraceServiceRequest::decode(INPUT.take().as_slice()) {
        Ok(mut request) => {
            stamp_trace_request(&mut request);
            (true, request.encode_to_vec())
        }
        Err(error) => (false, error.to_string().into_bytes()),
    };
    OUTPUT.set(output);
    stamped
}

#[expect(unsafe_code, reason = "wasm export")]
#[no_mangle]
pub extern "C" fn output() -> *const u8 {
    OUTPUT.with_borrow(Vec::as_ptr)
}

#[expect(unsafe_code, reason = "wasm export")]
#[no_mangle]
pub extern "C" fn output_len() -> usize {
    OUTPUT.with_borrow(Vec::len)
}
