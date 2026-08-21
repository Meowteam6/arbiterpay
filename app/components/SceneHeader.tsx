import type { ReactNode } from "react";

// A Juno-style scenic header: a painterly riverbank meadow behind the title,
// with a big SPOTTER standing in the grass doing something relevant to the
// page. The otter is a transparent cutout so he lives IN the scene. A soft
// scrim over the text side keeps the headline legible; page content renders
// below on the cream. The scene is decoration, so its layers are aria-hidden.
export default function SceneHeader({
  title,
  subtitle,
  pose,
  poseAlt,
  eyebrow,
  spotterLine,
  children,
}: {
  title: string;
  subtitle?: string;
  /** Transparent otter file under /spotter, e.g. "spotter-lounging.png". */
  pose: string;
  poseAlt: string;
  eyebrow?: string;
  /** A deadpan SPOTTER line, shown as a small speech bubble beside the otter. */
  spotterLine?: string;
  children?: ReactNode;
}) {
  return (
    <section className="relative overflow-hidden rounded-3xl border border-edge bg-surface-raised">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/spotter/backdrop.png"
        alt=""
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full object-cover object-bottom"
      />
      {/* legibility scrim over the text side */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-gradient-to-r from-surface-raised/85 via-surface-raised/45 to-transparent"
      />

      <div className="relative z-10 flex min-h-[14rem] items-end justify-between gap-4 px-6 pt-8 sm:min-h-[16rem] sm:px-9">
        <div className="max-w-md pb-8">
          {eyebrow !== undefined ? (
            <p className="text-xs font-semibold uppercase tracking-widest text-accent-strong">
              {eyebrow}
            </p>
          ) : null}
          <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
            {title}
          </h1>
          {subtitle !== undefined ? (
            <p className="mt-2 text-sm leading-relaxed text-foreground/70 sm:text-base">
              {subtitle}
            </p>
          ) : null}
          {children}
        </div>
        <div className="relative hidden shrink-0 self-end sm:block">
          {spotterLine !== undefined ? (
            <div className="absolute right-full top-4 z-10 mr-1 w-40 rounded-2xl rounded-br-sm border border-edge bg-surface px-3 py-2 text-xs font-medium leading-snug text-foreground shadow-sm md:w-48">
              {spotterLine}
            </div>
          ) : null}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/spotter/${pose}`}
            alt={poseAlt}
            className="otter-float -mb-1 h-44 w-auto drop-shadow-xl sm:h-56"
          />
        </div>
      </div>
    </section>
  );
}
