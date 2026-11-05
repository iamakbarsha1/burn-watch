/**
 * There was no loading boundary anywhere in the app, so Next.js held the old
 * page until the new one had finished rendering on the server — session lookup,
 * then an uncached API round trip. That is the whole of "moving between pages
 * feels laggy": the work was always going to take that long, but nothing on
 * screen admitted a click had happened.
 *
 * Shapes match the real layout (header, tiles, panel) so the swap to live
 * content does not jump.
 */
function Shimmer({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-surface-2 ${className}`} />
}

export default function Loading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>

      <div className="mb-6">
        <Shimmer className="h-7 w-52" />
        <Shimmer className="mt-2 h-4 w-72" />
      </div>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="rounded-[var(--radius-card)] border border-line bg-surface-1 p-5"
          >
            <Shimmer className="h-3 w-24" />
            <Shimmer className="mt-3 h-8 w-28" />
          </div>
        ))}
      </div>

      <div className="rounded-[var(--radius-card)] border border-line bg-surface-1 p-6">
        <Shimmer className="h-4 w-32" />
        <Shimmer className="mt-4 h-64 w-full" />
      </div>
    </div>
  )
}
