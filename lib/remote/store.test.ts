import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  completePairing,
  createPairingPayload,
  getRemoteAccessSettings,
  listRemoteDevices,
  revokeRemoteDevice,
  updateRemoteAccessSettings,
  verifyRemoteToken,
} from "./store";

let tmpDir = "";

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "diga-agent-remote-test-"));
  process.env.DIGA_AGENT_SETTINGS_FILE = path.join(tmpDir, "settings.json");
});

afterEach(async () => {
  delete process.env.DIGA_AGENT_SETTINGS_FILE;
  await rm(tmpDir, { recursive: true, force: true });
});

describe("remote access store", () => {
  it("creates stable defaults and persists mode changes", async () => {
    const first = await getRemoteAccessSettings();
    expect(first.mode).toBe("off");
    expect(first.port).toBe(37373);
    expect(first.instanceId).toMatch(/^pi-/);

    await updateRemoteAccessSettings({ mode: "lan", port: 45678 });
    const next = await getRemoteAccessSettings();
    expect(next.mode).toBe("lan");
    expect(next.port).toBe(45678);
    expect(next.instanceId).toBe(first.instanceId);
  });

  it("exchanges a one-time pairing code for a verifiable device token", async () => {
    await updateRemoteAccessSettings({ mode: "lan", port: 45678 });
    const pair = await createPairingPayload("test");
    expect(pair.payload.code).toBeTruthy();
    expect(pair.payload.candidates.length).toBeGreaterThan(0);

    const completed = await completePairing({
      code: pair.payload.code,
      deviceName: "phone",
    });
    expect(completed.token).toBeTruthy();
    expect(completed.device.name).toBe("phone");

    const device = await verifyRemoteToken(completed.token);
    expect(device?.id).toBe(completed.device.id);

    await expect(
      completePairing({ code: pair.payload.code, deviceName: "replay" })
    ).rejects.toThrow(/expired|used/i);
  });

  it("revokes paired devices", async () => {
    const pair = await createPairingPayload("test");
    const completed = await completePairing({
      code: pair.payload.code,
      deviceName: "pad",
    });
    expect(await verifyRemoteToken(completed.token)).toBeTruthy();

    expect(await revokeRemoteDevice(completed.device.id)).toBe(true);
    expect(await verifyRemoteToken(completed.token)).toBeNull();

    const devices = await listRemoteDevices();
    expect(devices.find((d) => d.id === completed.device.id)?.revokedAt).toBeTypeOf("number");
  });
});
