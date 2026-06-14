import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export default async function electronAfterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  if (!existsSync(appPath)) {
    throw new Error(`Packed app not found: ${appPath}`);
  }

  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit",
  });
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], {
    stdio: "inherit",
  });
}
