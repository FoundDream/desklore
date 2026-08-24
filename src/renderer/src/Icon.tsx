import type { ReactNode } from "react";

export type IconName =
  | "arrow-left"
  | "chevron-left"
  | "chevron-right"
  | "folder"
  | "memory"
  | "settings"
  | "timeline";

const geometry: Record<IconName, ReactNode> = {
  timeline: (
    <>
      <path d="M3 4.25v3M3 8.75v3" />
      <path d="M5.25 3.5H13M5.25 8h5.5M5.25 12.5H13" />
      <circle cx="3" cy="3.5" r="0.75" fill="currentColor" stroke="none" />
      <circle cx="3" cy="8" r="0.75" fill="currentColor" stroke="none" />
      <circle cx="3" cy="12.5" r="0.75" fill="currentColor" stroke="none" />
    </>
  ),
  memory: (
    <>
      <path d="M2.5 3.25h3.25A2.25 2.25 0 0 1 8 5.5v7.25a2.25 2.25 0 0 0-2.25-1.5H2.5z" />
      <path d="M13.5 3.25h-3.25A2.25 2.25 0 0 0 8 5.5v7.25a2.25 2.25 0 0 1 2.25-1.5h3.25z" />
    </>
  ),
  settings: (
    <>
      <path d="M2.5 4h3M8.5 4h5M2.5 8h6M11.5 8h2M2.5 12h2M7.5 12h6" />
      <circle cx="7" cy="4" r="1.25" />
      <circle cx="10" cy="8" r="1.25" />
      <circle cx="6" cy="12" r="1.25" />
    </>
  ),
  folder: <path d="M2.25 4.25h4l1.5 1.5h6v6.5H2.25z" />,
  "chevron-left": <path d="m9.75 4.25-3.75 3.75 3.75 3.75" />,
  "chevron-right": <path d="m6.25 4.25 3.75 3.75-3.75 3.75" />,
  "arrow-left": <path d="M7 4.25 3.25 8 7 11.75M3.5 8h9" />,
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className="ui-icon"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      data-icon={name}
    >
      {geometry[name]}
    </svg>
  );
}
