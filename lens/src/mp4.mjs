// Reads an MP4's video track: size, duration and the time of every frame. Pure code.
// SAM 3.1 reports objects per source frame (<Nf>), so playback maps the video's current time
// to a frame number with these times. Handles regular MP4 (phones, cameras: stts) and
// fragmented MP4 (browser recordings: moof/trun).

function boxes(b, start, end) {
  const out = [];
  for (let i = start; i + 8 <= end;) {
    let size = b.readUInt32BE(i), header = 8;
    const type = b.toString('latin1', i + 4, i + 8);
    if (size === 1) { size = Number(b.readBigUInt64BE(i + 8)); header = 16; }
    if (size === 0) size = end - i;
    if (size < header || i + size > end) break;
    out.push({ type, start: i + header, end: i + size });
    i += size;
  }
  return out;
}
const child = (b, box, type) => boxes(b, box.start, box.end).find(x => x.type === type);
const children = (b, box, type) => boxes(b, box.start, box.end).filter(x => x.type === type);

/** → { width, height, duration (s), frameTimes: [s, …] } or null if it isn't an MP4 with video. */
export function mp4Info(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (b.length < 12 || b.toString('latin1', 4, 8) !== 'ftyp') return null;
  const top = boxes(b, 0, b.length);
  const moov = top.find(x => x.type === 'moov');
  if (!moov) return null;
  // The video track: its handler is 'vide'.
  const trak = children(b, moov, 'trak').find(t => {
    const hdlr = child(b, child(b, t, 'mdia') || t, 'hdlr');
    return hdlr && b.toString('latin1', hdlr.start + 8, hdlr.start + 12) === 'vide';
  });
  if (!trak) return null;
  const tkhd = child(b, trak, 'tkhd'), mdia = child(b, trak, 'mdia'), mdhd = child(b, mdia, 'mdhd');
  const trackId = b.readUInt8(tkhd.start) === 1 ? b.readUInt32BE(tkhd.start + 20) : b.readUInt32BE(tkhd.start + 12);
  const width = Math.round(b.readUInt32BE(tkhd.end - 8) / 65536), height = Math.round(b.readUInt32BE(tkhd.end - 4) / 65536);
  const v1 = b.readUInt8(mdhd.start) === 1;
  const timescale = b.readUInt32BE(mdhd.start + (v1 ? 20 : 12));

  const frameTimes = [];
  const stts = child(b, child(b, child(b, mdia, 'minf'), 'stbl'), 'stts');
  let t = 0;
  for (let n = stts ? b.readUInt32BE(stts.start + 4) : 0, i = 0; i < n; i++) {
    const count = b.readUInt32BE(stts.start + 8 + i * 8), delta = b.readUInt32BE(stts.start + 12 + i * 8);
    for (let k = 0; k < count; k++) { frameTimes.push(t / timescale); t += delta; }
  }

  // Fragmented: each moof/traf/trun lists its samples; durations default from tfhd, then trex.
  if (!frameTimes.length) {
    const trex = children(b, child(b, moov, 'mvex') || moov, 'trex').find(x => b.readUInt32BE(x.start + 4) === trackId);
    const trexDuration = trex ? b.readUInt32BE(trex.start + 12) : 0;
    let next = 0;
    for (const moof of top.filter(x => x.type === 'moof')) {
      for (const traf of children(b, moof, 'traf')) {
        const tfhd = child(b, traf, 'tfhd');
        if (!tfhd || b.readUInt32BE(tfhd.start + 4) !== trackId) continue;
        const flags = b.readUInt32BE(tfhd.start) & 0xffffff;
        let o = tfhd.start + 8;
        if (flags & 0x01) o += 8; if (flags & 0x02) o += 4;
        const defaultDuration = flags & 0x08 ? b.readUInt32BE(o) : trexDuration;
        const tfdt = child(b, traf, 'tfdt');
        let time = tfdt ? (b.readUInt8(tfdt.start) === 1 ? Number(b.readBigUInt64BE(tfdt.start + 4)) : b.readUInt32BE(tfdt.start + 4)) : next;
        for (const trun of children(b, traf, 'trun')) {
          const tf = b.readUInt32BE(trun.start) & 0xffffff, count = b.readUInt32BE(trun.start + 4);
          let p = trun.start + 8 + (tf & 0x01 ? 4 : 0) + (tf & 0x04 ? 4 : 0);
          for (let k = 0; k < count; k++) {
            const d = tf & 0x100 ? b.readUInt32BE(p) : defaultDuration;
            p += (tf & 0x100 ? 4 : 0) + (tf & 0x200 ? 4 : 0) + (tf & 0x400 ? 4 : 0) + (tf & 0x800 ? 4 : 0);
            frameTimes.push(time / timescale); time += d;
          }
        }
        next = time;
      }
    }
    t = next;
  }
  if (!frameTimes.length) return null;
  return { width, height, duration: t / timescale, frameTimes: frameTimes.map(x => Math.round(x * 1000) / 1000) };
}
