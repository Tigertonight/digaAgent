"use strict";
const sessions = [
  { id: "s-pin", name: "Diga Agent UI 设计审计", group: "已固定", state: "running", unread: 0, pinned: true, restored: false, cwd: "~/Documents/pi-agent/diga-agent" },
  { id: "s-active", name: "remote auth 收口 + SSE ticket", group: "今日", state: "wait", unread: 2, pinned: false, restored: false, cwd: "~/work/diga-agent" },
  { id: "s-recent1", name: "subagent retry/resume 修复", group: "今日", state: "idle", unread: 0, pinned: false, restored: false, cwd: "~/Documents/pi-agent/diga-agent" },
  { id: "s-recent2", name: "Goal verifier + 自动 resume", group: "昨天", state: "idle", unread: 0, pinned: false, restored: false, cwd: "~/Documents/pi-agent/diga-agent" },
  { id: "s-restored", name: "Mobile clarification 独立输入框", group: "本周", state: "idle", unread: 0, pinned: false, restored: true, cwd: "~/Documents/pi-agent/diga-agent" },
  { id: "s-old", name: "Cloudflare tunnel + 配对前 ping", group: "上周", state: "idle", unread: 0, pinned: false, restored: true, cwd: "~/work/diga-agent" },
];
let activeId = "s-active";

function flagOf(s) {
  if (s.state === "running") return '<span class="s-flag-run" title="running"></span>';
  if (s.state === "wait") return '<span class="s-flag-wait" title="waiting user"></span>';
  if (s.restored) return '<span class="s-flag-restored" title="restored from disk"></span>';
  return '<span class="s-flag-idle"></span>';
}
function renderSidebar() {
  const list = document.getElementById("session-list");
  const groups = {};
  for (const s of sessions) (groups[s.group] ||= []).push(s);
  const order = ["已固定", "今日", "昨天", "本周", "上周"];
  list.innerHTML = order
    .filter((g) => groups[g])
    .map((g) => {
      const items = groups[g]
        .map((s) => {
          return `<div class="s-item ${s.id === activeId ? "active" : ""}" data-id="${s.id}">
            ${flagOf(s)}
            <div class="s-name">${s.name}</div>
            ${s.unread ? `<span class="s-unread">${s.unread}</span>` : s.pinned ? '<span class="s-pin">PIN</span>' : ""}
            <div class="s-meta">${s.cwd}</div>
          </div>`;
        })
        .join("");
      return `<div class="sb-group">${g}</div>${items}`;
    })
    .join("");
  list.querySelectorAll(".s-item").forEach((el) => {
    el.addEventListener("click", () => {
      activeId = el.dataset.id;
      const s = sessions.find((x) => x.id === activeId);
      document.getElementById("s-title").textContent = s.name;
      const cwdEl = document.getElementById("s-cwd");
      cwdEl.textContent = s.cwd;
      cwdEl.classList.toggle("mismatch", s.cwd === "~/work/diga-agent");
      renderSidebar();
    });
  });
}
renderSidebar();
