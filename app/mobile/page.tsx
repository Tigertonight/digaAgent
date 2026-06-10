import MobileApp from "./MobileApp";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

function parseRemoteCookie(raw: string) {
  try {
    return JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return JSON.parse(decodeURIComponent(raw));
  }
}

export default async function MobilePage() {
  let initialRemote = null;
  const raw = (await cookies()).get("mini-pi-remote")?.value;
  if (raw) {
    try {
      initialRemote = parseRemoteCookie(raw);
    } catch {
      initialRemote = null;
    }
  }
  return <MobileApp initialRemote={initialRemote} />;
}
