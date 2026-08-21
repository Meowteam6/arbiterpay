// SPOTTER, placed. Every surface gets the otter doing something relevant to
// that page - watching the ledger, handing over a payout, nodding a verdict.
// One component, a pose per page, so the character reads as one system and no
// screen is just the run-across Easter egg.

type Pose = "nature" | "watching" | "verified" | "payout" | "neutral";

const WIDTHS: Record<string, string> = {
  sm: "w-28",
  md: "w-40",
  lg: "w-56",
};

export default function SpotterMascot({
  pose = "neutral",
  caption,
  sublabel,
  size = "md",
  float = true,
  className = "",
}: {
  pose?: Pose;
  caption?: string;
  sublabel?: string;
  size?: "sm" | "md" | "lg";
  float?: boolean;
  className?: string;
}) {
  return (
    <div className={`shrink-0 ${className}`}>
      <div
        className={`${float ? "otter-float" : ""} ${WIDTHS[size]} overflow-hidden rounded-2xl border border-edge bg-surface-raised shadow-sm`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/spotter/spotter-${pose}.png`}
          alt={caption ?? "SPOTTER, the GoHealthMe otter"}
          className="aspect-square w-full object-cover"
        />
      </div>
      {caption !== undefined ? (
        <p className="mt-2 text-center text-sm font-semibold">{caption}</p>
      ) : null}
      {sublabel !== undefined ? (
        <p className="mt-0.5 text-center text-xs text-muted">{sublabel}</p>
      ) : null}
    </div>
  );
}
