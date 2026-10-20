// Serving a driver's photo: only JPEG or PNG, and never with its metadata. Phone cameras write EXIF,
// which can hold the GPS position, the device and the time; all of it is removed here, segment by
// segment, without re-encoding the picture.

export type ImageType = "image/jpeg" | "image/png";

export function sniffImage(bytes: Uint8Array): ImageType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((b, i) => bytes[i] === b)) return "image/png";
  return null;
}

// JPEG: keep SOI, APP0 (JFIF) and every coding segment; drop APP1-APP15 (EXIF, XMP, ICC, maker
// notes) and comments. Everything from the start of scan on is image data and is copied as is.
function stripJpeg(bytes: Uint8Array): Uint8Array {
  const out: number[] = [0xff, 0xd8];
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) throw new Error("malformed JPEG: expected a marker");
    const marker = bytes[i + 1]!;
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0xd9) break; // EOI before any scan
    const length = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    if (length < 2 || i + 2 + length > bytes.length) throw new Error("malformed JPEG: bad segment length");
    const end = i + 2 + length;
    const isAppN = marker >= 0xe1 && marker <= 0xef;
    if (!isAppN && marker !== 0xfe) for (let j = i; j < end; j++) out.push(bytes[j]!);
    i = end;
    if (marker === 0xda) {
      for (let j = i; j < bytes.length; j++) out.push(bytes[j]!);
      return Uint8Array.from(out);
    }
  }
  throw new Error("malformed JPEG: no image data");
}

// PNG: drop text, EXIF and time chunks; keep everything that draws the picture.
const PNG_DROP = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);
function stripPng(bytes: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= bytes.length) {
    const length = ((bytes[i]! << 24) | (bytes[i + 1]! << 16) | (bytes[i + 2]! << 8) | bytes[i + 3]!) >>> 0;
    const type = String.fromCharCode(bytes[i + 4]!, bytes[i + 5]!, bytes[i + 6]!, bytes[i + 7]!);
    const end = i + 12 + length;
    if (end > bytes.length) throw new Error("malformed PNG: bad chunk length");
    if (!PNG_DROP.has(type)) parts.push(bytes.subarray(i, end));
    i = end;
    if (type === "IEND") break;
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// Returns the image with its metadata removed, or null when the bytes are not a JPEG or PNG.
export function stripImageMetadata(bytes: Uint8Array): { type: ImageType; bytes: Uint8Array } | null {
  const type = sniffImage(bytes);
  if (type === "image/jpeg") return { type, bytes: stripJpeg(bytes) };
  if (type === "image/png") return { type, bytes: stripPng(bytes) };
  return null;
}
