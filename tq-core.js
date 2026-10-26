/*
 * tq-core.js — browser/Node port of the "tiktok-quality" MP4 container transform
 * (https://github.com/BastienGimbert/tiktok-quality, MIT License, © Bastien Gimbert).
 *
 * Inflates the declared frame count of an H.264 MP4 with "ghost frames" that all point
 * at one 8-byte filler NAL. No pixels are changed and nothing is re-encoded.
 * Works on a random-access reader so large files never have to be fully loaded
 * (important on iPhone): only the moov box and the first video sample are read into memory.
 */
(function (root) {
  'use strict';

  const PADDING_NAL = new Uint8Array([0, 0, 0, 4, 0, 0, 0, 0]);
  const PADDING_SIZE = 8;
  const KEEP_NALU_TYPES = new Set([1, 5]);
  const LANG_UND = 0x55c4;
  const DEFAULT_COMMENT = 'TK8vY5VqBA6hUlo1yuGvNA';

  class TQError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }

  // ---------- byte helpers ----------
  const u32 = (d, o) => ((d[o] << 24) >>> 0) + (d[o + 1] << 16) + (d[o + 2] << 8) + d[o + 3];
  const u16 = (d, o) => (d[o] << 8) | d[o + 1];
  const typeAt = (d, o) => String.fromCharCode(d[o], d[o + 1], d[o + 2], d[o + 3]);
  const latin1 = (s) => { const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff; return a; };
  const utf8 = (s) => new TextEncoder().encode(s);
  const be32 = (n) => { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, n >>> 0); return a; };
  const zeros = (n) => new Uint8Array(n);

  function cat(parts) {
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  function indexOfBytes(hay, needle, from = 0) {
    outer: for (let i = from; i <= hay.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
      return i;
    }
    return -1;
  }

  // ---------- parser ----------
  function findBox(d, type, offset = 0, end = d.length) {
    let pos = offset;
    while (pos + 8 <= end) {
      const size = u32(d, pos);
      if (size < 8) break;
      if (typeAt(d, pos + 4) === type) return [pos, size];
      pos += size;
    }
    return [null, null];
  }

  function findBoxPath(d, path, offset = 0, end = d.length) {
    let co = offset, ce = end;
    for (let i = 0; i < path.length; i++) {
      let pos = co, found = false;
      while (pos + 8 <= ce) {
        const size = u32(d, pos);
        if (size < 8) break;
        if (typeAt(d, pos + 4) === path[i]) {
          if (i === path.length - 1) return [pos, size];
          co = pos + 8; ce = pos + size; found = true;
          break;
        }
        pos += size;
      }
      if (!found) return [null, null];
    }
    return [null, null];
  }

  function findTrackByHandler(d, moovOff, moovSize, handler) {
    let pos = moovOff + 8;
    const end = moovOff + moovSize;
    while (pos + 8 <= end) {
      const size = u32(d, pos);
      if (size < 8) break;
      if (typeAt(d, pos + 4) === 'trak') {
        const [h] = findBoxPath(d, ['mdia', 'hdlr'], pos + 8, pos + size);
        if (h && typeAt(d, h + 16) === handler) return [pos, size];
      }
      pos += size;
    }
    return [null, null];
  }

  const parseStts = (d, o) => { const n = u32(d, o + 12), r = []; for (let i = 0; i < n; i++) r.push([u32(d, o + 16 + i * 8), u32(d, o + 20 + i * 8)]); return r; };
  const parseStsz = (d, o) => { const uni = u32(d, o + 12), n = u32(d, o + 16), r = new Array(n); for (let i = 0; i < n; i++) r[i] = uni !== 0 ? uni : u32(d, o + 20 + i * 4); return r; };
  const parseStsc = (d, o) => { const n = u32(d, o + 12), r = []; for (let i = 0; i < n; i++) r.push([u32(d, o + 16 + i * 12), u32(d, o + 20 + i * 12), u32(d, o + 24 + i * 12)]); return r; };
  const parseStco = (d, o) => { const n = u32(d, o + 12), r = new Array(n); for (let i = 0; i < n; i++) r[i] = u32(d, o + 16 + i * 4); return r; };

  function parseNalus(s) {
    const r = [];
    let pos = 0;
    while (pos + 4 <= s.length) {
      const len = u32(s, pos);
      if (pos + 4 + len > s.length) break;
      r.push([s[pos + 4] & 0x1f, len, s.subarray(pos, pos + 4 + len)]);
      pos += 4 + len;
    }
    return r;
  }

  // ---------- builder ----------
  const buildBox = (type, content) => cat([be32(8 + content.length), latin1(type), content]);
  const buildFtyp = () => buildBox('ftyp', cat([latin1('isom'), be32(512), latin1('isomiso2avc1mp41')]));
  const buildFree = () => cat([be32(8), latin1('free')]);

  function patched(src, writes) {
    const c = new Uint8Array(src);
    const dv = new DataView(c.buffer);
    for (const [off, val, bits] of writes) bits === 16 ? dv.setUint16(off, val) : dv.setUint32(off, val >>> 0);
    return c;
  }
  const buildMvhd = (content, durMs) => buildBox('mvhd', patched(content, [[16, durMs]]));
  const buildMdhd = (content, dur, lang) => buildBox('mdhd', patched(content, [[16, dur], [20, lang, 16]]));
  const buildTkhd = (full, durMs) => patched(full, [[28, durMs]]);
  const buildHdlr = (handler, name) => buildBox('hdlr', cat([be32(0), be32(0), latin1(handler), zeros(12), utf8(name), zeros(1)]));

  function table(type, header, rows, cols) {
    const body = new Uint8Array(rows.length * cols * 4);
    const dv = new DataView(body.buffer);
    let o = 0;
    for (const r of rows) {
      if (cols === 1) { dv.setUint32(o, r >>> 0); o += 4; }
      else for (let i = 0; i < cols; i++) { dv.setUint32(o, r[i] >>> 0); o += 4; }
    }
    return buildBox(type, cat([...header.map(be32), body]));
  }
  const buildStts = (e) => table('stts', [0, e.length], e, 2);
  const buildStsc = (e) => table('stsc', [0, e.length], e, 3);
  const buildStsz = (s) => table('stsz', [0, 0, s.length], s, 1);
  const buildStco = (o) => table('stco', [0, o.length], o, 1);

  function buildStsdVideo(fixed, avcc, colr, pasp, btrt) {
    const content = cat([fixed, avcc, colr, pasp, btrt]);
    const avc1 = cat([be32(8 + content.length), latin1('avc1'), content]);
    return buildBox('stsd', cat([be32(0), be32(1), avc1]));
  }
  const buildAvcc = (orig) => buildBox('avcC', cat([orig, new Uint8Array([0xfd, 0xf8, 0xf8, 0x00])]));
  const buildBtrt = (a, b, c) => buildBox('btrt', cat([be32(a), be32(b), be32(c)]));

  function buildUdtaComment(comment) {
    const metaHdlr = buildBox('hdlr', cat([be32(0), be32(0), latin1('mdir'), latin1('appl'), zeros(8), zeros(1)]));
    const dataBox = buildBox('data', cat([be32(1), be32(0), utf8(comment)]));
    const cmt = cat([be32(8 + dataBox.length), new Uint8Array([0xa9, 0x63, 0x6d, 0x74]), dataBox]);
    const ilst = buildBox('ilst', cmt);
    const meta = buildBox('meta', cat([be32(0), metaHdlr, ilst]));
    return buildBox('udta', meta);
  }

  const slice = (d, pos, size) => d.subarray(pos, pos + size);

  // ---------- top-level scan ----------
  async function scanTopLevel(reader) {
    const boxes = {};
    let pos = 0;
    while (pos + 8 <= reader.size) {
      const h = await reader.readAt(pos, 16);
      let size = u32(h, 0);
      const type = typeAt(h, 4);
      let hdr = 8;
      if (size === 1) { size = u32(h, 8) * 4294967296 + u32(h, 12); hdr = 16; }
      else if (size === 0) size = reader.size - pos;
      if (size < 8) break;
      if (!(type in boxes)) boxes[type] = { pos, size, hdr };
      pos += size;
    }
    return boxes;
  }

  /**
   * Inspect a file without transforming it. Returns codec/fps/resolution/duration info.
   */
  async function inspect(reader) {
    const top = await scanTopLevel(reader);
    if (!top.moov || !top.mdat) throw new TQError('NOT_MP4', 'Missing moov or mdat box');
    const m = await reader.readAt(top.moov.pos, top.moov.size);
    const [vt, vs] = findTrackByHandler(m, 0, m.length, 'vide');
    if (vt === null) throw new TQError('NO_VIDEO', 'No video track found');
    const [stbl, stblSize] = findBoxPath(m, ['mdia', 'minf', 'stbl'], vt + 8, vt + vs);
    const [stsd] = findBox(m, 'stsd', stbl + 8, stbl + stblSize);
    const codec = typeAt(m, stsd + 8 + 12);
    const [stts] = findBox(m, 'stts', stbl + 8, stbl + stblSize);
    const [stsz] = findBox(m, 'stsz', stbl + 8, stbl + stblSize);
    const [mdhd] = findBoxPath(m, ['mdia', 'mdhd'], vt + 8, vt + vs);
    const ts = u32(m, mdhd + 20), dur = u32(m, mdhd + 24);
    const frames = u32(m, stsz + 16);
    const delta = u32(m, stts + 20);
    const [aTrak] = findTrackByHandler(m, 0, m.length, 'soun');
    return {
      codec,
      width: u16(m, stsd + 8 + 40),
      height: u16(m, stsd + 8 + 42),
      fps: ts / delta,
      avgFps: dur ? frames / (dur / ts) : 0,
      frames,
      duration: dur / ts,
      hasAudio: aTrak !== null,
      size: reader.size,
    };
  }

  /**
   * Transform. Returns { parts, size, stats } where parts is an ordered list of
   * Uint8Array chunks and {start,end} ranges of the source file to copy verbatim.
   */
  async function transform(reader, opts = {}) {
    const multiplier = opts.multiplier || 10;
    const comment = opts.comment || DEFAULT_COMMENT;
    const progress = opts.onProgress || (() => {});

    progress(0.05);
    const top = await scanTopLevel(reader);
    if (!top.moov || !top.mdat) throw new TQError('NOT_MP4', 'Missing moov or mdat box');
    const mdatPos = top.mdat.pos, mdatSize = top.mdat.size, mdatDataStart = mdatPos + top.mdat.hdr;
    const m = await reader.readAt(top.moov.pos, top.moov.size);
    const moovSize = m.length;
    progress(0.2);

    // ----- video track -----
    const [vtPos, vtSize] = findTrackByHandler(m, 0, moovSize, 'vide');
    if (vtPos === null) throw new TQError('NO_VIDEO', 'No video track found');
    const vtStart = vtPos + 8, vtEnd = vtPos + vtSize;
    const [stblPos, stblSize] = findBoxPath(m, ['mdia', 'minf', 'stbl'], vtStart, vtEnd);
    const sbS = stblPos + 8, sbE = stblPos + stblSize;

    const [stcoPos] = findBox(m, 'stco', sbS, sbE);
    if (stcoPos === null) {
      const [co64] = findBox(m, 'co64', sbS, sbE);
      throw new TQError(co64 !== null ? 'CO64' : 'NO_STCO', 'Unsupported chunk offset table');
    }
    const [stszPos] = findBox(m, 'stsz', sbS, sbE);
    const [stscPos] = findBox(m, 'stsc', sbS, sbE);
    const [sttsPos] = findBox(m, 'stts', sbS, sbE);
    const [stsdPos, stsdSize] = findBox(m, 'stsd', sbS, sbE);
    const [stssPos, stssSize] = findBox(m, 'stss', sbS, sbE);
    const [sdtpPos, sdtpSize] = findBox(m, 'sdtp', sbS, sbE);
    const [cttsPos, cttsSize] = findBox(m, 'ctts', sbS, sbE);

    const stsdContent = slice(m, stsdPos + 8, stsdSize - 8);
    const codec = typeAt(stsdContent, 12);
    if (codec !== 'avc1') throw new TQError(codec === 'hvc1' || codec === 'hev1' ? 'HEVC' : 'CODEC', 'Unsupported codec ' + codec);

    const videoChunks = parseStco(m, stcoPos);
    const videoSizes = parseStsz(m, stszPos);
    const videoStsc = parseStsc(m, stscPos);
    const videoStts = parseStts(m, sttsPos);

    const origFrames = videoSizes.length;
    const timeDelta = videoStts[0][1];
    const padCount = origFrames * (multiplier - 1);
    const totalFrames = origFrames + padCount;

    const [vMdhdPos, vMdhdSize] = findBoxPath(m, ['mdia', 'mdhd'], vtStart, vtEnd);
    const vTimescale = u32(m, vMdhdPos + 20);
    const vDuration = u32(m, vMdhdPos + 24);
    const vDurationSec = vDuration / vTimescale;

    // ----- strip SEI from first sample -----
    const firstOff = videoChunks[0];
    const firstSize = videoSizes[0];
    const firstSample = await reader.readAt(firstOff, firstSize);
    const kept = parseNalus(firstSample).filter(([t]) => KEEP_NALU_TYPES.has(t)).map(([, , d]) => d);
    const newFirst = kept.length ? cat(kept) : firstSample;
    const newFirstSize = newFirst.length;
    const seiRemoved = firstSize - newFirstSize;
    progress(0.35);

    // ----- audio track -----
    const [atPos, atSize] = findTrackByHandler(m, 0, moovSize, 'soun');
    const hasAudio = atPos !== null;
    let a = null;
    if (hasAudio) {
      a = {};
      const atStart = atPos + 8, atEnd = atPos + atSize;
      const [aStblPos, aStblSize] = findBoxPath(m, ['mdia', 'minf', 'stbl'], atStart, atEnd);
      const aS = aStblPos + 8, aE = aStblPos + aStblSize;
      const [aStcoPos] = findBox(m, 'stco', aS, aE);
      if (aStcoPos === null) throw new TQError('CO64', 'Unsupported audio chunk offset table');
      const [aStszPos, aStszSize] = findBox(m, 'stsz', aS, aE);
      const [aStscPos, aStscSize] = findBox(m, 'stsc', aS, aE);
      const [aSttsPos] = findBox(m, 'stts', aS, aE);
      const [aStsdPos, aStsdSize] = findBox(m, 'stsd', aS, aE);
      const [aSgpdPos, aSgpdSize] = findBox(m, 'sgpd', aS, aE);
      const [aSbgpPos, aSbgpSize] = findBox(m, 'sbgp', aS, aE);

      a.chunks = parseStco(m, aStcoPos);
      const aSizes = parseStsz(m, aStszPos);
      const aStts = parseStts(m, aSttsPos);
      const [aMdhdPos, aMdhdSize] = findBoxPath(m, ['mdia', 'mdhd'], atStart, atEnd);
      const aTimescale = u32(m, aMdhdPos + 20);

      const keepOriginalTiming = () => {
        a.stts = aStts;
        a.dur = u32(m, aMdhdPos + 24);
        a.durMs = Math.floor(a.dur * 1000 / aTimescale);
      };
      const [aElstPos] = findBoxPath(m, ['edts', 'elst'], atStart, atEnd);
      if (aElstPos !== null) {
        const segDurMs = u32(m, aElstPos + 16);
        const mediaTime = u32(m, aElstPos + 20);
        a.durMs = segDurMs;
        a.dur = Math.floor(segDurMs * aTimescale / 1000);
        const aDelta = aStts[0][1];
        const mainN = aSizes.length - 1;
        const lastDelta = a.dur + mediaTime - mainN * aDelta;
        if (lastDelta > 0 && lastDelta <= aDelta) a.stts = [[mainN, aDelta], [1, lastDelta]];
        else keepOriginalTiming();
      } else keepOriginalTiming();

      const totalABytes = aSizes.reduce((s, x) => s + x, 0);
      const ticks = (st) => st.reduce((s, [c, d]) => s + c * d, 0);
      const oldBr = Math.floor(totalABytes * 8 * aTimescale / ticks(aStts));
      const newBr = Math.floor(totalABytes * 8 * aTimescale / ticks(a.stts));

      const [aTkhdPos, aTkhdSize] = findBox(m, 'tkhd', atStart, atEnd);
      a.tkhd = buildTkhd(slice(m, aTkhdPos, aTkhdSize), a.durMs);
      const [aEdtsPos, aEdtsSize] = findBox(m, 'edts', atStart, atEnd);
      a.edts = aEdtsPos !== null ? slice(m, aEdtsPos, aEdtsSize) : zeros(0);
      a.mdhd = buildMdhd(slice(m, aMdhdPos + 8, aMdhdSize - 8), a.dur, LANG_UND);
      a.hdlr = buildHdlr('soun', 'SoundHandler');
      const [smhdPos, smhdSize] = findBoxPath(m, ['mdia', 'minf', 'smhd'], atStart, atEnd);
      a.smhd = smhdPos !== null ? slice(m, smhdPos, smhdSize) : zeros(0);
      const [aDinfPos, aDinfSize] = findBoxPath(m, ['mdia', 'minf', 'dinf'], atStart, atEnd);
      a.dinf = slice(m, aDinfPos, aDinfSize);

      const stsd = new Uint8Array(slice(m, aStsdPos, aStsdSize));
      const oldB = be32(oldBr), newB = be32(newBr);
      let p = 0, idx;
      while ((idx = indexOfBytes(stsd, oldB, p)) !== -1) { stsd.set(newB, idx); p = idx + 4; }
      a.stsd = stsd;
      a.sttsBox = buildStts(a.stts);
      a.stsc = slice(m, aStscPos, aStscSize);
      a.stsz = slice(m, aStszPos, aStszSize);
      a.sgpd = aSgpdPos !== null ? slice(m, aSgpdPos, aSgpdSize) : zeros(0);
      a.sbgp = aSbgpPos !== null ? slice(m, aSbgpPos, aSbgpSize) : zeros(0);
    }
    progress(0.5);

    // ----- new mdat layout (as references into the source file) -----
    const mdatEnd = mdatPos + mdatSize;
    const beforeLen = firstOff - mdatDataStart;
    const afterLen = mdatEnd - (firstOff + firstSize);
    const newMdatContentLen = beforeLen + newFirstSize + afterLen + PADDING_SIZE;
    if (8 + newMdatContentLen > 0xffffffff) throw new TQError('TOO_BIG', 'File too large');

    // ----- moov -----
    const ftyp = buildFtyp();
    const free = buildFree();
    const [mvhdPos, mvhdSize] = findBox(m, 'mvhd', 8, moovSize);
    const [vTkhdPos] = findBox(m, 'tkhd', vtStart, vtEnd);
    const vTkhdDurMs = u32(m, vTkhdPos + 28);
    const mvhd = buildMvhd(slice(m, mvhdPos + 8, mvhdSize - 8), hasAudio ? Math.max(vTkhdDurMs, a.durMs) : vTkhdDurMs);

    const videoTkhd = slice(m, vtStart, u32(m, vtStart));
    const [edtsPos, edtsSize] = findBox(m, 'edts', vtStart, vtEnd);
    const videoEdts = edtsPos !== null ? slice(m, edtsPos, edtsSize) : zeros(0);
    const videoMdhd = slice(m, vMdhdPos, vMdhdSize);
    const [vHdlrPos, vHdlrSize] = findBoxPath(m, ['mdia', 'hdlr'], vtStart, vtEnd);
    const videoHdlr = slice(m, vHdlrPos, vHdlrSize);
    const [vmhdPos, vmhdSize] = findBoxPath(m, ['mdia', 'minf', 'vmhd'], vtStart, vtEnd);
    const videoVmhd = slice(m, vmhdPos, vmhdSize);
    const [dinfPos, dinfSize] = findBoxPath(m, ['mdia', 'minf', 'dinf'], vtStart, vtEnd);
    const videoDinf = slice(m, dinfPos, dinfSize);

    const avc1Fixed = stsdContent.subarray(16, 94);
    const avccStart = indexOfBytes(stsdContent, latin1('avcC')) - 4;
    const avccOrigSize = u32(stsdContent, avccStart);
    const avccNew = buildAvcc(stsdContent.subarray(avccStart + 8, avccStart + avccOrigSize));
    const subBox = (name) => {
      const r = indexOfBytes(stsdContent, latin1(name));
      if (r < 0) return zeros(0);
      const s = r - 4;
      return stsdContent.subarray(s, s + u32(stsdContent, s));
    };
    const colr = subBox('colr');
    const pasp = subBox('pasp');
    const totalVBytes = videoSizes.reduce((s, x) => s + x, 0) - firstSize + newFirstSize;
    const newVAvgBr = Math.trunc(totalVBytes * 8 / vDurationSec);
    const btrtRel = indexOfBytes(stsdContent, latin1('btrt'));
    const maxBr = btrtRel >= 0 ? u32(stsdContent, btrtRel + 8) : newVAvgBr;
    const videoStsdNew = buildStsdVideo(avc1Fixed, avccNew, colr, pasp, buildBtrt(0, maxBr, newVAvgBr));

    const videoSttsNew = buildStts([[origFrames, timeDelta], [padCount, timeDelta]]);
    const videoStss = stssPos !== null ? slice(m, stssPos, stssSize) : zeros(0);
    const videoSdtp = sdtpPos !== null ? slice(m, sdtpPos, sdtpSize) : zeros(0);
    const videoCtts = cttsPos !== null ? slice(m, cttsPos, cttsSize) : zeros(0);
    const videoStscNew = buildStsc([...videoStsc, [videoChunks.length + 1, 1, 1]]);
    const stszList = new Array(origFrames + padCount);
    stszList[0] = newFirstSize;
    for (let i = 1; i < origFrames; i++) stszList[i] = videoSizes[i];
    for (let i = origFrames; i < stszList.length; i++) stszList[i] = PADDING_SIZE;
    const videoStszNew = buildStsz(stszList);
    progress(0.65);

    const buildMoov = (vStco, aStco) => {
      const vStbl = buildBox('stbl', cat([videoStsdNew, videoSttsNew, videoStss, videoSdtp, videoCtts, videoStscNew, videoStszNew, vStco]));
      const vMinf = buildBox('minf', cat([videoVmhd, videoDinf, vStbl]));
      const vMdia = buildBox('mdia', cat([videoMdhd, videoHdlr, vMinf]));
      const vTrak = buildBox('trak', cat([videoTkhd, videoEdts, vMdia]));
      let aTrak = zeros(0);
      if (hasAudio) {
        const aStbl = buildBox('stbl', cat([a.stsd, a.sttsBox, a.stsc, a.stsz, aStco, a.sgpd, a.sbgp]));
        const aMinf = buildBox('minf', cat([a.smhd, a.dinf, aStbl]));
        const aMdia = buildBox('mdia', cat([a.mdhd, a.hdlr, aMinf]));
        aTrak = buildBox('trak', cat([a.tkhd, a.edts, aMdia]));
      }
      return buildBox('moov', cat([mvhd, vTrak, aTrak, buildUdtaComment(comment)]));
    };

    const totalVChunks = videoChunks.length + padCount;
    const placeholder = (n) => { const s = 16 + n * 4; return cat([be32(s), latin1('stco'), zeros(s - 8)]); };
    const moovSizeFinal = buildMoov(placeholder(totalVChunks), hasAudio ? placeholder(a.chunks.length) : zeros(0)).length;

    const newMdatStart = ftyp.length + free.length + moovSizeFinal + 8;
    const firstVideoRel = firstOff - mdatDataStart;
    const padAbs = newMdatStart + newMdatContentLen - PADDING_SIZE;
    const newV = new Array(totalVChunks);
    for (let i = 0; i < videoChunks.length; i++) {
      const rel = videoChunks[i] - mdatDataStart;
      newV[i] = rel <= firstVideoRel ? newMdatStart + rel : newMdatStart + rel - seiRemoved;
    }
    for (let i = videoChunks.length; i < totalVChunks; i++) newV[i] = padAbs;
    let aStcoFinal = zeros(0);
    if (hasAudio) {
      aStcoFinal = buildStco(a.chunks.map((off) => {
        const rel = off - mdatDataStart;
        return rel < firstVideoRel ? newMdatStart + rel : newMdatStart + rel - seiRemoved;
      }));
    }
    const moov = buildMoov(buildStco(newV), aStcoFinal);
    if (moov.length !== moovSizeFinal) throw new TQError('INTERNAL', 'moov size mismatch');
    progress(0.85);

    const mdatHeader = cat([be32(8 + newMdatContentLen), latin1('mdat')]);
    const parts = [
      ftyp, free, moov, mdatHeader,
      { start: mdatDataStart, end: firstOff },
      newFirst,
      { start: firstOff + firstSize, end: mdatEnd },
      PADDING_NAL,
    ];
    const size = ftyp.length + free.length + moov.length + 8 + newMdatContentLen;
    return {
      parts,
      size,
      stats: {
        inputSize: reader.size,
        outputSize: size,
        originalFrames: origFrames,
        declaredFrames: totalFrames,
        ghostFrames: padCount,
        multiplier,
        fps: vTimescale / timeDelta,
        seiRemoved,
      },
    };
  }

  // ---------- readers ----------
  function fileReader(file) {
    return {
      size: file.size,
      async readAt(off, len) {
        const end = Math.min(off + len, file.size);
        return new Uint8Array(await file.slice(off, end).arrayBuffer());
      },
    };
  }

  /** Browser helper: turns transform() parts into a Blob without copying the video data. */
  function toBlob(file, result) {
    const blobParts = result.parts.map((p) => (p instanceof Uint8Array ? p : file.slice(p.start, p.end)));
    return new Blob(blobParts, { type: 'video/mp4' });
  }

  const api = { transform, inspect, fileReader, toBlob, TQError, DEFAULT_COMMENT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TQ = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
