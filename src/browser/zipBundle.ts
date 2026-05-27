const ZIP_UTF8_FLAG = 0x0800;
const ZIP_STORE_METHOD = 0;
const ZIP_VERSION_NEEDED = 20;
const ZIP_DOS_TIME = 0x0000;
const ZIP_DOS_DATE = 0x0021;

export interface ZipBundleEntry {
  path: string;
  content: string | Buffer;
}

interface PreparedZipEntry {
  name: Buffer;
  content: Buffer;
  crc32: number;
  localHeaderOffset: number;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function normalizeZipPath(inputPath: string, fallback: string): string {
  const normalized = inputPath
    .replace(/\\/g, "/")
    .replace(/^[a-zA-Z]:\//, "")
    .replace(/^\/+/, "")
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
  return normalized || fallback;
}

function uniqueZipPath(inputPath: string, index: number, seen: Set<string>): string {
  const normalized = normalizeZipPath(inputPath, `file-${index + 1}.txt`);
  const extIndex = normalized.lastIndexOf(".");
  const base = extIndex > 0 ? normalized.slice(0, extIndex) : normalized;
  const ext = extIndex > 0 ? normalized.slice(extIndex) : "";
  let candidate = normalized;
  let suffix = 2;
  while (seen.has(candidate)) {
    candidate = `${base}-${suffix}${ext}`;
    suffix += 1;
  }
  seen.add(candidate);
  return candidate;
}

function assertZip32(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`${label} exceeds ZIP32 limits.`);
  }
}

function assertZip16(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`${label} exceeds ZIP16 limits.`);
  }
}

function localFileHeader(entry: PreparedZipEntry): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(ZIP_VERSION_NEEDED, 4);
  header.writeUInt16LE(ZIP_UTF8_FLAG, 6);
  header.writeUInt16LE(ZIP_STORE_METHOD, 8);
  header.writeUInt16LE(ZIP_DOS_TIME, 10);
  header.writeUInt16LE(ZIP_DOS_DATE, 12);
  header.writeUInt32LE(entry.crc32, 14);
  header.writeUInt32LE(entry.content.length, 18);
  header.writeUInt32LE(entry.content.length, 22);
  header.writeUInt16LE(entry.name.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function centralDirectoryHeader(entry: PreparedZipEntry): Buffer {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(ZIP_VERSION_NEEDED, 4);
  header.writeUInt16LE(ZIP_VERSION_NEEDED, 6);
  header.writeUInt16LE(ZIP_UTF8_FLAG, 8);
  header.writeUInt16LE(ZIP_STORE_METHOD, 10);
  header.writeUInt16LE(ZIP_DOS_TIME, 12);
  header.writeUInt16LE(ZIP_DOS_DATE, 14);
  header.writeUInt32LE(entry.crc32, 16);
  header.writeUInt32LE(entry.content.length, 20);
  header.writeUInt32LE(entry.content.length, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(entry.localHeaderOffset, 42);
  return header;
}

function endOfCentralDirectory(
  entryCount: number,
  centralSize: number,
  centralOffset: number,
): Buffer {
  const footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50, 0);
  footer.writeUInt16LE(0, 4);
  footer.writeUInt16LE(0, 6);
  footer.writeUInt16LE(entryCount, 8);
  footer.writeUInt16LE(entryCount, 10);
  footer.writeUInt32LE(centralSize, 12);
  footer.writeUInt32LE(centralOffset, 16);
  footer.writeUInt16LE(0, 20);
  return footer;
}

export function createStoredZip(entries: ZipBundleEntry[]): Buffer {
  if (entries.length > 0xffff) {
    throw new Error("Too many files for a ZIP32 browser bundle.");
  }
  assertZip16(entries.length, "ZIP entry count");
  const seen = new Set<string>();
  const prepared: PreparedZipEntry[] = [];
  const localParts: Buffer[] = [];
  let offset = 0;

  entries.forEach((entry, index) => {
    const name = Buffer.from(uniqueZipPath(entry.path, index, seen), "utf8");
    const content = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content, "utf8");
    assertZip16(name.length, "ZIP file name");
    assertZip32(content.length, "ZIP entry size");
    assertZip32(offset, "ZIP local header offset");
    const preparedEntry: PreparedZipEntry = {
      name,
      content,
      crc32: crc32(content),
      localHeaderOffset: offset,
    };
    prepared.push(preparedEntry);
    const header = localFileHeader(preparedEntry);
    localParts.push(header, name, content);
    offset += header.length + name.length + content.length;
    assertZip32(offset, "ZIP local data size");
  });

  const centralOffset = offset;
  const centralParts: Buffer[] = [];
  for (const entry of prepared) {
    const header = centralDirectoryHeader(entry);
    centralParts.push(header, entry.name);
    offset += header.length + entry.name.length;
    assertZip32(offset, "ZIP central directory size");
  }
  const centralSize = offset - centralOffset;
  assertZip32(centralOffset, "ZIP central directory offset");
  assertZip32(centralSize, "ZIP central directory size");
  const footer = endOfCentralDirectory(prepared.length, centralSize, centralOffset);
  return Buffer.concat([...localParts, ...centralParts, footer]);
}

export const __test__ = {
  crc32,
  normalizeZipPath,
};
