/**
 * The HueStream v2 wire format.
 *
 * One datagram carries the full state of every channel in an entertainment
 * configuration. Layout, all integers big-endian:
 *
 * | Offset | Size | Meaning                                          |
 * |--------|------|--------------------------------------------------|
 * | 0      | 9    | `"HueStream"`                                    |
 * | 9      | 2    | protocol version, `0x02 0x00`                    |
 * | 11     | 1    | sequence number (the bridge ignores it)          |
 * | 12     | 2    | reserved, zero                                   |
 * | 14     | 1    | colour space: 0 = RGB, 1 = xy + brightness       |
 * | 15     | 1    | reserved, zero                                   |
 * | 16     | 36   | entertainment configuration id, ASCII UUID       |
 * | 52     | 7*n  | per channel: id byte, then three uint16          |
 *
 * RGB mode is used throughout: each lamp in an area may have a different gamut,
 * and the bridge maps RGB onto every one of them itself.
 */

export const MAGIC = "HueStream";
export const HEADER_SIZE = 52;
export const CHANNEL_RECORD_SIZE = 7;
/**
 * The bridge accepts at most 20 channels in one entertainment configuration.
 */
export const MAX_CHANNELS = 20;
export const UUID_LENGTH = 36;

export enum ColorSpace {
  Rgb = 0x00,
  Xy = 0x01,
}

/**
 * One channel's colour: `[channelId, c0, c1, c2]` with 16-bit components.
 */
export type ChannelRecord = [number, number, number, number];

/**
 * A reusable frame buffer for one entertainment area.
 * The header is written once; each `write()` only touches the sequence byte and
 * the channel records, so streaming at 60 fps allocates nothing.
 */
export class HueStreamFrame {
  public readonly buffer: Buffer;

  /**
   * @param entertainmentId The 36-character entertainment configuration UUID.
   * @param channelIds Channel ids in the order their colours will be written.
   * @param colorSpace Colour space of the values. Default is RGB.
   */
  constructor(entertainmentId: string, public readonly channelIds: readonly number[], colorSpace = ColorSpace.Rgb) {
    validate(entertainmentId, channelIds.length, colorSpace);
    this.buffer = Buffer.alloc(HEADER_SIZE + CHANNEL_RECORD_SIZE * channelIds.length);
    this.buffer.write(MAGIC, 0, "ascii");
    this.buffer[9] = 0x02;
    this.buffer[10] = 0x00;
    this.buffer[14] = colorSpace;
    this.buffer.write(entertainmentId, 16, "ascii");
    channelIds.forEach((id, i) => {
      this.buffer[HEADER_SIZE + CHANNEL_RECORD_SIZE * i] = id & 0xff;
    });
  }

  /**
   * Fill in the sequence number and channel values, returning the frame buffer.
   * @param sequence Sequence number; only the low byte is sent.
   * @param values Three 16-bit components per channel, in `channelIds` order.
   */
  public write(sequence: number, values: ArrayLike<number>): Buffer {
    this.buffer[11] = sequence & 0xff;
    for (let i = 0; i < this.channelIds.length; i++) {
      const at = HEADER_SIZE + CHANNEL_RECORD_SIZE * i + 1;
      this.buffer.writeUInt16BE(clampU16(values[i * 3]), at);
      this.buffer.writeUInt16BE(clampU16(values[i * 3 + 1]), at + 2);
      this.buffer.writeUInt16BE(clampU16(values[i * 3 + 2]), at + 4);
    }
    return this.buffer;
  }
}

/**
 * Serialise one frame from scratch. Convenient for tests and one-off sends;
 * the streaming engine uses `HueStreamFrame` instead.
 */
export function buildFrame(
  entertainmentId: string,
  channels: readonly ChannelRecord[],
  sequence = 0,
  colorSpace = ColorSpace.Rgb,
): Buffer {
  const frame = new HueStreamFrame(entertainmentId, channels.map((c) => c[0]), colorSpace);
  return frame.write(sequence, channels.flatMap((c) => [c[1], c[2], c[3]]));
}

/**
 * Convert `[channelId, [r, g, b]]` with 0-1 floats into 16-bit records.
 */
export function rgbChannels(values: readonly [number, readonly [number, number, number]][]): ChannelRecord[] {
  return values.map(([id, [r, g, b]]) => [id, unitToU16(r), unitToU16(g), unitToU16(b)]);
}

/**
 * Scale a 0-1 value to 0-65535 (truncating, as v1 did), clamping out-of-range
 * input and sending NaN as 0.
 */
export function unitToU16(value: number): number {
  if (!(value > 0)) return 0; // Also catches NaN
  if (value >= 1) return 65535;
  return Math.floor(value * 65535);
}

function clampU16(value: number): number {
  if (!(value > 0)) return 0;
  return value > 65535 ? 65535 : Math.round(value);
}

function validate(entertainmentId: string, channelCount: number, colorSpace: number): void {
  if (channelCount > MAX_CHANNELS) {
    throw new Error(`An entertainment configuration carries at most ${MAX_CHANNELS} channels, got ${channelCount}.`);
  }
  if (colorSpace !== ColorSpace.Rgb && colorSpace !== ColorSpace.Xy) {
    throw new Error(`Unknown colour space ${colorSpace}.`);
  }
  // eslint-disable-next-line no-control-regex
  if (entertainmentId.length !== UUID_LENGTH || !/^[\x00-\x7f]*$/.test(entertainmentId)) {
    throw new Error(`Entertainment configuration id must be a ${UUID_LENGTH}-character UUID, got ${entertainmentId.length} characters.`);
  }
}
