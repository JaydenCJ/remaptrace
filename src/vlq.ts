/**
 * Base64 VLQ codec — the wire encoding of the `mappings` field in Source Map
 * revision 3 — plus a dependency-free base64/UTF-8 decoder for inline
 * `data:` source-map URIs. Implemented from the spec so the tool ships zero
 * runtime dependencies; the encoder exists so tests and fixtures can build
 * real maps instead of pasting opaque strings.
 */

const B64_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const B64_VALUES: number[] = (() => {
  const table = new Array<number>(128).fill(-1);
  for (let i = 0; i < B64_CHARS.length; i += 1) {
    table[B64_CHARS.charCodeAt(i)] = i;
  }
  return table;
})();

/** Continuation bit: more digits follow. */
const VLQ_CONTINUE = 0x20;
/** Payload bits per base64 digit. */
const VLQ_SHIFT = 5;
const VLQ_MASK = 0x1f;

/** Thrown for malformed VLQ input; `check` maps it to a stable code. */
export class VlqError extends Error {}

/**
 * Decode one VLQ value starting at `pos`. Returns the value and the index of
 * the first character after it. Throws `VlqError` on a character outside the
 * base64 alphabet or a run that ends mid-value.
 */
export function vlqDecode(
  s: string,
  pos: number
): { value: number; next: number } {
  let result = 0;
  let shift = 0;
  let i = pos;
  for (;;) {
    if (i >= s.length) {
      throw new VlqError(`unterminated VLQ at offset ${pos}`);
    }
    const code = s.charCodeAt(i);
    const digit = code < 128 ? (B64_VALUES[code] ?? -1) : -1;
    if (digit === -1) {
      throw new VlqError(
        `invalid base64 character ${JSON.stringify(s[i] ?? "")} at offset ${i}`
      );
    }
    i += 1;
    result += (digit & VLQ_MASK) << shift;
    if ((digit & VLQ_CONTINUE) === 0) break;
    shift += VLQ_SHIFT;
    if (shift > 30) {
      throw new VlqError(`VLQ value too large at offset ${pos}`);
    }
  }
  // The sign lives in the least significant bit of the zig-zag value.
  const negative = (result & 1) === 1;
  result >>>= 1;
  return { value: negative ? -result : result, next: i };
}

/** Encode one signed integer as base64 VLQ. */
export function vlqEncode(value: number): string {
  let vlq = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = "";
  do {
    let digit = vlq & VLQ_MASK;
    vlq >>>= VLQ_SHIFT;
    if (vlq > 0) digit |= VLQ_CONTINUE;
    out += B64_CHARS[digit];
  } while (vlq > 0);
  return out;
}

/** Encode a whole segment (1, 4 or 5 fields) as consecutive VLQs. */
export function vlqEncodeSegment(fields: number[]): string {
  return fields.map(vlqEncode).join("");
}

/**
 * Decode standard base64 (with optional padding) to a byte array.
 * Used for `data:application/json;base64,` source-map URIs.
 */
export function base64Decode(s: string): number[] {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s.charCodeAt(i);
    if (s[i] === "=") break;
    const value = ch < 128 ? (B64_VALUES[ch] ?? -1) : -1;
    if (value === -1) {
      throw new VlqError(`invalid base64 character at offset ${i}`);
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return bytes;
}

/** Decode a UTF-8 byte array to a string (surrogate pairs included). */
export function utf8Decode(bytes: number[]): string {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i] ?? 0;
    let cp: number;
    let extra: number;
    if (b0 < 0x80) {
      cp = b0;
      extra = 0;
    } else if ((b0 & 0xe0) === 0xc0) {
      cp = b0 & 0x1f;
      extra = 1;
    } else if ((b0 & 0xf0) === 0xe0) {
      cp = b0 & 0x0f;
      extra = 2;
    } else if ((b0 & 0xf8) === 0xf0) {
      cp = b0 & 0x07;
      extra = 3;
    } else {
      cp = 0xfffd; // replacement character for a stray continuation byte
      extra = 0;
    }
    for (let k = 0; k < extra; k += 1) {
      const bk = bytes[i + 1 + k];
      if (bk === undefined || (bk & 0xc0) !== 0x80) {
        cp = 0xfffd;
        extra = k;
        break;
      }
      cp = (cp << 6) | (bk & 0x3f);
    }
    i += 1 + extra;
    out += String.fromCodePoint(cp > 0x10ffff ? 0xfffd : cp);
  }
  return out;
}
