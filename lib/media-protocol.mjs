// Transport-only schema: safe for the unprivileged web/broker without ADB imports.
export const STREAM_QUALITIES = Object.freeze(['gaming', 'economy', 'balanced', 'sharp']);
export const STREAM_SCALES = Object.freeze([0.5, 0.75, 1]);
export function streamScale(value) {
  if (value === undefined || value === null) return 1;
  if (![0.5, 0.75, 1, '0.5', '0.75', '1'].includes(value)) throw new Error('Invalid encoded scale');
  return Number(value);
}
export function audioMetadata(m) {
  if (typeof m.supported !== 'boolean') throw new Error('Invalid audio support');
  if (!m.supported) return { type: 'audio', supported: false,
    reason: ['disabled', 'unsupported', 'unavailable'].includes(m.reason) ? m.reason : 'unavailable' };
  if (!['opus', 'pcm'].includes(m.codec) || m.sampleRate !== 48000 || ![1, 2].includes(m.channels)) throw new Error('Invalid audio format');
  return { type: 'audio', supported: true, codec: m.codec, sampleRate: m.sampleRate, channels: m.channels };
}
export function validMediaPacket(data) {
  return data.length >= 9 && data.length <= 1024 * 1024 && [0, 1, 2, 3, 4].includes(data[0]);
}

export function streamAudio(value) {
  if (value === undefined || value === null) return 'opus';
  if (!['off', 'opus', 'raw'].includes(value)) throw new Error('Invalid audio mode');
  return value;
}
