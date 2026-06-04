import { describe, expect, it } from "vitest";
import {
  extractFirstUrl,
  extractSearchQuery,
  parseBrowserIntent,
} from "./intent";

describe("browser intent router", () => {
  it("extracts the first http url", () => {
    expect(
      extractFirstUrl("请打开 https://example.com/path?q=1，然后看一下")
    ).toBe("https://example.com/path?q=1");
  });

  it("extracts quoted Chinese search queries", () => {
    expect(extractSearchQuery("请用浏览器搜索“迪迦奥特曼”")).toBe(
      "迪迦奥特曼"
    );
  });

  it("routes local browser verification to ui_verify", () => {
    expect(
      parseBrowserIntent(
        "浏览器验收：打开 http://localhost:3000，确认是否看到 Diga Agent"
      )
    ).toMatchObject({
      kind: "ui_verify",
      url: "http://localhost:3000",
      verifyText: "Diga Agent",
    });
  });

  it("routes search tasks with engine inference", () => {
    expect(parseBrowserIntent("请用 google search 迪迦奥特曼")).toMatchObject({
      kind: "search",
      query: "迪迦奥特曼",
      engine: "google",
    });
  });

  it("routes first search result copy requests", () => {
    expect(
      parseBrowserIntent(
        "请用浏览器搜索“Diga Agent”，把第一条结果链接复制到剪切板"
      )
    ).toMatchObject({
      kind: "search",
      query: "Diga Agent",
      resultIndex: 0,
      copyResult: true,
    });
  });

  it("routes first link copy requests on an opened page", () => {
    expect(
      parseBrowserIntent(
        "打开 http://localhost:3000/browser-task-fixture.html 并复制第一条链接"
      )
    ).toMatchObject({
      kind: "open_url",
      url: "http://localhost:3000/browser-task-fixture.html",
      resultIndex: 0,
      copyResult: true,
    });
  });

  it("routes click-text navigation on an opened page", () => {
    expect(
      parseBrowserIntent(
        "打开 http://localhost:3000/browser-task-fixture.html，然后点击“Fixture Button”"
      )
    ).toMatchObject({
      kind: "navigate",
      url: "http://localhost:3000/browser-task-fixture.html",
      clickText: "Fixture Button",
    });
  });

  it("routes fill and enter navigation on an opened page", () => {
    expect(
      parseBrowserIntent(
        "打开 http://localhost:3000/browser-task-fixture.html，在输入框输入“hello runtime”并按 Enter"
      )
    ).toMatchObject({
      kind: "navigate",
      url: "http://localhost:3000/browser-task-fixture.html",
      fillText: "hello runtime",
      pressEnter: true,
    });
  });

  it("does not hijack ordinary coding prompts", () => {
    expect(parseBrowserIntent("帮我重构 useChatStream 的状态管理")).toEqual({
      kind: "none",
    });
  });
});
