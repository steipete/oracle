import { describe, expect, test } from "vitest";
import { __test__, createStoredZip } from "../../src/browser/zipBundle.js";

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_DOS_DATE_1980_01_01 = 0x0021;

interface ParsedZipEntry {
  name: string;
  content: Buffer;
  crc32: number;
  localDate: number;
  centralDate: number;
}

function findEndOfCentralDirectory(zip: Buffer): number {
  for (let offset = zip.length - 22; offset >= 0; offset -= 1) {
    if (zip.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) {
      return offset;
    }
  }
  throw new Error("End of central directory not found.");
}

function readStoredZip(zip: Buffer): ParsedZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(zip);
  const entryCount = zip.readUInt16LE(eocdOffset + 10);
  const centralOffset = zip.readUInt32LE(eocdOffset + 16);
  const entries: ParsedZipEntry[] = [];
  let centralCursor = centralOffset;

  for (let index = 0; index < entryCount; index += 1) {
    expect(zip.readUInt32LE(centralCursor)).toBe(CENTRAL_DIRECTORY_HEADER);
    const method = zip.readUInt16LE(centralCursor + 10);
    const centralDate = zip.readUInt16LE(centralCursor + 14);
    const crc32 = zip.readUInt32LE(centralCursor + 16);
    const compressedSize = zip.readUInt32LE(centralCursor + 20);
    const uncompressedSize = zip.readUInt32LE(centralCursor + 24);
    const nameLength = zip.readUInt16LE(centralCursor + 28);
    const extraLength = zip.readUInt16LE(centralCursor + 30);
    const commentLength = zip.readUInt16LE(centralCursor + 32);
    const localOffset = zip.readUInt32LE(centralCursor + 42);
    const nameStart = centralCursor + 46;
    const name = zip.subarray(nameStart, nameStart + nameLength).toString("utf8");

    expect(method).toBe(0);
    expect(compressedSize).toBe(uncompressedSize);
    expect(zip.readUInt32LE(localOffset)).toBe(LOCAL_FILE_HEADER);
    expect(zip.readUInt16LE(localOffset + 8)).toBe(0);
    const localDate = zip.readUInt16LE(localOffset + 12);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    expect(
      zip.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8"),
    ).toBe(name);
    const contentStart = localOffset + 30 + localNameLength + localExtraLength;
    const content = zip.subarray(contentStart, contentStart + uncompressedSize);
    expect(__test__.crc32(content)).toBe(crc32);
    entries.push({ name, content, crc32, localDate, centralDate });

    centralCursor = nameStart + nameLength + extraLength + commentLength;
  }

  expect(centralCursor).toBe(eocdOffset);
  return entries;
}

describe("createStoredZip", () => {
  test("creates a readable stored ZIP with text and binary entries", () => {
    const zip = createStoredZip([
      { path: "src/a.ts", content: "alpha" },
      { path: "assets/logo.bin", content: Buffer.from([0, 1, 2, 255]) },
    ]);

    const entries = readStoredZip(zip);
    expect(entries.map((entry) => entry.name)).toEqual(["src/a.ts", "assets/logo.bin"]);
    expect(entries[0]?.content.toString("utf8")).toBe("alpha");
    expect(Array.from(entries[1]?.content ?? [])).toEqual([0, 1, 2, 255]);
    entries.forEach((entry) => {
      expect(entry.localDate).toBe(ZIP_DOS_DATE_1980_01_01);
      expect(entry.centralDate).toBe(ZIP_DOS_DATE_1980_01_01);
    });
  });

  test("normalizes unsafe paths and preserves unique names", () => {
    const zip = createStoredZip([
      { path: "../secret.txt", content: "secret" },
      { path: "/abs/file.txt", content: "absolute" },
      { path: "C:\\repo\\same.txt", content: "windows" },
      { path: "C:/repo/same.txt", content: "duplicate" },
    ]);

    expect(readStoredZip(zip).map((entry) => entry.name)).toEqual([
      "secret.txt",
      "abs/file.txt",
      "repo/same.txt",
      "repo/same-2.txt",
    ]);
  });

  test("rejects ZIP32 entry count overflow", () => {
    const entries = Array.from({ length: 0x10000 }, (_, index) => ({
      path: `file-${index}.txt`,
      content: "",
    }));

    expect(() => createStoredZip(entries)).toThrow(/too many files/i);
  });

  test("rejects file names that cannot fit in ZIP16 headers", () => {
    const tooLongName = `${"a".repeat(0x10000)}.txt`;

    expect(() => createStoredZip([{ path: tooLongName, content: "" }])).toThrow(
      /file name exceeds ZIP16/i,
    );
  });
});
