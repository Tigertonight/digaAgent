import MobilePairClient from "../PairClient";
import { getPairingPayloadByCode } from "@/lib/remote/store";

export const dynamic = "force-dynamic";

export default async function MobilePairCodePage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const pair = getPairingPayloadByCode(code);
  if (!pair) {
    return <MobilePairClient initialCode={code} initialPayload={null} />;
  }

  return <MobilePairClient initialCode={code} initialPayload={pair.payload} />;
}
