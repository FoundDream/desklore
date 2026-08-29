import { shell } from "electron";
import type { DesktopShell } from "../contracts.js";

export class ElectronDesktopShell implements DesktopShell {
  openPath(filePath: string): Promise<string> {
    return shell.openPath(filePath);
  }
}
