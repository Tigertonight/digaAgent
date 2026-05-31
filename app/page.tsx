import ChatApp from "./ChatApp";
import { listAllSessions } from "@/lib/sessions";

export const dynamic = "force-dynamic";

export default async function Home() {
  const sessions = await listAllSessions();
  const cwd = process.cwd();
  return (
    <ChatApp
      initialSessions={sessions.map((s) => ({
        id: s.id,
        path: s.path,
        cwd: s.cwd,
        name: s.name,
        parentSessionPath: s.parentSessionPath,
        created: s.created.toISOString(),
        modified: s.modified.toISOString(),
        messageCount: s.messageCount,
        firstMessage: s.firstMessage,
        isRunning: s.isRunning,
      }))}
      defaultCwd={cwd}
    />
  );
}
