// Base64 VLQ codec: the wire format everything else stands on. Round-trip
// coverage plus the malformed inputs `check` relies on being rejected.
import test from "node:test";
import assert from "node:assert/strict";
import {
  vlqDecode,
  vlqEncode,
  vlqEncodeSegment,
  base64Decode,
  utf8Decode,
  VlqError,
} from "../dist/vlq.js";

test("decodes canonical single- and multi-digit values", () => {
  // "A" is 0, "C" is 1, "D" is -1 (sign bit is the LSB of the zig-zag value);
  // 16 does not fit in one 5-bit digit and becomes "gB".
  assert.deepEqual(vlqDecode("A", 0), { value: 0, next: 1 });
  assert.deepEqual(vlqDecode("C", 0), { value: 1, next: 1 });
  assert.deepEqual(vlqDecode("D", 0), { value: -1, next: 1 });
  assert.deepEqual(vlqDecode("gB", 0), { value: 16, next: 2 });
  assert.deepEqual(vlqDecode("hB", 0), { value: -16, next: 2 });
});

test("encode/decode round-trips across the interesting range", () => {
  const values = [0, 1, -1, 15, 16, -16, 31, 32, 1023, -1024, 123456, -654321];
  for (const v of values) {
    const enc = vlqEncode(v);
    assert.deepEqual(vlqDecode(enc, 0), { value: v, next: enc.length }, `value ${v}`);
  }
});

test("decodes consecutive values using the returned offset", () => {
  const s = vlqEncode(7) + vlqEncode(-3) + vlqEncode(100);
  let pos = 0;
  const out = [];
  while (pos < s.length) {
    const { value, next } = vlqDecode(s, pos);
    out.push(value);
    pos = next;
  }
  assert.deepEqual(out, [7, -3, 100]);
});

test("segment encoding concatenates fields with no separator", () => {
  assert.equal(vlqEncodeSegment([0, 0, 0, 0]), "AAAA");
  assert.equal(vlqEncodeSegment([1, 0, 0, 1, 0]), "CAACA");
});

test("rejects malformed input: bad characters, truncation, overflow", () => {
  assert.throws(() => vlqDecode("!", 0), VlqError);
  assert.throws(() => vlqDecode("A~B", 1), VlqError);
  // "g" has the continuation bit set but nothing follows.
  assert.throws(() => vlqDecode("g", 0), VlqError);
  // Runs that would overflow 32 bits are rejected, not wrapped.
  assert.throws(() => vlqDecode("gggggggg", 0), VlqError);
});

test("base64/UTF-8 decoding covers data: URI payloads end to end", () => {
  // "aGk=" is "hi"; characters outside the alphabet are rejected.
  assert.deepEqual(base64Decode("aGk="), [0x68, 0x69]);
  assert.throws(() => base64Decode("a*b"), VlqError);
  const enc = (s) => [...new TextEncoder().encode(s)];
  for (const s of ["hello", "héllo", "日本語のログ", "emoji \u{1F41B} bug"]) {
    assert.equal(utf8Decode(enc(s)), s);
  }
  // 0xE6 opens a 3-byte sequence that never completes -> U+FFFD.
  assert.equal(utf8Decode([0x61, 0xe6, 0x62]), "a�b");
});
