import { describe, expect, it } from "vitest";
import { deriveTurnChromeState, isLastAssistantOfTurn } from "./turn-state";
import type { ChatMessage } from "./types";

const u = (text = ""): ChatMessage => ({ role: "user", text });
const a = (text = ""): ChatMessage => ({ role: "assistant", text });

describe("isLastAssistantOfTurn", () => {
  it("returns true for the only assistant of the round", () => {
    expect(isLastAssistantOfTurn([u(), a()], 1)).toBe(true);
  });

  it("returns true for the last assistant before next user", () => {
    expect(isLastAssistantOfTurn([u(), a(), a(), u()], 2)).toBe(true);
  });

  it("returns false for an earlier assistant in the same round", () => {
    expect(isLastAssistantOfTurn([u(), a(), a()], 1)).toBe(false);
  });

  it("returns false when the index is not assistant", () => {
    expect(isLastAssistantOfTurn([u(), a()], 0)).toBe(false);
  });
});

describe("deriveTurnChromeState", () => {
  const messages: ChatMessage[] = [u(), a("first"), a("second")];

  it("returns live when assistant is active and streaming", () => {
    expect(
      deriveTurnChromeState({
        messages,
        index: 2,
        streaming: true,
        isActiveAssistant: true,
      })
    ).toBe("live");
  });

  it("returns compact when streaming continues but turn is closed", () => {
    expect(
      deriveTurnChromeState({
        messages,
        index: 1,
        streaming: true,
        isActiveAssistant: false,
      })
    ).toBe("compact");
    // last assistant during streaming also stays compact (still rolling)
    expect(
      deriveTurnChromeState({
        messages,
        index: 2,
        streaming: true,
        isActiveAssistant: false,
      })
    ).toBe("compact");
  });

  it("returns compact for non-final assistants when streaming has ended", () => {
    expect(
      deriveTurnChromeState({
        messages,
        index: 1,
        streaming: false,
        isActiveAssistant: false,
      })
    ).toBe("compact");
  });

  it("returns final for the last assistant after streaming ended", () => {
    expect(
      deriveTurnChromeState({
        messages,
        index: 2,
        streaming: false,
        isActiveAssistant: false,
      })
    ).toBe("final");
  });
});
