import fs from 'node:fs/promises';

/*
 * Reads video keyframe timestamps from a container's own index without
 * demuxing the file: Matroska `Cues` and MP4 `stss` sample tables. Remuxed
 * HLS (video stream copy) needs them because segments can only start on a
 * keyframe; knowing where they are lets every ffmpeg restart cut identical
 * segments, so seeking stays seamless.
 *
 * Both parsers read a few hundred KiB at most and give up (return `null`)
 * on anything unexpected; the caller then transcodes instead.
 */

const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_TOP_LEVEL_ELEMENTS = 500_000;

class Reader {
  private constructor(
    private readonly handle: fs.FileHandle,
    readonly size: number,
  ) {}

  static async open(file: string): Promise<Reader> {
    const handle = await fs.open(file, 'r');
    const st = await handle.stat();
    return new Reader(handle, st.size);
  }

  async read(position: number, length: number): Promise<Buffer> {
    const len = Math.max(0, Math.min(length, this.size - position));
    const buf = Buffer.alloc(len);
    if (len === 0) return buf;
    const { bytesRead } = await this.handle.read(buf, 0, len, position);
    return bytesRead === len ? buf : buf.subarray(0, bytesRead);
  }

  close(): Promise<void> {
    return this.handle.close();
  }
}

// ── Matroska ─────────────────────────────────────────────────────────────────

const MKV = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  Cluster: 0x1f43b675,
} as const;

interface Vint {
  value: number;
  length: number;
  unknown: boolean;
}

