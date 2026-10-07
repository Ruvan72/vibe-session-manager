import { open, stat } from 'node:fs/promises'

const NEWLINE = 0x0a
const CHUNK = 1 << 20

/**
 * Reads a growing JSONL file incrementally. Remembers the byte offset and any
 * incomplete trailing line, so each call only parses lines appended since the last one.
 */
export class JsonlTail {
  offset = 0
  size = 0
  mtimeMs = 0
  private rest: Buffer = Buffer.alloc(0)

  readonly filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
  }

  reset(): void {
    this.offset = 0
    this.size = 0
    this.mtimeMs = 0
    this.rest = Buffer.alloc(0)
  }

  /**
   * Calls onLine for every complete new line. Lines that are not valid JSON are
   * counted and skipped. Returns the number of lines handled, or -1 if the file shrank
   * (the tail resets itself; the caller should reset its own state and call again).
   */
  async read(onLine: (obj: any) => void): Promise<{ lines: number; bad: number } | -1> {
    const st = await stat(this.filePath)
    if (st.size < this.offset) {
      this.reset()
      return -1
    }
    this.mtimeMs = st.mtimeMs
    this.size = st.size
    if (st.size === this.offset) return { lines: 0, bad: 0 }

    let lines = 0
    let bad = 0
    const fh = await open(this.filePath, 'r')
    try {
      const buf = Buffer.allocUnsafe(CHUNK)
      while (this.offset < st.size) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, st.size - this.offset), this.offset)
        if (bytesRead === 0) break
        this.offset += bytesRead
        let data = this.rest.length ? Buffer.concat([this.rest, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead)
        let start = 0
        for (let i = data.indexOf(NEWLINE); i !== -1; i = data.indexOf(NEWLINE, start)) {
          if (i > start) {
            const text = data.toString('utf8', start, i).trim()
            if (text) {
              let obj: unknown
              try {
                obj = JSON.parse(text)
              } catch {
                bad++
              }
              if (obj && typeof obj === 'object') {
                onLine(obj)
                lines++
              }
            }
          }
          start = i + 1
        }
        // Copy: `data` may be a view into the reused read buffer.
        this.rest = Buffer.from(data.subarray(start))
      }
    } finally {
      await fh.close()
    }
    return { lines, bad }
  }
}
