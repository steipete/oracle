import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";

import {
  createToonPromptPassthrough,
  detectToonPromptBlocks,
  hashPromptBytes,
  hasToonPromptBlocks,
  passthroughToProviderPrompt,
  summarizeContextSerializationPolicy,
  type ContextSerializationPolicyLike,
} from "../../src/oracle/toon_passthrough.ts";

class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (Math.imul(this.state, 1_664_525) + 1_013_904_223) >>> 0;
    return this.state;
  }

  int(maxExclusive: number): number {
    return this.next() % maxExclusive;
  }

  pick<T>(values: readonly T[]): T {
    return values[this.int(values.length)] as T;
  }

  bool(): boolean {
    return (this.next() & 1) === 1;
  }
}

const PROMPT_CHARS = [
  "a",
  "Z",
  "0",
  " ",
  "\t",
  "\n",
  "\r",
  "<",
  ">",
  "/",
  "`",
  "~",
  "_",
  "-",
  ":",
  "{",
  "}",
  "[",
  "]",
  "\0",
  "\uD83D",
  "\uDE00",
] as const;

const TOON_MARKERS = [
  { kind: "markdown_fence", text: "```toon\nrows[1]{id}: 1\n```" },
  { kind: "markdown_fence", text: "   ~~~ toon meta\nitems[2]{id,name}:\n  1,Ada\n~~~" },
  { kind: "xml_tag", text: "<toon>" },
  { kind: "xml_tag", text: "<TOON kind=\"packet\"/>" },
  { kind: "legacy_marker", text: "TOON_BLOCK" },
] as const;

const POLICY_STRINGS = [
  "",
  "json",
  "toon",
  "auto",
  "gated_optional",
  "enabled_optional",
  "disabled",
  "tru",
  "https://github.com/Dicklesworthstone/toon_rust",
] as const;

