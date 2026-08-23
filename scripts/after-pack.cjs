const { execFile } = require("node:child_process");
const { access } = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const unusedElectronPrivacyKeys = [
  "NSAppTransportSecurity",
  "NSAudioCaptureUsageDescription",
  "NSBluetoothAlwaysUsageDescription",
  "NSBluetoothPeripheralUsageDescription",
  "NSCameraUsageDescription",
  "NSMicrophoneUsageDescription",
];

module.exports = async function removeUnusedElectronPrivacyDeclarations(context) {
  const infoPlist = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    "Contents",
    "Info.plist",
  );

  try {
    await access(infoPlist);
  } catch {
    return;
  }

  for (const key of unusedElectronPrivacyKeys) {
    await execFileAsync("plutil", ["-remove", key, infoPlist]);
  }
};
