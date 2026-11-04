/**
 * Minimal QR encoder (byte mode, error correction M, versions 1–10, up to 213 bytes) → inline SVG.
 * Used for Solana Pay links in the payment card: a phone wallet scans it, the transfer and memo are filled in.
 * No dependencies; the output is checked against an independent decoder in the repo's page tests.
 *   window.__twentyQR.svg(text, { size })   → '<svg …>' string, dark on white, with the 4-module quiet zone
 *   window.__twentyQR.matrix(text)          → boolean[][] (row-major, true = dark)
 */
(function () {
  const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];   // level M, index = version
  const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
  const MAX_VER = 10;
  const bit = (x, i) => ((x >>> i) & 1) !== 0;

  function rawModules(v) { let r = (16 * v + 128) * v + 64; if (v >= 2) { const na = Math.floor(v / 7) + 2; r -= (25 * na - 10) * na - 55; if (v >= 7) r -= 36; } return r; }
  const dataCodewords = (v) => Math.floor(rawModules(v) / 8) - ECC_PER_BLOCK[v] * BLOCKS[v];

  function gfMul(x, y) { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; } return z; }
  function rsDivisor(deg) { const r = new Array(deg).fill(0); r[deg - 1] = 1; let root = 1; for (let i = 0; i < deg; i++) { for (let j = 0; j < deg; j++) { r[j] = gfMul(r[j], root); if (j + 1 < deg) r[j] ^= r[j + 1]; } root = gfMul(root, 2); } return r; }
  function rsRemainder(data, div) { const r = new Array(div.length).fill(0); for (const b of data) { const f = b ^ r.shift(); r.push(0); div.forEach((c, i) => { r[i] ^= gfMul(c, f); }); } return r; }

  function encodeData(bytes) {
    let v = 1; const need = (ver) => 4 + (ver < 10 ? 8 : 16) + bytes.length * 8;
    while (v <= MAX_VER && need(v) > dataCodewords(v) * 8) v++;
    if (v > MAX_VER) throw new Error("QR payload too long");
    const bits = []; const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(0b0100, 4); put(bytes.length, v < 10 ? 8 : 16); bytes.forEach((b) => put(b, 8));
    const cap = dataCodewords(v) * 8; put(0, Math.min(4, cap - bits.length)); while (bits.length % 8) bits.push(0);
    for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
    const data = []; for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
    return { v, data };
  }

  function interleave(data, v) {
    const nb = BLOCKS[v], eccLen = ECC_PER_BLOCK[v], raw = Math.floor(rawModules(v) / 8), nShort = nb - (raw % nb), shortLen = Math.floor(raw / nb);
    const div = rsDivisor(eccLen); const blocks = []; let k = 0;
    for (let i = 0; i < nb; i++) { const dat = data.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1)); k += dat.length; const ecc = rsRemainder(dat, div); if (i < nShort) dat.push(0); blocks.push(dat.concat(ecc)); }
    const out = []; for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= nShort) out.push(b[i]); });
    return out;
  }

  function matrix(text) {
    const bytes = Array.from(new TextEncoder().encode(String(text)));
    const { v, data } = encodeData(bytes); const size = v * 4 + 17; const codewords = interleave(data, v);
    const mod = Array.from({ length: size }, () => new Array(size).fill(false)); const fn = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, d) => { mod[y][x] = d; fn[y][x] = true; };
    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    const finder = (cx, cy) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy; if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4); } };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    const pos = (() => { if (v === 1) return []; const n = Math.floor(v / 7) + 2, step = Math.ceil((v * 4 + 4) / (n * 2 - 2)) * 2; const r = [6]; for (let p = size - 7; r.length < n; p -= step) r.splice(1, 0, p); return r; })();
    pos.forEach((px, i) => pos.forEach((py, j) => { if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) return; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1); }));
    const format = (mask) => {
      const d = (0 << 3) | mask; let rem = d; for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537); const bits = ((d << 10) | rem) ^ 0x5412;
      for (let i = 0; i <= 5; i++) set(8, i, bit(bits, i)); set(8, 7, bit(bits, 6)); set(8, 8, bit(bits, 7)); set(7, 8, bit(bits, 8)); for (let i = 9; i < 15; i++) set(14 - i, 8, bit(bits, i));
      for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(bits, i)); for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(bits, i)); set(8, size - 8, true);
    };
    format(0);
    if (v >= 7) { let rem = v; for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25); const bits = (v << 12) | rem; for (let i = 0; i < 18; i++) { const c = bit(bits, i), a = size - 11 + (i % 3), b = Math.floor(i / 3); set(a, b, c); set(b, a, c); } }
    let i = 0; for (let right = size - 1; right >= 1; right -= 2) { if (right === 6) right = 5; for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) { const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert; if (!fn[y][x] && i < codewords.length * 8) { mod[y][x] = bit(codewords[i >>> 3], 7 - (i & 7)); i++; } } }
    const MASKS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0, (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0, (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0];
    const apply = (m) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[m](x, y)) mod[y][x] = !mod[y][x]; };
    const penalty = () => {
      let p = 0;
      for (let y = 0; y < size; y++) { let run = 1; for (let x = 1; x <= size; x++) { if (x < size && mod[y][x] === mod[y][x - 1]) run++; else { if (run >= 5) p += run - 2; run = 1; } } }
      for (let x = 0; x < size; x++) { let run = 1; for (let y = 1; y <= size; y++) { if (y < size && mod[y][x] === mod[y - 1][x]) run++; else { if (run >= 5) p += run - 2; run = 1; } } }
      for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) if (mod[y][x] === mod[y][x + 1] && mod[y][x] === mod[y + 1][x] && mod[y][x] === mod[y + 1][x + 1]) p += 3;
      const dark = mod.reduce((a, r) => a + r.filter(Boolean).length, 0); p += Math.floor(Math.abs((dark * 20) / (size * size) - 10)) * 10; return p;
    };
    let best = 0, bestP = Infinity; for (let m = 0; m < 8; m++) { apply(m); format(m); const p = penalty(); if (p < bestP) { best = m; bestP = p; } apply(m); }
    apply(best); format(best); return mod;
  }

  function svg(text, o) {
    const m = matrix(text), n = m.length, q = 4, px = (o && o.size) || 220; let d = "";
    for (let y = 0; y < n; y++) { let x = 0; while (x < n) { if (!m[y][x]) { x++; continue; } let e = x; while (e < n && m[y][e]) e++; d += `M${x + q} ${y + q}h${e - x}v1h-${e - x}z`; x = e; } }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + q * 2} ${n + q * 2}" width="${px}" height="${px}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  }
  window.__twentyQR = { svg, matrix };
})();
