import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { mapConsultToRunOptions } from "../../src/mcp/utils.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";

describe("mapConsultToRunOptions", () => {
  afterEach(() => {
    setOracleHomeDirOverrideForTest(null);
  });

  test("passes multi-model selections through to run options", () => {
    const env: NodeJS.ProcessEnv = {};
    env.OPENAI_API_KEY = "sk-test";
    const { runOptions } = mapConsultToRunOptions({
      prompt: "multi",
      files: [],
      model: "gpt-5.2-pro",
      models: ["gemini-3-pro"],
      userConfig: undefined,
      env,
    });
    expect(runOptions.model).toBe("gpt-5.2-pro");
    expect(runOptions.models).toEqual(["gpt-5.2-pro", "gemini-3-pro"]);
  });

  test("maps gpt-6-pro through browser consult options without triggering API slug rejection", () => {
    const { runOptions, resolvedEngine } = mapConsultToRunOptions({
      prompt: "test astra",
      files: [],
      model: "gpt-6-pro",
      engine: "browser",
    });

    expect(resolvedEngine).toBe("browser");
    expect(runOptions.model).toBe("gpt-6-pro");
  });

  test("rejects gpt-6-pro in multi-model consult coerced to API mode", () => {
    expect(() =>
      mapConsultToRunOptions({
        prompt: "test astra",
        files: [],
        engine: "browser",
        models: ["gpt-6-pro"],
      }),
    ).toThrow(/GPT-6 Pro is an API reasoning mode, not a model slug/);
  });

  test("maps browser follow-ups into run options", () => {
    const env: NodeJS.ProcessEnv = {};
    const { runOptions, resolvedEngine } = mapConsultToRunOptions({
      prompt: "review",
      files: [],
      model: "gpt-5.5-pro",
      engine: "browser",
      browserFollowUps: [" challenge previous answer ", "", "final concise decision"],
      userConfig: undefined,
      env,
    });

    expect(resolvedEngine).toBe("browser");
    expect(runOptions.browserFollowUps).toEqual([
      "challenge previous answer",
      "final concise decision",
    ]);
  });

  test("maps external ChatGPT image output paths when external output is allowed", () => {
    const env: NodeJS.ProcessEnv = { ORACLE_MCP_ALLOW_EXTERNAL_OUTPUT: "1" };
    const { runOptions, resolvedEngine } = mapConsultToRunOptions({
      prompt: "generate a product mockup",
      files: [],
      model: "gpt-5.5-pro",
      engine: "browser",
      generateImage: " /tmp/mockup.png ",
      outputPath: " /tmp/fallback.png ",
      userConfig: undefined,
      env,
    });

    expect(resolvedEngine).toBe("browser");
    expect(runOptions.generateImage).toBe(path.resolve("/tmp/mockup.png"));
    expect(runOptions.outputPath).toBe(path.resolve("/tmp/fallback.png"));
  });

  test("rejects MCP output paths outside the generated output directory by default", () => {
    const home = mkdtempSync(path.join(tmpdir(), "oracle-home-"));
    setOracleHomeDirOverrideForTest(home);
    try {
      expect(() =>
        mapConsultToRunOptions({
          prompt: "x",
          files: [],
          model: "gpt-5.5-pro",
          engine: "browser",
          generateImage: "/tmp/escape.png",
          userConfig: undefined,
          env: {},
        }),
      ).toThrow(/generated output directory/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rejects traversal escapes from the generated output directory", () => {
    const home = mkdtempSync(path.join(tmpdir(), "oracle-home-"));
    setOracleHomeDirOverrideForTest(home);
    try {
      expect(() =>
        mapConsultToRunOptions({
          prompt: "x",
          files: [],
          model: "gpt-5.5-pro",
          engine: "browser",
          generateImage: path.join(home, "generated", "..", "escape.png"),
          userConfig: undefined,
          env: {},
        }),
      ).toThrow(/generated output directory/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("allows MCP output paths under the generated output directory without opt-in", () => {
    const home = mkdtempSync(path.join(tmpdir(), "oracle-home-"));
    setOracleHomeDirOverrideForTest(home);
    try {
      const target = path.join(home, "generated", "img.png");
      const { runOptions } = mapConsultToRunOptions({
        prompt: "x",
        files: [],
        model: "gpt-5.5-pro",
        engine: "browser",
        generateImage: target,
        userConfig: undefined,
        env: {},
      });
      expect(runOptions.generateImage).toBe(path.join(realpathSync(home), "generated", "img.png"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rejects the generated output directory itself as an image path", () => {
    const home = mkdtempSync(path.join(tmpdir(), "oracle-home-"));
    setOracleHomeDirOverrideForTest(home);
    try {
      expect(() =>
        mapConsultToRunOptions({
          prompt: "x",
          files: [],
          model: "gpt-5.5-pro",
          engine: "browser",
          generateImage: path.join(home, "generated"),
          userConfig: undefined,
          env: {},
        }),
      ).toThrow(/generated output directory/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rejects writes into Oracle config and session state", () => {
    const home = mkdtempSync(path.join(tmpdir(), "oracle-home-"));
    setOracleHomeDirOverrideForTest(home);
    try {
      for (const target of [
        path.join(home, "config.json"),
        path.join(home, "sessions", "session-1", "meta.json"),
        path.join(home, "browser-profile", "Preferences"),
      ]) {
        expect(() =>
          mapConsultToRunOptions({
            prompt: "x",
            files: [],
            model: "gpt-5.5-pro",
            engine: "browser",
            generateImage: target,
            userConfig: undefined,
            env: {},
          }),
        ).toThrow(/generated output directory/);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rejects a symlinked parent that escapes the generated directory (generateImage)", () => {
    const home = mkdtempSync(path.join(tmpdir(), "oracle-home-"));
    const outside = mkdtempSync(path.join(tmpdir(), "oracle-outside-"));
    setOracleHomeDirOverrideForTest(home);
    try {
      const generated = path.join(home, "generated");
      mkdirSync(generated);
      symlinkSync(outside, path.join(generated, "escape"));
      const target = path.join(generated, "escape", "img.png");
      expect(() =>
        mapConsultToRunOptions({
          prompt: "x",
          files: [],
          model: "gpt-5.5-pro",
          engine: "browser",
          generateImage: target,
          userConfig: undefined,
          env: {},
        }),
      ).toThrow(/generated output directory/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("rejects a symlinked parent that escapes the generated directory (outputPath)", () => {
    const home = mkdtempSync(path.join(tmpdir(), "oracle-home-"));
    const outside = mkdtempSync(path.join(tmpdir(), "oracle-outside-"));
    setOracleHomeDirOverrideForTest(home);
    try {
      const generated = path.join(home, "generated");
      mkdirSync(generated);
      symlinkSync(outside, path.join(generated, "escape"));
      const target = path.join(generated, "escape", "image.png");
      expect(() =>
        mapConsultToRunOptions({
          prompt: "x",
          files: [],
          model: "gpt-5.5-pro",
          engine: "browser",
          outputPath: target,
          userConfig: undefined,
          env: {},
        }),
      ).toThrow(/generated output directory/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("rejects a broken symlink at the requested output path", () => {
    const home = mkdtempSync(path.join(tmpdir(), "oracle-home-"));
    const outside = mkdtempSync(path.join(tmpdir(), "oracle-outside-"));
    setOracleHomeDirOverrideForTest(home);
    try {
      const generated = path.join(home, "generated");
      mkdirSync(generated);
      const target = path.join(generated, "img.png");
      symlinkSync(path.join(outside, "created.png"), target);
      expect(() =>
        mapConsultToRunOptions({
          prompt: "x",
          files: [],
          model: "gpt-5.5-pro",
          engine: "browser",
          generateImage: target,
          userConfig: undefined,
          env: {},
        }),
      ).toThrow(/unresolved symlink/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("canonicalizes a symlinked parent that stays within the generated directory", () => {
    const home = mkdtempSync(path.join(tmpdir(), "oracle-home-"));
    setOracleHomeDirOverrideForTest(home);
    try {
      const generated = path.join(home, "generated");
      const realDir = path.join(generated, "real");
      mkdirSync(realDir, { recursive: true });
      symlinkSync(realDir, path.join(generated, "link"));
      const target = path.join(generated, "link", "img.png");
      const { runOptions } = mapConsultToRunOptions({
        prompt: "x",
        files: [],
        model: "gpt-5.5-pro",
        engine: "browser",
        generateImage: target,
        userConfig: undefined,
        env: {},
      });
      expect(runOptions.generateImage).toBe(path.join(realpathSync(realDir), "img.png"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("canonicalizes a non-existent Oracle home under a symlinked parent", () => {
    const container = mkdtempSync(path.join(tmpdir(), "oracle-parent-"));
    const realParent = path.join(container, "real");
    const linkedParent = path.join(container, "linked");
    mkdirSync(realParent);
    symlinkSync(realParent, linkedParent);
    const home = path.join(linkedParent, "oracle-home");
    setOracleHomeDirOverrideForTest(home);
    try {
      const target = path.join(home, "generated", "img.png");
      const { runOptions } = mapConsultToRunOptions({
        prompt: "x",
        files: [],
        model: "gpt-5.5-pro",
        engine: "browser",
        generateImage: target,
        userConfig: undefined,
        env: {},
      });
      expect(runOptions.generateImage).toBe(
        path.join(realpathSync(realParent), "oracle-home", "generated", "img.png"),
      );
    } finally {
      rmSync(container, { recursive: true, force: true });
    }
  });

  test("rejects image output when the resolved engine is API", () => {
    const home = mkdtempSync(path.join(tmpdir(), "oracle-home-"));
    setOracleHomeDirOverrideForTest(home);
    try {
      expect(() =>
        mapConsultToRunOptions({
          prompt: "x",
          files: [],
          model: "gpt-5.5",
          engine: "api",
          generateImage: path.join(home, "generated", "img.png"),
          userConfig: undefined,
          env: { OPENAI_API_KEY: "test" },
        }),
      ).toThrow(/requires engine:"browser"/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("allows a symlink escape when external output is explicitly enabled", () => {
    const home = mkdtempSync(path.join(tmpdir(), "oracle-home-"));
    const outside = mkdtempSync(path.join(tmpdir(), "oracle-outside-"));
    setOracleHomeDirOverrideForTest(home);
    try {
      symlinkSync(outside, path.join(home, "escape"));
      const target = path.join(home, "escape", "img.png");
      const { runOptions } = mapConsultToRunOptions({
        prompt: "x",
        files: [],
        model: "gpt-5.5-pro",
        engine: "browser",
        generateImage: target,
        userConfig: undefined,
        env: { ORACLE_MCP_ALLOW_EXTERNAL_OUTPUT: "1" },
      });
      expect(runOptions.generateImage).toBe(path.resolve(target));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
