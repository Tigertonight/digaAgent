import { describe, expect, it } from "vitest";
import {
  curateProviderModels,
  getCuratedModelLabel,
} from "./default-model";

describe("default model curation", () => {
  it("promotes DeepSeek when the registry exposes the curated model", () => {
    const providers = [
      {
        provider: "deepseek",
        hasAuth: true,
        models: [
          { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
          { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
        ],
      },
    ];

    expect(curateProviderModels(providers)).toEqual([
      {
        provider: "deepseek",
        hasAuth: true,
        models: [{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" }],
      },
    ]);
    expect(getCuratedModelLabel("deepseek", "deepseek-v4-pro")).toBe(
      "DeepSeek V4 Pro"
    );
  });

  it("does not advertise DeepSeek if the expected model id is absent", () => {
    const providers = [
      {
        provider: "deepseek",
        hasAuth: true,
        models: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }],
      },
    ];

    expect(curateProviderModels(providers)).toEqual([]);
  });
});
