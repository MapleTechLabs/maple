//! The only place request bodies are decompressed. Every reader stops once its
//! output passes a caller-chosen ceiling, so a small body cannot inflate without
//! bound. `clippy.toml` disallows the raw `flate2` and `snap` decoders everywhere else.

use std::io::Read;

#[derive(Debug)]
pub enum GunzipError {
    /// Not a valid gzip stream (or, for text, not UTF-8).
    Invalid(std::io::Error),
    /// The stream decompressed past the ceiling.
    TooLarge,
}

#[expect(
    clippy::disallowed_types,
    reason = "the one bounded wrapper around the raw decoder"
)]
fn bounded_reader(body: &[u8], max_decoded: usize) -> impl Read + '_ {
    let read_limit = u64::try_from(max_decoded)
        .unwrap_or(u64::MAX)
        .saturating_add(1);
    flate2::read::GzDecoder::new(body).take(read_limit)
}

/// Gunzips `body`, failing with `TooLarge` once more than `max_decoded` bytes come out.
pub fn gunzip_bounded(body: &[u8], max_decoded: usize) -> Result<Vec<u8>, GunzipError> {
    let mut decompressed = Vec::new();
    bounded_reader(body, max_decoded)
        .read_to_end(&mut decompressed)
        .map_err(GunzipError::Invalid)?;
    if decompressed.len() > max_decoded {
        return Err(GunzipError::TooLarge);
    }
    Ok(decompressed)
}

/// Gunzips a single-member `body` that declares `declared` bytes into a buffer of
/// exactly that size, so the caller can reserve the memory up front. More output
/// than declared is `TooLarge`; a second member or trailing bytes are `Invalid`.
#[expect(
    clippy::disallowed_types,
    reason = "bounded by `declared`, which the caller has checked against its ceiling"
)]
pub fn gunzip_declared(body: &[u8], declared: usize) -> Result<Vec<u8>, GunzipError> {
    let read_limit = u64::try_from(declared)
        .unwrap_or(u64::MAX)
        .saturating_add(1);
    let mut reader = flate2::bufread::GzDecoder::new(body).take(read_limit);
    let mut decompressed = Vec::with_capacity(declared.saturating_add(1));
    reader
        .read_to_end(&mut decompressed)
        .map_err(GunzipError::Invalid)?;
    if decompressed.len() > declared {
        return Err(GunzipError::TooLarge);
    }
    if !reader.into_inner().into_inner().is_empty() {
        return Err(GunzipError::Invalid(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "data after the first gzip member",
        )));
    }
    Ok(decompressed)
}

