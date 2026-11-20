/** What this browser can play natively, reported to the server's playback decision. */
export interface ClientCapabilities {
  containers: string[];
  videoCodecs: string[];
  audioCodecs: string[];
  maxAudioChannels: number;
  hdr: boolean;
}

let cached: ClientCapabilities | null = null;

export function detectCapabilities(): ClientCapabilities {
  if (cached) return cached;
  const video = document.createElement('video');
  const can = (type: string) => video.canPlayType(type) !== '';
  const mse = (window as unknown as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource ?? window.MediaSource;
  const mseOk = (type: string) => !!mse?.isTypeSupported?.(type);
  const either = (type: string) => can(type) || mseOk(type);

  const containers = ['mp4', 'm4v'];
  if (can('video/webm')) containers.push('webm');
  if (can('video/quicktime')) containers.push('mov');

  const videoCodecs = ['h264'];
  if (either('video/mp4; codecs="hvc1.1.6.L120.90"') || either('video/mp4; codecs="hev1.1.6.L120.90"')) videoCodecs.push('hevc');
  if (either('video/webm; codecs="vp9"') || either('video/mp4; codecs="vp09.00.10.08"')) videoCodecs.push('vp9');
  if (can('video/webm; codecs="vp8"')) videoCodecs.push('vp8');
  if (either('video/mp4; codecs="av01.0.05M.08"')) videoCodecs.push('av1');

  const audioCodecs = ['aac', 'mp3'];
  if (either('audio/webm; codecs="opus"') || either('audio/mp4; codecs="opus"')) audioCodecs.push('opus');
  if (can('audio/webm; codecs="vorbis"')) audioCodecs.push('vorbis');
  if (can('audio/flac') || either('audio/mp4; codecs="flac"')) audioCodecs.push('flac');
  if (either('audio/mp4; codecs="ac-3"')) audioCodecs.push('ac3');
  if (either('audio/mp4; codecs="ec-3"')) audioCodecs.push('eac3');

  cached = {
    containers,
    videoCodecs,
    audioCodecs,
    maxAudioChannels: 2,
    hdr: window.matchMedia?.('(dynamic-range: high)').matches ?? false,
  };
  return cached;
}
