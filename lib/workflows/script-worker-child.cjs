"use strict";

const vm = require("node:vm");
const readline = require("node:readline");

let nextRequestId = 1;
let initMessage = null;
const pendingResponses = new Map();
const pendingSideEffects = new Set();
const localArtifacts = new Map();

function safeJson(value) {
  return JSON.stringify(value, (_key, raw) =>
    typeof raw === "bigint" ? raw.toString() : raw
  );
}

function send(message) {
  process.stdout.write(`${safeJson(message)}\n`);
}

function request(method, args) {
  const id = String(nextRequestId++);
  send({ type: "request", id, method, args });
  return new Promise((resolve, reject) => {
    pendingResponses.set(id, { resolve, reject });
  });
}

function trackSideEffect(promise) {
  const tracked = promise.finally(() => pendingSideEffects.delete(tracked));
  tracked.catch(() => {});
  pendingSideEffects.add(tracked);
}

function createWorkflow(init) {
  localArtifacts.clear();
  for (const artifact of init.artifacts || []) {
    if (artifact && typeof artifact.name === "string") {
      localArtifacts.set(artifact.name, artifact);
    }
  }

  const workflow = {
    workflowId: init.workflowId,
    objective: init.objective,
    capabilities: Object.freeze(init.manifest.capabilities.slice()),
    resume: init.resume ? Object.freeze(init.resume) : undefined,

    log(message) {
      trackSideEffect(request("log", ["info", String(message)]));
    },

    warn(message) {
      trackSideEffect(request("log", ["warn", String(message)]));
    },

    error(message) {
      trackSideEffect(request("log", ["error", String(message)]));
    },

    checkpoint(name, value) {
      trackSideEffect(request("checkpoint", [String(name), value]));
      return value;
    },

    artifact(name, value) {
      const artifact = { name: String(name), value, createdAt: Date.now() };
      localArtifacts.set(artifact.name, artifact);
      trackSideEffect(request("artifact", [artifact.name, value]));
      return value;
    },

    readArtifact(name) {
      return localArtifacts.get(String(name))?.value;
    },

    listArtifacts() {
      return Array.from(localArtifacts.values());
    },

    createWorktree(input) {
      return request("createWorktree", [input]);
    },

    diffWorktree(worktree) {
      return request("diffWorktree", [worktree]);
    },

    mergeWorktree(worktree) {
      return request("mergeWorktree", [worktree]);
    },

    removeWorktree(worktree) {
      return request("removeWorktree", [worktree]);
    },

    askUser(input) {
      return request("askUser", [input]);
    },

    fetchUrl(input) {
      return request("fetchUrl", [input]);
    },

    spawnAgent(input) {
      return request("spawnAgent", [input]);
    },

    parallel(items) {
      if (!Array.isArray(items)) {
        throw new Error("workflow.parallel requires an array");
      }
      if (items.length > init.manifest.maxConcurrency) {
        throw new Error(
          `workflow.parallel supports at most ${init.manifest.maxConcurrency} item(s) for this manifest`
        );
      }
      return Promise.all(
        items.map((item) => (typeof item === "function" ? item() : item))
      );
    },

    async stage(title, fn) {
      workflow.log(`stage:start:${String(title).slice(0, 160)}`);
      try {
        const result = await fn();
        workflow.log(`stage:end:${String(title).slice(0, 160)}`);
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        workflow.error(`stage:failed:${String(title).slice(0, 160)}:${message}`);
        throw err;
      }
    },

    sleep(ms) {
      const safeMs = Math.max(0, Math.min(Math.floor(Number(ms) || 0), 30000));
      return new Promise((resolve) => setTimeout(resolve, safeMs));
    },
  };

  return Object.freeze(workflow);
}

async function run(init) {
  const workflow = createWorkflow(init);
  const consoleShim = Object.freeze({
    log: (...parts) => workflow.log(parts.map(String).join(" ")),
    warn: (...parts) => workflow.warn(parts.map(String).join(" ")),
    error: (...parts) => workflow.error(parts.map(String).join(" ")),
  });
  const context = vm.createContext(
    Object.freeze({
      workflow,
      console: consoleShim,
      Promise,
      JSON,
      Math,
      Date,
      Array,
      Object,
      String,
      Number,
      Boolean,
      RegExp,
      Error,
      setTimeout,
      clearTimeout,
    })
  );
  const wrapped = new vm.Script(
    `"use strict";\n(async () => {\n${init.script}\n})()`,
    { filename: `workflow-${init.workflowId}.js` }
  );
  const value = await wrapped.runInContext(context, { timeout: 1000 });
  await Promise.all(Array.from(pendingSideEffects));
  send({ type: "done", value });
}

function serializeError(err) {
  return err instanceof Error ? err.message : String(err);
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch (err) {
    send({ type: "error", error: `Invalid worker message: ${serializeError(err)}` });
    return;
  }

  if (message.type === "init") {
    initMessage = message;
    run(initMessage).catch((err) => {
      send({ type: "error", error: serializeError(err) });
    });
    return;
  }

  if (message.type === "response") {
    const pending = pendingResponses.get(message.id);
    if (!pending) return;
    pendingResponses.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error));
    } else {
      pending.resolve(message.result);
    }
  }
});

process.on("uncaughtException", (err) => {
  send({ type: "error", error: serializeError(err) });
});

process.on("unhandledRejection", (err) => {
  send({ type: "error", error: serializeError(err) });
});

setTimeout(() => {
  if (!initMessage) {
    send({ type: "error", error: "Workflow worker did not receive init message" });
  }
}, 5000);
