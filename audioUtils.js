/**
 * audioUtils.js
 *
 * Plivo streams audio as:  base64-encoded μ-law (G.711) 8kHz mono
 * Sarvam AI expects:       raw binary PCM signed 16-bit little-endian 8kHz mono
 *
 * This module handles the conversion. Uses a pre-computed lookup table
 * for maximum speed since this runs on every single audio chunk.
 */

// Pre-computed ITU-T G.711 μ-law decode table
const MULAW_TABLE = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    let u      = ~i & 0xff;
    const sign = u & 0x80;
    const exp  = (u >> 4) & 0x07;
    const mant = u & 0x0f;
    let sample = ((mant << 1) + 33) << exp;
    sample    -= 33;
    table[i]   = sign ? -sample : sample;
  }
  return table;
})();

/**
 * Convert a base64 μ-law string (from Plivo msg.media.payload)
 * into a Node.js Buffer of PCM 16-bit signed LE samples (for Sarvam).
 *
 * Called on every audio chunk — kept allocation-minimal.
 */
function mulawBase64ToPcm16(base64String) {
  const mulawBytes = Buffer.from(base64String, "base64");
  const pcm        = Buffer.allocUnsafe(mulawBytes.length * 2); // 2 bytes per PCM sample

  for (let i = 0; i < mulawBytes.length; i++) {
    pcm.writeInt16LE(MULAW_TABLE[mulawBytes[i]], i * 2);
  }

  return pcm;
}

module.exports = { mulawBase64ToPcm16 };
