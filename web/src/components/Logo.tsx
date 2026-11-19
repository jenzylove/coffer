// The mark: a glass seal. A blue lens with two offset rims and a keyhole.
import { useId } from "react";

export function Mark({ size = 28, title }: { size?: number; title?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role={title ? "img" : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <defs>
        <radialGradient id={`g${id}`} cx="38%" cy="34%" r="70%">
          <stop offset="0" stopColor="#8fb0ff" />
          <stop offset="0.55" stopColor="#2f5bff" />
          <stop offset="1" stopColor="#1a2fc9" />
        </radialGradient>
      </defs>
      <circle cx="13.6" cy="13.6" r="12.2" fill="none" stroke="#9db4ff" strokeOpacity="0.7" strokeWidth="1.2" />
      <circle cx="15" cy="15" r="12.6" fill="none" stroke="#5b7fff" strokeOpacity="0.8" strokeWidth="1.2" />
      <circle cx="17" cy="17" r="13" fill={`url(#g${id})`} />
      <circle cx="17" cy="15" r="3.1" fill="#fff" />
      <path d="M15.4 16.8h3.2l1.1 6.2h-5.4z" fill="#fff" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="wordmark">
      <Mark size={26} />
      <span>Coffer</span>
    </span>
  );
}
