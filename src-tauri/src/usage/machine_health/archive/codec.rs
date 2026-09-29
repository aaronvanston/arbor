//! Each stored object is one zstd frame at level 6, carrying its own checksum
//! and its size, so `zstd -dc` alone can read it back and catch damage.

const LEVEL: i32 = 6;

pub(crate) fn encode(plain: &[u8]) -> Result<Vec<u8>, String> {
    let mut compressor = zstd::bulk::Compressor::new(LEVEL).map_err(|error| format!("Couldn't start zstd: {error}"))?;
    compressor
        .set_parameter(zstd::zstd_safe::CParameter::ChecksumFlag(true))
        .and_then(|()| compressor.set_parameter(zstd::zstd_safe::CParameter::ContentSizeFlag(true)))
        .map_err(|error| format!("Couldn't set up zstd: {error}"))?;
    compressor.compress(plain).map_err(|error| format!("Couldn't compress: {error}"))
}

pub(crate) fn decode(frame: &[u8]) -> Result<Vec<u8>, String> {
    zstd::stream::decode_all(frame).map_err(|error| format!("Couldn't decompress: {error}"))
}

/// The start of what a zstd stream holds, at most `limit` bytes of it, for reading the ids at
/// the top of a compressed transcript.
pub(crate) fn decode_head(frame: impl std::io::Read, limit: usize) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let decoder = zstd::stream::Decoder::new(frame).map_err(|error| format!("Couldn't decompress: {error}"))?;
    let mut out = Vec::new();
    decoder.take(limit as u64).read_to_end(&mut out).map_err(|error| format!("Couldn't decompress: {error}"))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_catches_damage() {
        let plain = b"{\"type\":\"user\"}\n".repeat(500);
        let frame = encode(&plain).unwrap();
        assert!(frame.len() < plain.len() / 10);
        assert_eq!(decode(&frame).unwrap(), plain);
        assert_eq!(decode(&encode(b"").unwrap()).unwrap(), b"");
        assert_eq!(decode_head(&frame[..], 20).unwrap(), &plain[..20]);
        // The frame's own checksum catches a flipped byte.
        let mut damaged = frame.clone();
        let middle = damaged.len() / 2;
        damaged[middle] ^= 0x40;
        assert!(decode(&damaged).map_or(true, |bytes| bytes != plain));
        let last = damaged.len() - 1;
        let mut tail_damaged = frame.clone();
        tail_damaged[last] ^= 1;
        assert!(decode(&tail_damaged).is_err());
    }
}
