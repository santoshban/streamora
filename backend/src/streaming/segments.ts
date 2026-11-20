/**
 * HLS segment plans. A plan is the start time (seconds, media timeline) of
 * every segment; segment `i` covers `[starts[i], starts[i+1] ?? duration)`.
 *
 * The whole VOD playlist is published up front from the plan, and every
 * ffmpeg run (initial start, seek, prefetch) cuts exactly at these times,
 * so segments produced by different runs are interchangeable.
 */

export const SEGMENT_SECONDS = 4;
/** Remux plans whose keyframes are further apart than this fall back to transcoding. */
const MAX_COPY_SEGMENT_SECONDS = 20;

export interface SegmentPlan {
  starts: number[];
  duration: number;
  /** `grid`: fixed length (transcode, forced keyframes) · `keyframes`: cut on source keyframes (stream copy). */
  kind: 'grid' | 'keyframes';
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function gridPlan(duration: number, length = SEGMENT_SECONDS): SegmentPlan {
  const count = Math.max(1, Math.ceil(duration / length - 1e-6));
  return { starts: Array.from({ length: count }, (_, i) => round3(i * length)), duration, kind: 'grid' };
}

/**
 * Groups source keyframes (already shifted to the media timeline) into
 * segments of at least `length` seconds. Returns `null` when the index is
 * too sparse to give reasonably sized segments.
 */
export function keyframePlan(keyframes: number[], duration: number, length = SEGMENT_SECONDS): SegmentPlan | null {
  const starts = [0];
  for (const kf of keyframes) {
    if (kf >= duration - 0.5) break;
    if (kf - starts[starts.length - 1]! >= length) starts.push(round3(kf));
  }
  const plan: SegmentPlan = { starts, duration, kind: 'keyframes' };
  for (let i = 0; i < starts.length; i++) {
    if (segmentDuration(plan, i) > MAX_COPY_SEGMENT_SECONDS) return null;
  }
  return plan;
}

export function segmentEnd(plan: SegmentPlan, index: number): number {
  return plan.starts[index + 1] ?? plan.duration;
}

export function segmentDuration(plan: SegmentPlan, index: number): number {
  return Math.max(0, segmentEnd(plan, index) - plan.starts[index]!);
}

export function segmentCount(plan: SegmentPlan): number {
  return plan.starts.length;
}

/** Index of the segment containing `seconds`. */
export function segmentAt(plan: SegmentPlan, seconds: number): number {
  let lo = 0;
  let hi = plan.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (plan.starts[mid]! <= seconds) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function mediaPlaylist(plan: SegmentPlan, uri: (index: number) => string): string {
  const durations = plan.starts.map((_, i) => segmentDuration(plan, i));
  const target = Math.max(1, Math.ceil(Math.max(...durations) - 1e-3));
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${target}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-INDEPENDENT-SEGMENTS',
  ];
  durations.forEach((d, i) => lines.push(`#EXTINF:${d.toFixed(3)},`, uri(i)));
  lines.push('#EXT-X-ENDLIST', '');
  return lines.join('\n');
}
