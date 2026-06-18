import { describe, expect, it } from "vitest";
import {
  BUILT_IN_PROFILES,
  DEFAULT_PROFILE_ID,
  communicationToWorkMode,
  getBuiltInProfile,
  normalizeAgentProfilesSettings,
  profileAxesSnapshot,
  profileWorkMode,
  resolveProfile,
  workModeToCommunication,
} from "./index";
import type { AgentProfile } from "./types";

describe("built-in profiles", () => {
  it("default profile keeps the current coding communication (no silent behavior change)", () => {
    const def = getBuiltInProfile(DEFAULT_PROFILE_ID);
    expect(def).toBeDefined();
    // §5.1 hard constraint: default must stay coding + read-only.
    expect(def!.defaults.communication).toBe("coding");
    expect(def!.defaults.sandbox).toBe("read-only");
  });

  it("all built-ins have unique ids and a complete axes set", () => {
    const ids = BUILT_IN_PROFILES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of BUILT_IN_PROFILES) {
      expect(p.builtIn).toBe(true);
      expect(p.defaults.communication).toMatch(/^(daily|coding)$/);
      expect(p.defaults.toolsets.length).toBeGreaterThan(0);
    }
  });

  it("only yolo-refactor is high risk + auto-approval", () => {
    const yolo = getBuiltInProfile("yolo-refactor")!;
    expect(yolo.risk).toBe("high");
    expect(yolo.defaults.approval).toBe("never");
    const others = BUILT_IN_PROFILES.filter((p) => p.id !== "yolo-refactor");
    expect(others.every((p) => p.defaults.approval !== "never")).toBe(true);
  });
});

describe("communication <-> WorkMode mapping (no double source)", () => {
  it("round-trips both directions", () => {
    expect(communicationToWorkMode("daily")).toBe("daily");
    expect(communicationToWorkMode("coding")).toBe("coding");
    expect(workModeToCommunication("daily")).toBe("daily");
    expect(workModeToCommunication("coding")).toBe("coding");
  });

  it("profileWorkMode derives WorkMode from the profile axis", () => {
    expect(profileWorkMode(getBuiltInProfile("daily-research")!)).toBe("daily");
    expect(profileWorkMode(getBuiltInProfile("code-edit")!)).toBe("coding");
  });
});

describe("normalizeAgentProfilesSettings", () => {
  it("falls back to the built-in default when missing or unknown", () => {
    expect(normalizeAgentProfilesSettings(undefined).defaultProfileId).toBe(
      DEFAULT_PROFILE_ID
    );
    expect(
      normalizeAgentProfilesSettings({ defaultProfileId: "does-not-exist" })
        .defaultProfileId
    ).toBe(DEFAULT_PROFILE_ID);
  });

  it("keeps a valid built-in default id", () => {
    expect(
      normalizeAgentProfilesSettings({ defaultProfileId: "code-edit" })
        .defaultProfileId
    ).toBe("code-edit");
  });

  it("drops malformed custom profiles", () => {
    const settings = normalizeAgentProfilesSettings({
      defaultProfileId: "code-review",
      customProfiles: [
        { id: "bad" } as unknown as AgentProfile, // missing label/defaults
        {
          id: "mine",
          label: "Mine",
          description: "",
          risk: "low",
          builtIn: false,
          defaults: getBuiltInProfile("code-review")!.defaults,
        },
      ],
    });
    expect(settings.customProfiles.map((p) => p.id)).toEqual(["mine"]);
  });

  it("allows a custom profile id as default", () => {
    const custom: AgentProfile = {
      id: "mine",
      label: "Mine",
      description: "",
      risk: "low",
      builtIn: false,
      defaults: getBuiltInProfile("daily-research")!.defaults,
    };
    const settings = normalizeAgentProfilesSettings({
      defaultProfileId: "mine",
      customProfiles: [custom],
    });
    expect(settings.defaultProfileId).toBe("mine");
  });
});

describe("resolveProfile", () => {
  it("resolves built-in by id", () => {
    expect(resolveProfile("code-edit").id).toBe("code-edit");
  });

  it("resolves custom by id from settings", () => {
    const custom: AgentProfile = {
      id: "mine",
      label: "Mine",
      description: "",
      risk: "low",
      builtIn: false,
      defaults: getBuiltInProfile("daily-research")!.defaults,
    };
    const settings = normalizeAgentProfilesSettings({
      defaultProfileId: DEFAULT_PROFILE_ID,
      customProfiles: [custom],
    });
    expect(resolveProfile("mine", settings).id).toBe("mine");
  });

  it("falls back to the default profile for unknown/undefined id", () => {
    expect(resolveProfile(undefined).id).toBe(DEFAULT_PROFILE_ID);
    expect(resolveProfile("nope").id).toBe(DEFAULT_PROFILE_ID);
  });
});

describe("profileAxesSnapshot", () => {
  it("returns a deep-ish copy whose toolsets do not alias the source", () => {
    const profile = getBuiltInProfile("code-edit")!;
    const snap = profileAxesSnapshot(profile);
    snap.toolsets.push("browser");
    expect(profile.defaults.toolsets).not.toContain("browser");
  });
});
