import { deflateSync } from "node:zlib";

/**
 * Renders the cursor sprite the overlay uses: a classic arrow, white fill with a dark outline, antialiased,
 * hotspot at the top-left pixel. Dependency-free so the package ships no binary assets.
 */
export const CURSOR_SIZE = { width: 26, height: 36 };

type Point = [number, number];
// Arrow outline in sprite pixels, tip at (1,1).
const ARROW: Point[] = [
  [1, 1],
  [1, 28],
  [8, 21.5],
  [12.5, 32],
  [17, 30],
  [12.5, 19.5],
  [21.5, 19.5],
];

function pointInPolygon(x: number, y: number, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function distanceToEdges(x: number, y: number, poly: Point[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i]!;
    const [bx, by] = poly[(i + 1) % poly.length]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
    const px = ax + t * dx;
    const py = ay + t * dy;
    best = Math.min(best, Math.hypot(x - px, y - py));
  }
  return best;
}

/** RGBA pixels, 4x supersampled for soft edges. */
export function rasterizeCursor(): Uint8Array {
  const { width, height } = CURSOR_SIZE;
  const out = new Uint8Array(width * height * 4);
  const ss = 4;
  const outline = 1.3;
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      let fill = 0;
      let edge = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = px + (sx + 0.5) / ss;
          const y = py + (sy + 0.5) / ss;
          const inside = pointInPolygon(x, y, ARROW);
          const d = distanceToEdges(x, y, ARROW);
          if (d <= outline) edge++;
          else if (inside) fill++;
        }
      }
      const total = ss * ss;
      const edgeA = edge / total;
      const fillA = fill / total;
      const alpha = Math.min(1, edgeA + fillA);
      const i = (py * width + px) * 4;
      // Blend: outline is near-black, fill is white.
      const white = alpha > 0 ? fillA / alpha : 0;
      out[i] = Math.round(255 * white + 20 * (1 - white));
      out[i + 1] = Math.round(255 * white + 24 * (1 - white));
      out[i + 2] = Math.round(255 * white + 28 * (1 - white));
      out[i + 3] = Math.round(255 * alpha);
    }
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBytes, Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBytes, Buffer.from(data), crc]);
}

/** Encodes RGBA pixels as a PNG (8-bit, filter 0 on every scanline). */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))]);
}

export function cursorPng(): Buffer {
  return encodePng(CURSOR_SIZE.width, CURSOR_SIZE.height, rasterizeCursor());
}
