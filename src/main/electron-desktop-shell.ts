import { shell } from "electron";
import type { DesktopShellPort } from "../server/ports.js";

export class ElectronDesktopShell implements DesktopShellPort {
  openPath(filePath: string): Promise<string> {
    return shell.openPath(filePath);
  }
}
