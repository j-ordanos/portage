/** The Portage mark: a bridge between two posts carrying one crate, the handover from one platform to another. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="Portage"
      className="logo"
    >
      <rect width="32" height="32" rx="8" fill="currentColor" />
      <path
        d="M7.5 23v-5.5M24.5 23v-5.5M7.5 17.5C10.5 8.5 21.5 8.5 24.5 17.5"
        fill="none"
        stroke="var(--on-brand)"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect
        x="13.4"
        y="12.6"
        width="5.2"
        height="5.2"
        rx="1.2"
        fill="var(--on-brand)"
      />
    </svg>
  );
}

export const AUTHOR = {
  name: "Yordanos",
  github: "https://github.com/j-ordanos",
} as const;
export const VERSION = "0.1.0";
