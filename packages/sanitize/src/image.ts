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
// notes) and comments, also between the scans of a progressive JPEG. Scan data is copied as is.
// The output ends at the end-of-image marker: anything a camera appends after it (a motion
// photo's MP4, the secondary images of an MPF file with their own EXIF) is dropped. A file that
// ends before its end-of-image marker is refused as malformed.
function stripJpeg(bytes: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let i = 2;
  let scanned = false;
  while (i + 2 <= bytes.length) {
    if (bytes[i] !== 0xff) throw new Error("malformed JPEG: expected a marker");
    const marker = bytes[i + 1]!;
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0xd9) {
      if (!scanned) throw new Error("malformed JPEG: no image data");
      parts.push(bytes.subarray(i, i + 2));
      return concat(parts);
    }
    if (i + 4 > bytes.length) break;
    const length = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    if (length < 2 || i + 2 + length > bytes.length) throw new Error("malformed JPEG: bad segment length");
    const end = i + 2 + length;
    const isAppN = marker >= 0xe1 && marker <= 0xef;
    if (!isAppN && marker !== 0xfe) parts.push(bytes.subarray(i, end));
    i = end;
    if (marker === 0xda) {
      scanned = true;
      // Entropy-coded data runs to the next marker that is not a stuffed 0xFF00 or a restart marker.
      let j = i;
      for (;;) {
        if (j + 1 >= bytes.length) throw new Error("malformed JPEG: the file ends inside the image data");
        if (bytes[j] === 0xff) {
          const next = bytes[j + 1]!;
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
            j += 2;
            continue;
          }
          if (next !== 0xff) break;
        }
        j += 1;
      }
      parts.push(bytes.subarray(i, j));
      i = j;
    }
  }
  throw new Error("malformed JPEG: no end of image");
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
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
    // Anything after IEND is not part of the picture and is not served.
    if (type === "IEND") return concat(parts);
  }
  throw new Error("malformed PNG: no IEND chunk");
}

// Returns the image with its metadata removed, or null when the bytes are not a JPEG or PNG.
// Throws on a malformed JPEG or PNG (the read API answers 415 unsupported_media).
export function stripImageMetadata(bytes: Uint8Array): { type: ImageType; bytes: Uint8Array } | null {
  const type = sniffImage(bytes);
  if (type === "image/jpeg") return { type, bytes: stripJpeg(bytes) };
  if (type === "image/png") return { type, bytes: stripPng(bytes) };
  return null;
}
