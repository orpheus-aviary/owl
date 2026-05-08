import { execFileSync } from "node:child_process";
import path from "node:path";

// electron-builder treats `identity: null` as "skip signing" and has no
// first-class ad-hoc bundle option (`identity: "-"` gets parsed as a real
// keychain name and falls through to skip). Without bundle-level signing,
// macOS Sequoia 15.x reports the .app as "damaged" on launch.
// We therefore re-sign the assembled bundle here with `codesign --sign -`.
export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  console.log(`[codesign-adhoc] signing ${appPath}`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit",
  });
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], {
    stdio: "inherit",
  });
  console.log("[codesign-adhoc] verified ok");
}