/** EBML variable-length integer. IDs keep their marker bit; sizes do not. */
function readVint(buf: Buffer, offset: number, keepMarker: boolean): Vint | undefined {
  const first = buf[offset];
  if (first === undefined || first === 0) return undefined;
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 8 || offset + length > buf.length) return undefined;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === (0xff >> length);
  for (let i = 1; i < length; i++) {
    const b = buf[offset + i]!;
    value = value * 256 + b;
    if (b !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

interface ElementHeader {
  id: number;
  /** Payload size; `-1` for unknown-size elements. */
  size: number;
  headerLength: number;
}

function readHeader(buf: Buffer, offset: number): ElementHeader | undefined {
  const id = readVint(buf, offset, true);
  if (!id) return undefined;
  const size = readVint(buf, offset + id.length, false);
  if (!size) return undefined;
  return { id: id.value, size: size.unknown ? -1 : size.value, headerLength: id.length + size.length };
}

function readUint(buf: Buffer, offset: number, size: number): number {
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + buf[offset + i]!;
  return v;
}

/** Iterates the children of an element held entirely in `buf`. */
function* children(buf: Buffer, start = 0, end = buf.length): Generator<ElementHeader & { offset: number; dataOffset: number }> {
  let offset = start;
  while (offset < end) {
    const h = readHeader(buf, offset);
    if (!h || h.size < 0) return;
    const dataOffset = offset + h.headerLength;
    if (dataOffset + h.size > end) return;
    yield { ...h, offset, dataOffset };
    offset = dataOffset + h.size;
  }
}

async function readElementHeaderAt(reader: Reader, position: number): Promise<ElementHeader | undefined> {
  return readHeader(await reader.read(position, 16), 0);
}

async function matroskaKeyframes(reader: Reader): Promise<number[] | null> {
  const ebml = await readElementHeaderAt(reader, 0);
  if (!ebml || ebml.id !== MKV.EBML || ebml.size < 0) return null;
  const segmentPos = ebml.headerLength + ebml.size;
  const segment = await readElementHeaderAt(reader, segmentPos);
  if (!segment || segment.id !== MKV.Segment) return null;
  const segmentData = segmentPos + segment.headerLength;
  const segmentEnd = segment.size < 0 ? reader.size : Math.min(reader.size, segmentData + segment.size);

  const positions: { info?: number; tracks?: number; cues?: number } = {};

  const parseSeekHead = (buf: Buffer) => {
    for (const seek of children(buf)) {
      if (seek.id !== MKV.Seek) continue;
      let id: number | undefined;
      let pos: number | undefined;
      for (const c of children(buf, seek.dataOffset, seek.dataOffset + seek.size)) {
        if (c.id === MKV.SeekID) id = readUint(buf, c.dataOffset, c.size);
        if (c.id === MKV.SeekPosition) pos = readUint(buf, c.dataOffset, c.size);
      }
      if (id === undefined || pos === undefined) continue;
      const abs = segmentData + pos;
      if (id === MKV.Info) positions.info ??= abs;
      if (id === MKV.Tracks) positions.tracks ??= abs;
      if (id === MKV.Cues) positions.cues ??= abs;
    }
  };

  // Walk top-level elements (headers only) until Info, Tracks and Cues are located.
  let pos = segmentData;
  for (let n = 0; pos < segmentEnd && n < MAX_TOP_LEVEL_ELEMENTS; n++) {
    if (positions.info !== undefined && positions.tracks !== undefined && positions.cues !== undefined) break;
    const h = await readElementHeaderAt(reader, pos);
    if (!h || h.size < 0) break;
    if (h.id === MKV.SeekHead && h.size < 1024 * 1024) parseSeekHead(await reader.read(pos + h.headerLength, h.size));
    if (h.id === MKV.Info) positions.info ??= pos;
    if (h.id === MKV.Tracks) positions.tracks ??= pos;
    if (h.id === MKV.Cues) positions.cues ??= pos;
    pos += h.headerLength + h.size;
  }
  if (positions.cues === undefined || positions.tracks === undefined) return null;

  const loadElement = async (at: number, expectedId: number): Promise<Buffer | null> => {
    const h = await readElementHeaderAt(reader, at);
    if (!h || h.id !== expectedId || h.size < 0 || h.size > MAX_INDEX_BYTES) return null;
    return reader.read(at + h.headerLength, h.size);
  };

  let timestampScale = 1_000_000;
  if (positions.info !== undefined) {
    const info = await loadElement(positions.info, MKV.Info);
    for (const c of info ? children(info) : []) {
      if (c.id === MKV.TimestampScale) timestampScale = readUint(info!, c.dataOffset, c.size) || timestampScale;
    }
  }

  const tracks = await loadElement(positions.tracks, MKV.Tracks);
  if (!tracks) return null;
  let videoTrack: number | undefined;
  for (const entry of children(tracks)) {
    if (entry.id !== MKV.TrackEntry) continue;
    let number: number | undefined;
    let type: number | undefined;
    for (const c of children(tracks, entry.dataOffset, entry.dataOffset + entry.size)) {
      if (c.id === MKV.TrackNumber) number = readUint(tracks, c.dataOffset, c.size);
      if (c.id === MKV.TrackType) type = readUint(tracks, c.dataOffset, c.size);
    }
    if (type === 1 && number !== undefined) {
      videoTrack = number;
      break;
    }
  }
  if (videoTrack === undefined) return null;

  const cues = await loadElement(positions.cues, MKV.Cues);
  if (!cues) return null;
  const times: number[] = [];
  for (const point of children(cues)) {
    if (point.id !== MKV.CuePoint) continue;
    let time: number | undefined;
    let forVideo = false;
    for (const c of children(cues, point.dataOffset, point.dataOffset + point.size)) {
      if (c.id === MKV.CueTime) time = readUint(cues, c.dataOffset, c.size);
      if (c.id === MKV.CueTrackPositions) {
        for (const p of children(cues, c.dataOffset, c.dataOffset + c.size)) {
          if (p.id === MKV.CueTrack && readUint(cues, p.dataOffset, p.size) === videoTrack) forVideo = true;
        }
      }
    }
    if (time !== undefined && forVideo) times.push((time * timestampScale) / 1e9);
  }
  return times;
}

// ── MP4 / MOV ────────────────────────────────────────────────────────────────

interface Box {
  type: string;
  offset: number;
  dataOffset: number;
  size: number;
}

function* boxes(buf: Buffer, start = 0, end = buf.length): Generator<Box> {
  let offset = start;
  while (offset + 8 <= end) {
    let size = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) return;
      size = Number(buf.readBigUInt64BE(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) return;
    yield { type, offset, dataOffset: offset + header, size: size - header };
    offset += size;
  }
}

const find = (buf: Buffer, parent: Box | undefined, type: string): Box | undefined => {
  if (!parent) return undefined;
  for (const b of boxes(buf, parent.dataOffset, parent.dataOffset + parent.size)) if (b.type === type) return b;
  return undefined;
};

async function locateMoov(reader: Reader): Promise<Buffer | null> {
  let pos = 0;
  for (let n = 0; pos + 8 <= reader.size && n < 10_000; n++) {
    const head = await reader.read(pos, 16);
    if (head.length < 8) return null;
    let size = head.readUInt32BE(0);
    const type = head.toString('latin1', 4, 8);
    let header = 8;
    if (size === 1) {
      size = Number(head.readBigUInt64BE(8));
      header = 16;
    } else if (size === 0) {
      size = reader.size - pos;
    }
    if (size < header) return null;
    if (type === 'moov') return size > MAX_INDEX_BYTES ? null : reader.read(pos, size);
    pos += size;
  }
  return null;
}

function mp4KeyframesFromMoov(moovBuf: Buffer): number[] | null {
  const [moov] = [...boxes(moovBuf)];
  if (!moov || moov.type !== 'moov') return null;
  if (find(moovBuf, moov, 'mvex')) return null; // fragmented MP4: samples live in moof boxes

  let movieTimescale = 1000;
  const mvhd = find(moovBuf, moov, 'mvhd');
  if (mvhd) {
    const v = moovBuf[mvhd.dataOffset];
    movieTimescale = moovBuf.readUInt32BE(mvhd.dataOffset + (v === 1 ? 20 : 12)) || 1000;
  }

  for (const trak of boxes(moovBuf, moov.dataOffset, moov.dataOffset + moov.size)) {
    if (trak.type !== 'trak') continue;
    const mdia = find(moovBuf, trak, 'mdia');
    const hdlr = find(moovBuf, mdia, 'hdlr');
    if (!hdlr || moovBuf.toString('latin1', hdlr.dataOffset + 8, hdlr.dataOffset + 12) !== 'vide') continue;

    const mdhd = find(moovBuf, mdia, 'mdhd');
    if (!mdhd) return null;
    const mdhdVersion = moovBuf[mdhd.dataOffset];
    const timescale = moovBuf.readUInt32BE(mdhd.dataOffset + (mdhdVersion === 1 ? 20 : 12));
    if (!timescale) return null;

    const stbl = find(moovBuf, find(moovBuf, mdia, 'minf'), 'stbl');
    const stts = find(moovBuf, stbl, 'stts');
    if (!stts) return null;

    // Decode timestamp of every sample, run-length expanded lazily.
    const sttsCount = moovBuf.readUInt32BE(stts.dataOffset + 4);
    const runs: Array<[count: number, delta: number]> = [];
    let totalSamples = 0;
    for (let i = 0; i < sttsCount; i++) {
      const o = stts.dataOffset + 8 + i * 8;
      if (o + 8 > stts.dataOffset + stts.size) return null;
      const count = moovBuf.readUInt32BE(o);
      runs.push([count, moovBuf.readUInt32BE(o + 4)]);
      totalSamples += count;
    }

    const stss = find(moovBuf, stbl, 'stss');
    let sync: number[];
    if (stss) {
      const n = moovBuf.readUInt32BE(stss.dataOffset + 4);
      if (stss.dataOffset + 8 + n * 4 > stss.dataOffset + stss.size) return null;
      sync = Array.from({ length: n }, (_, i) => moovBuf.readUInt32BE(stss.dataOffset + 8 + i * 4));
    } else {
      sync = Array.from({ length: Math.min(totalSamples, 1_000_000) }, (_, i) => i + 1); // every sample is a sync sample
    }

    // Composition offsets (B-frames) for the sync samples.
    const ctts = find(moovBuf, stbl, 'ctts');
    const cttsRuns: Array<[count: number, offset: number]> = [];
    if (ctts) {
      const n = moovBuf.readUInt32BE(ctts.dataOffset + 4);
      for (let i = 0; i < n; i++) {
        const o = ctts.dataOffset + 8 + i * 8;
        if (o + 8 > ctts.dataOffset + ctts.size) break;
        cttsRuns.push([moovBuf.readUInt32BE(o), moovBuf.readInt32BE(o + 4)]);
      }
    }

    // Edit list: leading empty edit delays the track, media_time trims its start.
    let shift = 0;
    const elst = find(moovBuf, find(moovBuf, trak, 'edts'), 'elst');
    if (elst) {
      const version = moovBuf[elst.dataOffset];
      const n = moovBuf.readUInt32BE(elst.dataOffset + 4);
      const entrySize = version === 1 ? 20 : 12;
      for (let i = 0; i < n; i++) {
        const o = elst.dataOffset + 8 + i * entrySize;
        if (o + entrySize > elst.dataOffset + elst.size) break;
        const duration = version === 1 ? Number(moovBuf.readBigUInt64BE(o)) : moovBuf.readUInt32BE(o);
        const mediaTime = version === 1 ? Number(moovBuf.readBigInt64BE(o + 8)) : moovBuf.readInt32BE(o + 4);
        if (mediaTime === -1) {
          shift += duration / movieTimescale;
          continue;
        }
        shift -= mediaTime / timescale;
        break;
      }
    }

    const times: number[] = [];
    let runIndex = 0;
    let runLeft = runs[0]?.[0] ?? 0;
    let sample = 1;
    let dts = 0;
    let cttsIndex = 0;
    let cttsLeft = cttsRuns[0]?.[0] ?? 0;
    let cttsSample = 1;
    for (const target of sync) {
      while (sample < target && runIndex < runs.length) {
        const step = Math.min(runLeft, target - sample);
        dts += step * runs[runIndex]![1];
        sample += step;
        runLeft -= step;
        if (runLeft === 0) {
          runIndex++;
          runLeft = runs[runIndex]?.[0] ?? 0;
        }
      }
      if (sample !== target) break;
      while (cttsIndex < cttsRuns.length && cttsSample + cttsLeft <= target) {
        cttsSample += cttsLeft;
        cttsIndex++;
        cttsLeft = cttsRuns[cttsIndex]?.[0] ?? 0;
      }
      const offset = cttsRuns[cttsIndex]?.[1] ?? 0;
      times.push((dts + offset) / timescale + shift);
    }
    return times;
  }
  return null;
}

async function mp4Keyframes(reader: Reader): Promise<number[] | null> {
  const moov = await locateMoov(reader);
  return moov ? mp4KeyframesFromMoov(moov) : null;
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Keyframe presentation times in seconds (the container's own timeline, i.e.
 * before ffmpeg subtracts the format start time), sorted and de-duplicated.
 * `null` when the container has no usable index.
 */
export async function readKeyframes(file: string, container: string | null): Promise<number[] | null> {
  const kind =
    container === 'mkv' || container === 'webm' ? 'mkv' : container && ['mp4', 'm4v', 'mov'].includes(container) ? 'mp4' : null;
  if (!kind) return null;
  const reader = await Reader.open(file);
  try {
    const raw = kind === 'mkv' ? await matroskaKeyframes(reader) : await mp4Keyframes(reader);
    if (!raw || raw.length < 2) return null;
    const sorted = [...new Set(raw.map((t) => Math.round(t * 1000) / 1000))].filter((t) => t >= 0).sort((a, b) => a - b);
    return sorted.length >= 2 ? sorted : null;
  } catch {
    return null;
  } finally {
    await reader.close();
  }
}
