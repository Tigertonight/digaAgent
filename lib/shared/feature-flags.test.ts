import { afterEach, describe, expect, it } from "vitest";
import { FEATURE_FLAGS } from "./feature-flags";

const KEY = "DIGA_AGENT_ENABLE_AGENT_TEAM";

describe("FEATURE_FLAGS.agentTeamEnabled", () => {
  const original = process.env[KEY];
  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  it("defaults to true when unset", () => {
    delete process.env[KEY];
    expect(FEATURE_FLAGS.agentTeamEnabled()).toBe(true);
  });

  it("treats empty string as default (true)", () => {
    process.env[KEY] = "";
    expect(FEATURE_FLAGS.agentTeamEnabled()).toBe(true);
  });

  it.each(["0", "false", "off", "FALSE", " Off "])(
    "disables for falsy value %j",
    (value) => {
      process.env[KEY] = value;
      expect(FEATURE_FLAGS.agentTeamEnabled()).toBe(false);
    }
  );

  it.each(["1", "true", "on", "TRUE"])(
    "enables for truthy value %j",
    (value) => {
      process.env[KEY] = value;
      expect(FEATURE_FLAGS.agentTeamEnabled()).toBe(true);
    }
  );

  it("falls back to default for unrecognized value", () => {
    process.env[KEY] = "maybe";
    expect(FEATURE_FLAGS.agentTeamEnabled()).toBe(true);
  });
});
