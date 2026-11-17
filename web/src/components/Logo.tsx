// The mark: a wax seal with a keyhole, its rim stamped with lattice points.
const DOTS = Array.from({ length: 12 }, (_, i) => {
  const a = (i / 12) * Math.PI * 2;
  return [16 + Math.cos(a) * 11.2, 16 + Math.sin(a) * 11.2] as const;
});

export function Mark({ size = 28, title }: { size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role={title ? "img" : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <circle cx="16" cy="16" r="15" fill="var(--seal)" />
      {DOTS.map(([x, y], i) => <circle key={i} cx={x} cy={y} r="0.95" fill="var(--seal-ink)" />)}
      <circle cx="16" cy="13.6" r="3.6" fill="var(--seal-ink)" />
      <path d="M14.1 15.6h3.8l1.5 6.9h-6.8z" fill="var(--seal-ink)" />
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
