"use strict";

function createPowerSaveController(powerSaveBlocker) {
  let blockerId = null;

  function isBlockerStarted() {
    return (
      blockerId != null &&
      typeof powerSaveBlocker.isStarted === "function" &&
      powerSaveBlocker.isStarted(blockerId)
    );
  }

  function setKeepAwakeEnabled(enabled) {
    if (enabled) {
      if (isBlockerStarted()) {
        return { enabled: true, id: blockerId };
      }
      blockerId = powerSaveBlocker.start("prevent-app-suspension");
      return { enabled: true, id: blockerId };
    }

    if (isBlockerStarted()) {
      powerSaveBlocker.stop(blockerId);
    }
    blockerId = null;
    return { enabled: false, id: null };
  }

  function getKeepAwakeStatus() {
    return {
      enabled: isBlockerStarted(),
      id: blockerId,
    };
  }

  return {
    setKeepAwakeEnabled,
    getKeepAwakeStatus,
  };
}

let defaultController = null;

function getDefaultController() {
  if (!defaultController) {
    const { powerSaveBlocker } = require("electron");
    defaultController = createPowerSaveController(powerSaveBlocker);
  }
  return defaultController;
}

module.exports = {
  createPowerSaveController,
  setKeepAwakeEnabled: (enabled) =>
    getDefaultController().setKeepAwakeEnabled(enabled),
  getKeepAwakeStatus: () =>
    getDefaultController().getKeepAwakeStatus(),
};