/// Decompressed length of `body` without keeping the bytes, under the same ceiling.
pub fn gunzip_len_bounded(body: &[u8], max_decoded: usize) -> Result<u64, GunzipError> {
    let len = std::io::copy(&mut bounded_reader(body, max_decoded), &mut std::io::sink())
        .map_err(GunzipError::Invalid)?;
    if len > u64::try_from(max_decoded).unwrap_or(u64::MAX) {
        return Err(GunzipError::TooLarge);
    }
    Ok(len)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnappyError {
    /// Not a valid snappy block: bad header, corrupt data, or the framed format.
    Invalid,
    /// The block declares more output than `declared`.
    TooLarge,
}

/// The uncompressed size a snappy block declares in its header, or `None` when the
/// body has no valid header. The decoder verifies it, so the caller can check it
/// against a ceiling and reserve the memory before anything is allocated.
pub fn snappy_declared_len(body: &[u8]) -> Option<u64> {
    if body.is_empty() {
        return None;
    }
    let declared = snap::raw::decompress_len(body).ok()?;
    Some(declared as u64)
}

/// Decompresses a snappy block (not the framed format) that declares at most
/// `declared` bytes. A block that does not decode to exactly its header's length
/// is `Invalid`, so the output never passes what the caller reserved.
#[expect(
    clippy::disallowed_types,
    reason = "bounded by `declared`, which the caller has checked against its ceiling"
)]
pub fn unsnap_declared(body: &[u8], declared: usize) -> Result<Vec<u8>, SnappyError> {
    let header = snappy_declared_len(body).ok_or(SnappyError::Invalid)?;
    if header > declared as u64 {
        return Err(SnappyError::TooLarge);
    }
    snap::raw::Decoder::new()
        .decompress_vec(body)
        .map_err(|_| SnappyError::Invalid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;

    fn gzip(plain: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(plain).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn gunzip_declared_takes_one_member_of_exactly_its_size() {
        let body = gzip(&[3; 1000]);
        let out = gunzip_declared(&body, 1000).unwrap();
        assert_eq!(
            (out.len(), out.capacity()),
            (1000, 1001),
            "no buffer growth"
        );
        assert!(matches!(
            gunzip_declared(&body, 999),
            Err(GunzipError::TooLarge)
        ));
        let mut two_members = body.clone();
        two_members.extend(gzip(&[4; 10]));
        assert!(matches!(
            gunzip_declared(&two_members, 1000),
            Err(GunzipError::Invalid(_))
        ));
        let mut trailing = body;
        trailing.extend([0; 8]);
        assert!(matches!(
            gunzip_declared(&trailing, 1000),
            Err(GunzipError::Invalid(_))
        ));
    }

    #[test]
    fn unsnap_declared_takes_a_block_of_its_declared_size() {
        let plain = b"prometheus remote write ".repeat(64);
        let body = snap::raw::Encoder::new().compress_vec(&plain).unwrap();
        assert_eq!(snappy_declared_len(&body), Some(plain.len() as u64));
        assert_eq!(unsnap_declared(&body, plain.len()).unwrap(), plain);
        assert_eq!(
            unsnap_declared(&body, plain.len() - 1),
            Err(SnappyError::TooLarge)
        );
    }

    #[test]
    fn a_snappy_header_larger_than_its_data_is_refused_without_the_allocation() {
        // Declares 4 GiB - 1 in five header bytes and carries no data.
        let bomb = [0xff, 0xff, 0xff, 0xff, 0x0f];
        assert_eq!(snappy_declared_len(&bomb), Some(u64::from(u32::MAX)));
        assert_eq!(unsnap_declared(&bomb, 1024), Err(SnappyError::TooLarge));
        // Within the ceiling the same lie is caught by the decoder.
        let short = [0x40, 0x00, b'a'];
        assert_eq!(snappy_declared_len(&short), Some(64));
        assert_eq!(unsnap_declared(&short, 64), Err(SnappyError::Invalid));
    }

    #[test]
    fn truncated_empty_and_framed_snappy_are_invalid() {
        let plain = b"0123456789abcdef".repeat(32);
        let body = snap::raw::Encoder::new().compress_vec(&plain).unwrap();
        assert_eq!(
            unsnap_declared(&body[..body.len() / 2], plain.len()),
            Err(SnappyError::Invalid)
        );
        assert_eq!(snappy_declared_len(&[]), None);
        assert_eq!(unsnap_declared(&[], 1024), Err(SnappyError::Invalid));
        // A header that never ends is not a length.
        assert_eq!(snappy_declared_len(&[0xff; 8]), None);

        let mut framed = Vec::new();
        {
            use std::io::Write;
            let mut encoder = snap::write::FrameEncoder::new(&mut framed);
            encoder.write_all(&plain).unwrap();
            encoder.flush().unwrap();
        }
        assert!(framed.starts_with(b"\xff\x06\x00\x00sNaPpY"));
        assert_eq!(
            unsnap_declared(&framed, 1024 * 1024),
            Err(SnappyError::Invalid)
        );
    }

    #[test]
    fn both_readers_stop_at_the_ceiling() {
        let body = gzip(&vec![0; 1024]);
        assert_eq!(gunzip_bounded(&body, 1024).unwrap().len(), 1024);
        assert_eq!(gunzip_len_bounded(&body, 1024).unwrap(), 1024);
        assert!(matches!(
            gunzip_bounded(&body, 1023),
            Err(GunzipError::TooLarge)
        ));
        assert!(matches!(
            gunzip_len_bounded(&body, 1023),
            Err(GunzipError::TooLarge)
        ));
        assert!(matches!(
            gunzip_len_bounded(b"nope", 1024),
            Err(GunzipError::Invalid(_))
        ));
    }
}
