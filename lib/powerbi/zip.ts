/**
 * Container I/O. PBIX, PBIT and PBIP archives are all plain ZIPs, and several
 * of their parts are UTF-16LE JSON. Everything binary-format-sensitive lives
 * here so parsers stay pure JSON transforms.
 */
import { unzipSync, zipSync } from "fflate";

export type ZipParts = Record<string, Uint8Array>;

/**
 * Read a ZIP. `only` restricts which entries are decompressed — worth using on
 * PBIX, where `DataModel` is tens of megabytes we can never parse anyway.
 */
export function readZip(bytes: Uint8Array, only?: string[]): ZipParts {
  const wanted = only && new Set(only);
  return unzipSync(bytes, wanted ? { filter: (f) => wanted.has(f.name) } : undefined);
}

/**
 * List entry names without decompressing anything. The filter is used purely as
 * a visitor: returning false for every entry means fflate walks the central
 * directory but inflates nothing, which matters when `DataModel` is 25 MB.
 */
export function listZip(bytes: Uint8Array): string[] {
  const names: string[] = [];
  unzipSync(bytes, {
    filter: (file) => {
      names.push(file.name);
      return false;
    },
  });
  return names;
}

export function writeZip(parts: ZipParts): Uint8Array {
  return zipSync(parts, { level: 6 });
}

const BOM = 0xfeff;

/**
 * Decode a UTF-16LE part. Power BI omits the BOM on some parts and includes it
 * on others; `hadBom` is returned so a rewrite can reproduce the original
 * framing exactly rather than guessing.
 */
export function decodeUtf16(bytes: Uint8Array): { text: string; hadBom: boolean } {
  // `ignoreBOM` keeps the mark in the output so we can detect it. Without it
  // TextDecoder swallows the BOM and every rewrite would silently drop it.
  const text = new TextDecoder("utf-16le", { ignoreBOM: true }).decode(bytes);
  const hadBom = text.charCodeAt(0) === BOM;
  return { text: hadBom ? text.slice(1) : text, hadBom };
}

export function encodeUtf16(text: string, withBom: boolean): Uint8Array {
  const body = withBom ? "\ufeff" + text : text;
  const out = new Uint8Array(body.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < body.length; i++) {
    view.setUint16(i * 2, body.charCodeAt(i), true);
  }
  return out;
}

export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

export function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Content hash of the uploaded file, used as the version identity. */
export async function sha256(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
