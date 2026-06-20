import { describe, expect, it } from "vitest";
import {
  BUILT_IN_PROFILES,
  DEFAULT_PROFILE_ID,
  canonicalProfileId,
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
    // Hard constraint: default must stay coding.
    expect(def!.defaults.communication).toBe("coding");
  });

  it("only exposes the two canonical built-in profiles", () => {
    expect(BUILT_IN_PROFILES.map((p) => p.id)).toEqual(["daily", "coding"]);
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

  it("keeps legacy profile ids as aliases to the two canonical ids", () => {
    expect(canonicalProfileId("quick-chat")).toBe("daily");
    expect(canonicalProfileId("daily-research")).toBe("daily");
    expect(canonicalProfileId("workflow-planner")).toBe("daily");
    expect(canonicalProfileId("code-review")).toBe("coding");
    expect(canonicalProfileId("code-edit")).toBe("coding");
    expect(canonicalProfileId("yolo-refactor")).toBe("coding");
    expect(getBuiltInProfile("code-review")?.id).toBe("coding");
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
    expect(profileWorkMode(getBuiltInProfile("daily")!)).toBe("daily");
    expect(profileWorkMode(getBuiltInProfile("coding")!)).toBe("coding");
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
      normalizeAgentProfilesSettings({ defaultProfileId: "daily" })
        .defaultProfileId
    ).toBe("daily");
  });

  it("migrates legacy built-in default ids to canonical ids", () => {
    expect(
      normalizeAgentProfilesSettings({ defaultProfileId: "daily-research" })
        .defaultProfileId
    ).toBe("daily");
    expect(
      normalizeAgentProfilesSettings({ defaultProfileId: "code-edit" })
        .defaultProfileId
    ).toBe("coding");
  });

  it("drops malformed custom profiles", () => {
    const settings = normalizeAgentProfilesSettings({
      defaultProfileId: "coding",
      customProfiles: [
        { id: "bad" } as unknown as AgentProfile, // missing label/defaults
        {
          id: "mine",
          label: "Mine",
          description: "",
          risk: "low",
          builtIn: false,
          defaults: getBuiltInProfile("coding")!.defaults,
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
      defaults: getBuiltInProfile("daily")!.defaults,
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
    expect(resolveProfile("coding").id).toBe("coding");
  });

  it("resolves legacy built-in ids to canonical profiles", () => {
    expect(resolveProfile("code-edit").id).toBe("coding");
    expect(resolveProfile("daily-research").id).toBe("daily");
  });

  it("resolves custom by id from settings", () => {
    const custom: AgentProfile = {
      id: "mine",
      label: "Mine",
      description: "",
      risk: "low",
      builtIn: false,
      defaults: getBuiltInProfile("daily")!.defaults,
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
    const profile = getBuiltInProfile("coding")!;
    const snap = profileAxesSnapshot(profile);
    snap.toolsets.push("chat");
    expect(profile.defaults.toolsets).not.toContain("chat");
  });
});
