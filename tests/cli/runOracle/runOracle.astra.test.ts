import { describe, expect, test, vi } from "vitest";

import { runOracle } from "@src/oracle.ts";
import { MockClient, MockStream, buildResponse } from "./helpers.ts";

function createClient(): MockClient {
  return new MockClient(new MockStream([], buildResponse()));
}

describe("runOracle GPT-6 Astra reasoning capabilities", () => {
  test.each(["low", "medium", "high", "xhigh", "max"] as const)(
    "forwards Astra reasoning effort %s",
    async (reasoningEffort) => {
      const client = createClient();

      await runOracle(
        {
          prompt: "Verify Astra reasoning effort forwarding",
          model: "gpt-6-astra",
          reasoningEffort,
          background: false,
        },
        { apiKey: "sk-test", client, log: () => {} },
      );

      expect(client.lastRequest?.model).toBe("gpt-6-astra");
      expect(client.lastRequest?.reasoning).toEqual({ effort: reasoningEffort });
    },
  );

  test("forwards Astra Pro mode with max effort through Responses", async () => {
    const client = createClient();

    await runOracle(
      {
        prompt: "Review this difficult Astra architecture",
        model: "gpt-6-astra",
        reasoningEffort: "max",
        reasoningMode: "pro",
        background: false,
      },
      { apiKey: "sk-test", client, log: () => {} },
    );

    expect(client.lastRequest?.reasoning).toEqual({ effort: "max", mode: "pro" });
  });

  test("rejects Astra none effort before client dispatch", async () => {
    const client = createClient();
    const clientFactory = vi.fn(() => client);

    await expect(
      runOracle(
        {
          prompt: "Reject unsupported Astra effort",
          model: "gpt-6-astra",
          reasoningEffort: "none",
          background: false,
        },
        { apiKey: "sk-test", clientFactory, log: () => {} },
      ),
    ).rejects.toThrow(
      'Reasoning effort "none" is not supported for gpt-6-astra. Expected low, medium, high, xhigh, or max.',
    );

    expect(clientFactory).not.toHaveBeenCalled();
    expect(client.lastRequest).toBeNull();
  });

  test("rejects Astra Pro mode on Chat Completions proxy routes", async () => {
    const client = createClient();
    const clientFactory = vi.fn(() => client);

    await expect(
      runOracle(
        {
          prompt: "Reject proxy Responses mode",
          model: "gpt-6-astra",
          reasoningMode: "pro",
          baseUrl: "https://litellm.test/v1",
          background: false,
        },
        { apiKey: "sk-test", clientFactory, log: () => {} },
      ),
    ).rejects.toThrow("requires the OpenAI or Azure OpenAI Responses API");

    expect(clientFactory).not.toHaveBeenCalled();
    expect(client.lastRequest).toBeNull();
  });

  test("retains none effort support for GPT-5.6 Sol", async () => {
    const client = createClient();

    await runOracle(
      {
        prompt: "Verify GPT-5.6 Sol none effort",
        model: "gpt-5.6-sol",
        reasoningEffort: "none",
        background: false,
      },
      { apiKey: "sk-test", client, log: () => {} },
    );

    expect(client.lastRequest?.reasoning).toEqual({ effort: "none" });
  });

  test("rejects an Astra model override with unsupported none effort", async () => {
    const client = createClient();
    const clientFactory = vi.fn(() => client);

    await expect(
      runOracle(
        {
          prompt: "Reject unsupported Astra configured effort",
          model: "gpt-6-astra",
          modelOverrides: { "gpt-6-astra": { reasoning: { effort: "none" } } },
          background: false,
        },
        { apiKey: "sk-test", clientFactory, log: () => {} },
      ),
    ).rejects.toThrow(
      'Reasoning effort "none" is not supported for gpt-6-astra. Expected low, medium, high, xhigh, or max.',
    );

    expect(clientFactory).not.toHaveBeenCalled();
  });

  test("allows an explicit Astra effort to override an unsupported configured default", async () => {
    const client = createClient();

    await runOracle(
      {
        prompt: "Use an explicit supported Astra effort",
        model: "gpt-6-astra",
        reasoningEffort: "low",
        modelOverrides: { "gpt-6-astra": { reasoning: { effort: "none" } } },
        background: false,
      },
      { apiKey: "sk-test", client, log: () => {} },
    );

    expect(client.lastRequest?.reasoning).toEqual({ effort: "low" });
  });
});
