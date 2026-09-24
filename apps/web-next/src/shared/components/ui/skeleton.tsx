interface SkeletonProps {
  /** Size the block close to the content it replaces so layout does not jump. */
  className?: string
}

/**
 * Loading placeholder. The shimmer animation is decorative and lives in
 * `globals.css`; the base state is a static tonal box, so reduced-motion
 * users still see a legible placeholder. Pair with `aria-busy` on the parent
 * region — screen readers announce the busy state, not the skeleton.
 */
export function Skeleton({ className = '' }: SkeletonProps) {
  return <div aria-hidden="true" className={`motion-shimmer rounded-control ${className}`} />
}
