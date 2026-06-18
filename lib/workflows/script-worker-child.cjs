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

// Quality gate for spawnAgent result batches. Mirrors evaluateRequireSuccess in
// script-runtime.ts so the in-process SDK and this worker SDK stay in lockstep.
// Throws when fewer than `minSuccess` results have status === "completed".
function evaluateRequireSuccess(results, options) {
  if (!Array.isArray(results)) {
    throw new Error("workflow.requireSuccess requires an array of results");
  }
  const label = options && options.label ? `${options.label}: ` : "";
  const total = results.length;
  const requested =
    options && options.minSuccess != null ? Math.floor(options.minSuccess) : total;
  const minSuccess = Math.max(0, Math.min(requested, total));
  const succeeded = [];
  const failures = [];
  for (let i = 0; i < total; i += 1) {
    const entry = results[i];
    const status = entry ? entry.status : undefined;
    if (status === "completed") {
      succeeded.push(entry);
      continue;
    }
    const who = (entry && (entry.title || entry.taskId)) || `#${i}`;
    failures.push(`${who} (${status == null ? "unknown" : status})`);
  }
  if (succeeded.length < minSuccess) {
    throw new Error(
      `${label}workflow.requireSuccess gate failed: ${succeeded.length}/${total} succeeded, ` +
        `need at least ${minSuccess}. Failed: ${failures.join(", ") || "n/a"}`
    );
  }
  return succeeded;
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

function createPatterns(workflow) {
  return Object.freeze({
    async classifyAndAct(input) {
      const classifier = input?.classifier;
      const routes = input?.routes || {};
      if (typeof classifier !== "function") {
        throw new Error("workflow.patterns.classifyAndAct requires a classifier function");
      }
      const classification = await classifier(input.input);
      const route =
        typeof classification === "string"
          ? classification
          : classification?.route || classification?.type || classification?.label;
      if (!route || typeof routes[route] !== "function") {
        throw new Error(`workflow.patterns.classifyAndAct has no route handler for: ${route}`);
      }
      return routes[route](classification, input.input);
    },

    async fanOutAndSynthesize(input) {
      const items = Array.isArray(input?.items) ? input.items : [];
      if (typeof input?.worker !== "function") {
        throw new Error("workflow.patterns.fanOutAndSynthesize requires a worker function");
      }
      const results = await workflow.parallel(
        items.map((item, index) => () => input.worker(item, index))
      );
      if (typeof input.synthesizer === "function") {
        return input.synthesizer(results, items);
      }
      return results;
    },

    async adversarialVerify(input) {
      const verifierCount = Math.max(1, Math.min(Number(input?.verifierCount) || 1, 8));
      const schema =
        input?.schema || {
          type: "object",
          required: ["pass", "issues"],
          properties: {
            pass: { type: "boolean" },
            issues: { type: "array", items: { type: "string" } },
          },
        };
      const criteria = input?.criteria ? `Criteria:\n${String(input.criteria)}` : "";
      const results = await workflow.parallel(
        Array.from({ length: verifierCount }, (_unused, index) => () =>
          workflow.agent(
            [
              "Adversarially verify this draft. Look for concrete failures.",
              criteria,
              "Draft:",
              typeof input?.draft === "string"
                ? input.draft
                : JSON.stringify(input?.draft),
            ]
              .filter(Boolean)
              .join("\n\n"),
            {
              id: `adversarial-verifier-${index + 1}`,
              title: `Adversarial verifier ${index + 1}`,
              agentType: "verifier",
              schema,
            }
          )
        )
      );
      const passed = results.every((result) => result.data?.pass === true);
      const output = { passed, results };
      workflow.artifact(input?.artifactName || "adversarial-verification", output);
      if (input?.requirePass && !passed) {
        throw new Error("workflow.patterns.adversarialVerify failed");
      }
      return output;
    },

    async generateAndFilter(input) {
      const count = Math.max(1, Math.min(Number(input?.count) || 1, 32));
      if (typeof input?.generator !== "function") {
        throw new Error("workflow.patterns.generateAndFilter requires a generator function");
      }
      const candidates = await workflow.parallel(
        Array.from({ length: count }, (_unused, index) => () => input.generator(index))
      );
      const filtered =
        typeof input.filter === "function"
          ? await input.filter(candidates)
          : candidates;
      const maxKeep = Number(input?.maxKeep);
      return Number.isFinite(maxKeep) && maxKeep >= 0
        ? filtered.slice(0, Math.floor(maxKeep))
        : filtered;
    },

    async tournament(input) {
      const compare = input?.compare;
      if (!Array.isArray(input?.candidates) || typeof compare !== "function") {
        throw new Error("workflow.patterns.tournament requires candidates and compare");
      }
      let round = input.candidates.slice();
      const bracket = [];
      while (round.length > 1) {
        const next = [];
        for (let index = 0; index < round.length; index += 2) {
          const a = round[index];
          const b = round[index + 1];
          if (b === undefined) {
            next.push(a);
            continue;
          }
          const winner = await compare(a, b, bracket.length);
          bracket.push({ a, b, winner });
          next.push(winner);
        }
        round = next;
      }
      return { winner: round[0], bracket };
    },

    async loopUntilDone(input) {
      if (typeof input?.step !== "function") {
        throw new Error("workflow.patterns.loopUntilDone requires a step function");
      }
      const maxIterations = Math.max(1, Math.min(Number(input?.maxIterations) || 5, 50));
      let state = input.state;
      const history = [];
      for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
        state = await input.step(state, iteration);
        const verification =
          typeof input.verifier === "function"
            ? await input.verifier(state, iteration)
            : undefined;
        history.push({ iteration, state, verification });
        workflow.checkpoint(input.checkpointName || "loop-until-done", {
          iteration,
          state,
          verification,
        });
        const done =
          typeof input.stopWhen === "function"
            ? await input.stopWhen(state, verification, iteration)
            : verification?.done === true || verification?.pass === true;
        if (done) return { state, verification, iterations: iteration, history };
      }
      throw new Error(
        `workflow.patterns.loopUntilDone exceeded maxIterations=${maxIterations}`
      );
    },
  });
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
    params: init.params,
    template: init.template ? Object.freeze(init.template) : undefined,

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

    listTools(serverId) {
      return request("listTools", [serverId]);
    },

    // Progressive disclosure for MCP. Mirrors filterMcpToolsForSearch in
    // script-runtime.ts: fetch the (scoped) tool list, then filter + detail-trim
    // locally so the harness can discover tools without pulling every schema.
    async searchTools(searchInput) {
      const tools = await request("listTools", [
        searchInput && searchInput.serverId ? searchInput.serverId : undefined,
      ]);
      const list = Array.isArray(tools) ? tools : [];
      const query = ((searchInput && searchInput.query) || "")
        .trim()
        .toLowerCase();
      const detail = (searchInput && searchInput.detailLevel) || "summary";
      const rawLimit = searchInput && searchInput.limit;
      const limit = Math.max(1, Math.min(Math.floor(rawLimit || 20), 100));
      const matched = list.filter((tool) => {
        if (!query) return true;
        const haystack = `${tool.name} ${tool.description || ""}`.toLowerCase();
        return haystack.includes(query);
      });
      return matched.slice(0, limit).map((tool) => {
        if (detail === "name") return { serverId: tool.serverId, name: tool.name };
        if (detail === "summary") {
          return {
            serverId: tool.serverId,
            name: tool.name,
            description: tool.description,
          };
        }
        return tool;
      });
    },

    callTool(input) {
      return request("callTool", [input]);
    },

    agent(prompt, input) {
      return request("agent", [String(prompt), input]);
    },

    spawnAgent(input) {
      return request("spawnAgent", [input]);
    },

    async parallel(items) {
      if (!Array.isArray(items)) {
        throw new Error("workflow.parallel requires an array");
      }
      // maxConcurrency is a concurrency budget, not an array-length cap. Any
      // number of items may be scheduled; at most `maxConcurrency` run at once
      // and the rest queue. Results preserve input order (Promise.all semantics).
      const limit = Math.max(1, init.manifest.maxConcurrency);
      const total = items.length;
      if (total === 0) return [];

      const results = new Array(total);
      let nextIndex = 0;

      const runWorker = async () => {
        for (;;) {
          const current = nextIndex;
          if (current >= total) return;
          nextIndex += 1;
          const item = items[current];
          results[current] = await (typeof item === "function" ? item() : item);
        }
      };

      const workerCount = Math.min(limit, total);
      const workers = [];
      for (let i = 0; i < workerCount; i += 1) workers.push(runWorker());
      await Promise.all(workers);
      return results;
    },

    requireSuccess(results, options) {
      return evaluateRequireSuccess(results, options);
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
  workflow.patterns = createPatterns(workflow);

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
