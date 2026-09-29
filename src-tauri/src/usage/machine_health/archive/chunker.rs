//! Cuts a file's bytes into chunks at line ends (linecut-v1). From each
//! chunk's start, the cut falls just after the first newline at or past
//! `target - 1` bytes in; with no newline before `max`, it falls at `max`
//! and the chunk ends mid-line. Where a cut falls depends only on the bytes
//! since the last one, so bytes added to the end never move an earlier cut,
//! and a file that's the start of another shares all its whole chunks.

/// Where a chunk ends, from the start of the chunk.
pub(crate) const TARGET: usize = 1 << 20;
pub(crate) const MAX: usize = 8 << 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Rule {
    pub(crate) target: usize,
    pub(crate) max: usize,
}

pub(crate) const LINECUT_V1: Rule = Rule { target: TARGET, max: MAX };

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Chunk {
    pub(crate) data: Vec<u8>,
    /// Cut at `max` because no line ended in time.
    pub(crate) mid_line: bool,
}

/// Fed a chunk's worth of bytes at a time, gives back each whole chunk as it's cut. What's
/// left at the end is the tail, which becomes a chunk only once the file stops growing.
pub(crate) struct LineCut {
    rule: Rule,
    buf: Vec<u8>,
    /// How far into `buf` has been looked through for a newline, so each byte is looked at once.
    looked: usize,
}

impl LineCut {
    pub(crate) fn new(rule: Rule) -> Self {
        Self { rule, buf: Vec::new(), looked: 0 }
    }

    pub(crate) fn push(&mut self, mut bytes: &[u8], out: &mut Vec<Chunk>) {
        while !bytes.is_empty() {
            let room = self.rule.max - self.buf.len();
            let take = room.min(bytes.len());
            self.buf.extend_from_slice(&bytes[..take]);
            bytes = &bytes[take..];
            self.cut(out);
        }
    }

    fn cut(&mut self, out: &mut Vec<Chunk>) {
        loop {
            let from = self.looked.max(self.rule.target.saturating_sub(1));
            let end = self.buf.len().min(self.rule.max);
            let found = if from < end { memchr::memchr(b'\n', &self.buf[from..end]).map(|at| (from + at + 1, false)) } else { None };
            let cut = found.or_else(|| (self.buf.len() >= self.rule.max).then_some((self.rule.max, true)));
            let Some((at, mid_line)) = cut else {
                self.looked = end;
                return;
            };
            let rest = self.buf.split_off(at);
            out.push(Chunk { data: std::mem::replace(&mut self.buf, rest), mid_line });
            self.looked = 0;
        }
    }

    #[cfg(test)]
    pub(crate) fn tail(&self) -> &[u8] {
        &self.buf
    }

    pub(crate) fn into_tail(self) -> Vec<u8> {
        self.buf
    }
}

/// Every chunk of `data`, with the tail last when there is one.
#[cfg(test)]
pub(crate) fn split(data: &[u8], rule: Rule) -> (Vec<Chunk>, Vec<u8>) {
    let mut cutter = LineCut::new(rule);
    let mut chunks = Vec::new();
    cutter.push(data, &mut chunks);
    (chunks, cutter.into_tail())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    const SMALL: Rule = Rule { target: 8, max: 20 };

    /// A seeded xorshift, so the random splits are the same every run.
    pub(crate) struct Rng(pub(crate) u64);
    impl Rng {
        pub(crate) fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        pub(crate) fn below(&mut self, n: usize) -> usize {
            (self.next() % n.max(1) as u64) as usize
        }
        pub(crate) fn lines(&mut self, count: usize, longest: usize) -> Vec<u8> {
            let mut out = Vec::new();
            for _ in 0..count {
                let len = self.below(longest);
                out.extend((0..len).map(|_| b'a' + self.below(26) as u8));
                out.push(b'\n');
            }
            out
        }
    }

    fn lens(chunks: &[Chunk]) -> Vec<(usize, bool)> {
        chunks.iter().map(|chunk| (chunk.data.len(), chunk.mid_line)).collect()
    }

    #[test]
    fn cuts_after_the_first_line_end_past_the_target() {
        // Lines of 3 bytes: the first newline at index >= 7 is at 7, so the cut is at 8.
        let (chunks, tail) = split(b"ab\nab\nab\nab\nab\nab\n", SMALL);
        assert_eq!(lens(&chunks), [(9, false), (9, false)]);
        assert!(tail.is_empty());
        // One line longer than the target ends its chunk where it ends.
        let (chunks, tail) = split(b"abcdefghijkl\nxy", SMALL);
        assert_eq!(lens(&chunks), [(13, false)]);
        assert_eq!(tail, b"xy");
        // No line end before the most a chunk holds: a cut in the middle of the line.
        let long = [b'x'; 45];
        let (chunks, tail) = split(&long, SMALL);
        assert_eq!(lens(&chunks), [(20, true), (20, true)]);
        assert_eq!(tail.len(), 5);
        // A newline right at the start doesn't count toward the target.
        let (chunks, tail) = split(b"\n\n\n\n\n\n\n\n\n", SMALL);
        assert_eq!(lens(&chunks), [(8, false)]);
        assert_eq!(tail, b"\n");
    }

    #[test]
    fn bytes_fed_in_any_pieces_cut_the_same() {
        let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
        for _ in 0..200 {
            let count = rng.below(40);
            let mut data = rng.lines(count, 30);
            if rng.below(4) == 0 {
                data.extend(std::iter::repeat_n(b'z', rng.below(60)));
            }
            let (whole, whole_tail) = split(&data, SMALL);
            let mut cutter = LineCut::new(SMALL);
            let mut pieces = Vec::new();
            let mut rest = &data[..];
            while !rest.is_empty() {
                let n = 1 + rng.below(rest.len());
                cutter.push(&rest[..n], &mut pieces);
                rest = &rest[n..];
            }
            assert_eq!(pieces, whole);
            assert_eq!(cutter.tail(), &whole_tail[..]);
            let joined: Vec<u8> = whole.iter().flat_map(|chunk| chunk.data.iter().copied()).chain(whole_tail.iter().copied()).collect();
            assert_eq!(joined, data);
        }
    }

    #[test]
    fn adding_to_the_end_never_moves_an_earlier_cut() {
        let mut rng = Rng(42);
        for _ in 0..200 {
            let count = 1 + rng.below(40);
            let data = rng.lines(count, 30);
            let short = &data[..rng.below(data.len())];
            let (long_chunks, _) = split(&data, SMALL);
            let (short_chunks, short_tail) = split(short, SMALL);
            // Every whole chunk of the shorter file is a chunk of the longer one, in place.
            assert_eq!(short_chunks[..], long_chunks[..short_chunks.len()]);
            // Its tail sits inside the longer file's next chunk, or its tail.
            let offset: usize = short_chunks.iter().map(|chunk| chunk.data.len()).sum();
            assert!(data[offset..].starts_with(&short_tail));
            if let Some(next) = long_chunks.get(short_chunks.len()) {
                assert!(short_tail.len() <= next.data.len());
            }
        }
    }
}
