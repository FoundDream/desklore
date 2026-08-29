import type { DesktopSnapshot } from "../../../../shared/contracts/index.js";

export type RunAction = (action: () => Promise<DesktopSnapshot>) => Promise<boolean>;