function sha256(input: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(input, "utf8").digest("hex")}`;
}

function randomPrompt(rng: Rng, maxLength: number): string {
  const length = rng.int(maxLength + 1);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += rng.pick(PROMPT_CHARS);
  }
  return out;
}

function promptWithRandomMarkers(
  rng: Rng,
  maxBaseLength: number,
): { prompt: string; expectedKinds: readonly string[] } {
  const chunks = [randomPrompt(rng, maxBaseLength)];
  const expectedKinds: string[] = [];
  const markerCount = 1 + rng.int(4);
  for (let i = 0; i < markerCount; i += 1) {
    const marker = rng.pick(TOON_MARKERS);
    chunks.push(
      "\n",
      marker.text,
      "\n",
      randomPrompt(rng, Math.max(4, Math.trunc(maxBaseLength / 4))),
    );
    expectedKinds.push(marker.kind);
  }
  return { prompt: chunks.join(""), expectedKinds };
}

function randomUnknown(rng: Rng, depth = 0): unknown {
  switch (rng.int(depth > 1 ? 5 : 7)) {
    case 0:
      return rng.pick(POLICY_STRINGS);
    case 1:
      return rng.bool();
    case 2:
      return rng.int(10) - 5;
    case 3:
      return null;
    case 4:
      return undefined;
    case 5:
      return [rng.pick(POLICY_STRINGS), rng.int(5), rng.bool(), "toon"];
    default:
      return { nested: randomUnknown(rng, depth + 1) };
  }
}

function randomPolicy(rng: Rng): ContextSerializationPolicyLike {
  const toonRust =
    rng.int(4) === 0
      ? randomUnknown(rng)
      : {
          enabled: randomUnknown(rng),
          required: randomUnknown(rng),
          cli_candidates: randomUnknown(rng),
          prefer_cli: randomUnknown(rng),
          strict_decode: randomUnknown(rng),
          source_repo: randomUnknown(rng),
          enabled_by_default: randomUnknown(rng),
          license_review_required: randomUnknown(rng),
        };

  return {
    canonical_storage_format: randomUnknown(rng),
    fallback_format: randomUnknown(rng),
    default_effective_format: randomUnknown(rng),
    policy_status: randomUnknown(rng),
    prompt_context_preference: randomUnknown(rng),
    legal_review_required: randomUnknown(rng),
    toon_rust: toonRust,
  };
}

describe("TOON passthrough fuzz harness", () => {
  test("arbitrary prompt strings pass through unchanged with exact byte hashes", () => {
    const rng = new Rng(0x70_00_0001);
    for (let i = 0; i < 500; i += 1) {
      const prompt = rng.bool()
        ? randomPrompt(rng, 180)
        : promptWithRandomMarkers(rng, 140).prompt;
      const result = createToonPromptPassthrough(prompt);

      expect(result.providerPrompt).toBe(prompt);
      expect(passthroughToProviderPrompt(prompt)).toBe(prompt);
      expect(result.prompt_payload_format).toBe("text");
      expect(result.prompt_semantics).toBe("unchanged");
      expect(result.prompt_bytes).toBe(Buffer.byteLength(prompt, "utf8"));
      expect(result.prompt_sha256).toBe(sha256(prompt));
      expect(hashPromptBytes(prompt)).toBe(sha256(prompt));
      expect(result.has_toon_prompt_blocks).toBe(result.toon_block_markers.length > 0);
      expect(hasToonPromptBlocks(prompt)).toBe(result.has_toon_prompt_blocks);
    }
  });

  test("detected marker offsets are sorted and slice back to the original prompt", () => {
    const rng = new Rng(0x70_00_0002);
    for (let i = 0; i < 300; i += 1) {
      const prompt = promptWithRandomMarkers(rng, 120).prompt;
      const markers = detectToonPromptBlocks(prompt);

      expect(markers.length).toBeGreaterThan(0);
      for (let index = 0; index < markers.length; index += 1) {
        const marker = markers[index]!;
        expect(marker.start).toBeGreaterThanOrEqual(0);
        expect(marker.end).toBeGreaterThan(marker.start);
        expect(marker.end).toBeLessThanOrEqual(prompt.length);
        expect(prompt.slice(marker.start, marker.end)).toBe(marker.marker);
        if (index > 0) {
          const previous = markers[index - 1]!;
          expect(marker.start).toBeGreaterThanOrEqual(previous.start);
        }
      }
    }
  });

  test("seeded marker forms are discoverable without validating TOON internals", () => {
    const rng = new Rng(0x70_00_0003);
    for (let i = 0; i < 150; i += 1) {
      const { prompt, expectedKinds } = promptWithRandomMarkers(rng, 80);
      const actualKinds = detectToonPromptBlocks(prompt).map((marker) => marker.kind);

      for (const kind of expectedKinds) {
        expect(actualKinds).toContain(kind);
      }
      expect(createToonPromptPassthrough(prompt).providerPrompt).toBe(prompt);
    }
  });

  test("random policy metadata is normalized without requiring toon_rust", () => {
    const rng = new Rng(0x70_00_0004);
    for (let i = 0; i < 400; i += 1) {
      const policy = randomPolicy(rng);
      const metadata = summarizeContextSerializationPolicy(policy);
      const result = createToonPromptPassthrough("```toon\nnot decoded\n```", {
        contextSerializationPolicy: policy,
      });

      expect(typeof metadata.canonical_storage_format).toBe("string");
      expect(typeof metadata.fallback_format).toBe("string");
      expect(typeof metadata.default_effective_format).toBe("string");
      expect(typeof metadata.policy_status).toBe("string");
      expect(typeof metadata.prompt_context_preference).toBe("string");
      expect(typeof metadata.legal_review_required).toBe("boolean");
      expect(typeof metadata.toon_rust_enabled).toBe("boolean");
      expect(typeof metadata.toon_rust_enabled_by_default).toBe("boolean");
      expect(typeof metadata.toon_rust_required).toBe("boolean");
      expect(typeof metadata.toon_rust_strict_decode).toBe("boolean");
      expect(typeof metadata.toon_rust_license_review_required).toBe("boolean");
      expect(metadata.toon_rust_cli_candidates.every((entry) => typeof entry === "string")).toBe(
        true,
      );
      expect(
        metadata.toon_rust_prefer_cli === null ||
          typeof metadata.toon_rust_prefer_cli === "string",
      ).toBe(true);
      expect(
        metadata.toon_rust_source_repo === null ||
          typeof metadata.toon_rust_source_repo === "string",
      ).toBe(true);
      expect(result.capabilities.requires_toon_rust).toBe(false);
      expect(result.capabilities.invokes_toon_rust).toBe(false);
      expect(new Set(result.warnings.map((warning) => warning.code)).size).toBe(
        result.warnings.length,
      );
      expect(result.warnings.length).toBeLessThanOrEqual(2);
    }
  });
});
