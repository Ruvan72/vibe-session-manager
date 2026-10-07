// Draws the tray icon (a coloured disc with the attention count) as PNG, without image libraries.

import { deflateSync } from 'node:zlib'

type RGB = [number, number, number]

export const COLORS: Record<'red' | 'yellow' | 'green' | 'grey', RGB> = {
  red: [229, 72, 77],
  yellow: [245, 165, 36],
  green: [48, 164, 108],
  grey: [139, 141, 152]
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// 3x5 pixel glyphs.
const GLYPHS: Record<string, string> = {
  '0': '111101101101111',
  '1': '010110010010111',
  '2': '111001111100111',
  '3': '111001111001111',
  '4': '101101111001001',
  '5': '111100111001111',
  '6': '111100111101111',
  '7': '111001001001001',
  '8': '111101111101111',
  '9': '111101111001111',
  '+': '000010111010000'
}

/** Frames in one turn of the "working" spinner. */
export const SPINNER_FRAMES = 12

/**
 * count > 0: filled disc with the number. count = 0: a ring (green while something is working).
 *
 * spinFrame (0 … SPINNER_FRAMES-1) draws a turning green ring instead: a bright head with a fading
 * tail, shown while a session is working. A count is then drawn in a smaller disc inside the ring.
 */
export function drawTrayIcon(size: number, count: number, color: keyof typeof COLORS, spinFrame: number | null = null): Buffer {
  const px = new Uint8Array(size * size * 4)
  const c = size / 2
  const outer = size / 2 - 0.5
  const ringWidth = Math.max(1.5, size / 8)
  const spinning = spinFrame !== null
  // With the spinner around it, the disc shrinks to leave a gap inside the ring.
  const discR = spinning ? outer - ringWidth - Math.max(1, size / 16) : outer
  const head = spinning ? (spinFrame / SPINNER_FRAMES) * 2 * Math.PI : 0
  const SS = 4
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let a = 0
      const rgb = [0, 0, 0]
      const add = (col: RGB, alpha: number) => {
        a += alpha
        for (let k = 0; k < 3; k++) rgb[k] += col[k] * alpha
      }
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const dx = x + (sx + 0.5) / SS - c
          const dy = y + (sy + 0.5) / SS - c
          const d = Math.hypot(dx, dy)
          if (d > outer) continue
          if (spinning) {
            if (d >= outer - ringWidth) {
              // 0 at the head, growing clockwise behind it: the tail fades out.
              const behind = (((head - Math.atan2(dy, dx)) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
              add(COLORS.green, 1 - 0.85 * (behind / (2 * Math.PI)))
            } else if (count > 0 && d <= discR) add(COLORS[color], 1)
          } else if (count > 0 || d >= outer - ringWidth) add(COLORS[color], 1)
        }
      }
      const i = (y * size + x) * 4
      if (a) for (let k = 0; k < 3; k++) px[i + k] = Math.round(rgb[k] / a)
      px[i + 3] = Math.round((a / (SS * SS)) * 255)
    }
  }

  if (count > 0) {
    const text = count > 9 ? '9+' : String(count)
    const scale = Math.max(1, Math.floor((2 * discR * (text.length === 1 ? 0.7 : 0.5)) / 5))
    const gw = 3 * scale
    const gap = scale
    const w = text.length * gw + (text.length - 1) * gap
    const h = 5 * scale
    const x0 = Math.round((size - w) / 2)
    const y0 = Math.round((size - h) / 2)
    const ink = color === 'yellow' ? [40, 30, 0] : [255, 255, 255]
    ;[...text].forEach((ch, k) => {
      const glyph = GLYPHS[ch]
      for (let gy = 0; gy < 5; gy++) {
        for (let gx = 0; gx < 3; gx++) {
          if (glyph[gy * 3 + gx] !== '1') continue
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              const x = x0 + k * (gw + gap) + gx * scale + dx
              const y = y0 + gy * scale + dy
              if (x < 0 || y < 0 || x >= size || y >= size) continue
              const i = (y * size + x) * 4
              px[i] = ink[0]
              px[i + 1] = ink[1]
              px[i + 2] = ink[2]
              px[i + 3] = 255
            }
          }
        }
      }
    })
  }
  return encodePng(size, size, px)
}

/** App icon for the window and taskbar: a dark rounded square with a red, yellow and green light. */
export function drawAppIcon(size: number): Buffer {
  const px = new Uint8Array(size * size * 4)
  const SS = 4
  const r = size * 0.22
  const lights: [number, RGB][] = [
    [0.27, COLORS.red],
    [0.5, COLORS.yellow],
    [0.73, COLORS.green]
  ]
  const lightR = size * 0.095
  const insideRounded = (x: number, y: number) => {
    const cx = Math.min(Math.max(x, r), size - r)
    const cy = Math.min(Math.max(y, r), size - r)
    return Math.hypot(x - cx, y - cy) <= r
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let a = 0
      let rgb = [0, 0, 0]
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS
          const fy = y + (sy + 0.5) / SS
          if (!insideRounded(fx, fy)) continue
          let c: RGB = [36, 40, 52]
          for (const [ly, color] of lights) if (Math.hypot(fx - size / 2, fy - size * ly) <= lightR) c = color
          rgb = rgb.map((v, i) => v + c[i])
          a++
        }
      }
      const i = (y * size + x) * 4
      if (a) for (let k = 0; k < 3; k++) px[i + k] = Math.round(rgb[k] / a)
      px[i + 3] = Math.round((a / (SS * SS)) * 255)
    }
  }
  return encodePng(size, size, px)
}
