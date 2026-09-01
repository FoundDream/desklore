import type { ReactNode } from "react";

export type IconName =
  | "arrow-left"
  | "database"
  | "chevron-left"
  | "chevron-right"
  | "eye"
  | "folder"
  | "search"
  | "shield"
  | "sparkles"
  | "usage"
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
  usage: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 4.75V8l2.25 1.5" />
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
  search: (
    <>
      <circle cx="7" cy="7" r="4.25" />
      <path d="m10.25 10.25 3 3" />
    </>
  ),
  sparkles: (
    <>
      <path d="M6 2.25c.35 2.15 1.6 3.4 3.75 3.75C7.6 6.35 6.35 7.6 6 9.75 5.65 7.6 4.4 6.35 2.25 6 4.4 5.65 5.65 4.4 6 2.25Z" />
      <path d="M11.5 9.25c.2 1.25.95 2 2.25 2.25-1.3.2-2.05.95-2.25 2.25-.2-1.3-.95-2.05-2.25-2.25 1.3-.25 2.05-1 2.25-2.25Z" />
    </>
  ),
  eye: (
    <>
      <path d="M1.75 8s2.1-3.5 6.25-3.5S14.25 8 14.25 8 12.15 11.5 8 11.5 1.75 8 1.75 8Z" />
      <circle cx="8" cy="8" r="1.75" />
    </>
  ),
  shield: (
    <>
      <path d="M8 2 13 3.75v3.8c0 2.85-1.7 5.15-5 6.45-3.3-1.3-5-3.6-5-6.45v-3.8L8 2Z" />
      <path d="m5.75 8 1.5 1.5 3-3" />
    </>
  ),
  database: (
    <>
      <ellipse cx="8" cy="3.75" rx="5" ry="2" />
      <path d="M3 3.75v4c0 1.1 2.25 2 5 2s5-.9 5-2v-4" />
      <path d="M3 7.75v4c0 1.1 2.25 2 5 2s5-.9 5-2v-4" />
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
