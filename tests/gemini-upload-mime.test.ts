import { describe, it, expect } from "vitest";
import { resolveGeminiUploadMimeType } from "../src/gemini-web/client.js";

describe("resolveGeminiUploadMimeType", () => {
  it("types the video formats Gemini can actually read", () => {
    // Untyped uploads are silently discarded: the run reports the file as attached
    // while the model answers as though nothing was sent.
    expect(resolveGeminiUploadMimeType("/tmp/clip.mp4")).toBe("video/mp4");
    expect(resolveGeminiUploadMimeType("/tmp/clip.mov")).toBe("video/quicktime");
    expect(resolveGeminiUploadMimeType("/tmp/clip.webm")).toBe("video/webm");
  });

  it("keeps existing image and document types unchanged", () => {
    expect(resolveGeminiUploadMimeType("/tmp/shot.png")).toBe("image/png");
    expect(resolveGeminiUploadMimeType("/tmp/shot.jpg")).toBe("image/jpeg");
    expect(resolveGeminiUploadMimeType("/tmp/shot.webp")).toBe("image/webp");
    expect(resolveGeminiUploadMimeType("/tmp/doc.pdf")).toBe("application/pdf");
  });

  it("is case insensitive", () => {
    expect(resolveGeminiUploadMimeType("/tmp/CLIP.MP4")).toBe("video/mp4");
    expect(resolveGeminiUploadMimeType("/tmp/SHOT.PNG")).toBe("image/png");
  });

  it("leaves formats the endpoint rejects on the octet-stream fallback", () => {
    // Audio and plain text are never delivered by this endpoint whatever type is
    // declared, and .m4v/.mkv/.3gp are dropped or error out, so mapping them would
    // only advertise support that does not exist.
    for (const p of [
      "/tmp/a.wav",
      "/tmp/a.mp3",
      "/tmp/a.m4a",
      "/tmp/n.txt",
      "/tmp/c.m4v",
      "/tmp/c.mkv",
    ]) {
      expect(resolveGeminiUploadMimeType(p)).toBe("application/octet-stream");
    }
  });

  it("falls back to octet-stream for unknown extensions", () => {
    expect(resolveGeminiUploadMimeType("/tmp/archive.xyz")).toBe("application/octet-stream");
    expect(resolveGeminiUploadMimeType("/tmp/noext")).toBe("application/octet-stream");
  });
});
