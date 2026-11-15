// AES-128 decryption, block by block (ECB): the cipher distribution-only Hangul documents (배포용
// 문서, HWP 5.0) store their text with. The browser's own crypto has no ECB mode. Written from the
// standard (FIPS-197); the tables are computed here, not copied.

const SBOX = new Uint8Array(256);
const INV = new Uint8Array(256);
const T = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
(function tables() {
  // multiplication in GF(2^8) by way of logarithms
  const exp = new Uint8Array(512);
  const log = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i++) {
    exp[i] = x;
    log[x] = i;
    x ^= (x << 1) ^ (x & 0x80 ? 0x11b : 0); // × 3
    x &= 0xff;
  }
  for (let i = 255; i < 512; i++) exp[i] = exp[i - 255];
  const mul = (a, b) => (a && b ? exp[log[a] + log[b]] : 0);
  for (let i = 0; i < 256; i++) {
    let s = i ? exp[255 - log[i]] : 0; // inverse
    let x = s;
    for (let k = 0; k < 4; k++) { x = ((x << 1) | (x >> 7)) & 0xff; s ^= x; }
    s ^= 0x63;
    SBOX[i] = s;
    INV[s] = i;
  }
  // inverse round tables: InvMixColumns of InvSubBytes
  for (let i = 0; i < 256; i++) {
    const s = INV[i];
    const w = (mul(s, 14) << 24) | (mul(s, 9) << 16) | (mul(s, 13) << 8) | mul(s, 11);
    for (let k = 0; k < 4; k++) T[k][i] = ((w >>> (8 * k)) | (w << (32 - 8 * k))) >>> 0;
  }
})();

/** The round keys of a 16-byte key, for decryption (in reverse order, InvMixColumns applied). */
function expand(key) {
  const w = new Uint32Array(44);
  for (let i = 0; i < 4; i++) w[i] = (key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3];
  for (let i = 4, rcon = 1; i < 44; i++) {
    let t = w[i - 1];
    if (i % 4 === 0) {
      t = (SBOX[(t >>> 16) & 255] << 24) | (SBOX[(t >>> 8) & 255] << 16) | (SBOX[t & 255] << 8) | SBOX[t >>> 24];
      t ^= rcon << 24;
      rcon = (rcon << 1) ^ (rcon & 0x80 ? 0x11b : 0);
    }
    w[i] = (w[i - 4] ^ t) >>> 0;
  }
  const d = new Uint32Array(44);
  for (let r = 0; r <= 10; r++) {
    for (let c = 0; c < 4; c++) {
      const v = w[(10 - r) * 4 + c];
      // middle rounds: InvMixColumns of the round key
      d[r * 4 + c] = r === 0 || r === 10 ? v
        : T[0][SBOX[v >>> 24]] ^ T[1][SBOX[(v >>> 16) & 255]] ^ T[2][SBOX[(v >>> 8) & 255]] ^ T[3][SBOX[v & 255]];
    }
  }
  return d;
}

/** Decrypts `data` (a multiple of 16 bytes; any rest is left out) with a 16-byte key, block by block. */
export function aesEcbDecrypt(data, key) {
  const k = expand(key);
  const n = data.length - (data.length % 16);
  const out = new Uint8Array(n);
  const s = new Uint32Array(4);
  const t = new Uint32Array(4);
  for (let o = 0; o < n; o += 16) {
    for (let c = 0; c < 4; c++) s[c] = ((data[o + 4 * c] << 24) | (data[o + 4 * c + 1] << 16) | (data[o + 4 * c + 2] << 8) | data[o + 4 * c + 3]) ^ k[c];
    for (let r = 1; r < 10; r++) {
      for (let c = 0; c < 4; c++) {
        t[c] = T[0][s[c] >>> 24] ^ T[1][(s[(c + 3) & 3] >>> 16) & 255] ^ T[2][(s[(c + 2) & 3] >>> 8) & 255] ^ T[3][s[(c + 1) & 3] & 255] ^ k[r * 4 + c];
      }
      s.set(t);
    }
    for (let c = 0; c < 4; c++) {
      const v = ((INV[s[c] >>> 24] << 24) | (INV[(s[(c + 3) & 3] >>> 16) & 255] << 16) | (INV[(s[(c + 2) & 3] >>> 8) & 255] << 8) | INV[s[(c + 1) & 3] & 255]) ^ k[40 + c];
      out[o + 4 * c] = v >>> 24;
      out[o + 4 * c + 1] = (v >>> 16) & 255;
      out[o + 4 * c + 2] = (v >>> 8) & 255;
      out[o + 4 * c + 3] = v & 255;
    }
  }
  return out;
}
