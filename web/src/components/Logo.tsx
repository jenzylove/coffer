// The mark: a heavy C with a seal line cut through it, like the slot in a strongbox.
// Two filled halves with a real gap, so it reads on any background.
const UPPER = "M26.725 7.001A14 14 0 0 0 2.06 14.7H8.715A7.4 7.4 0 0 1 21.669 11.243Z";
const LOWER = "M26.725 24.999A14 14 0 0 1 2.06 17.3H8.715A7.4 7.4 0 0 0 21.669 20.757Z";

export function Mark({ size = 26 }: { size?: number }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden focusable="false">
      <path d={UPPER} fill="currentColor" />
      <path d={LOWER} fill="currentColor" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="wordmark">
      <Mark />
      <span>Coffer</span>
    </span>
  );
}
