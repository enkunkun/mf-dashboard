export default function Loading() {
  return (
    <output
      className="mx-auto block w-full max-w-7xl space-y-6"
      aria-label="ページ読み込み中"
      aria-busy="true"
    >
      <span className="sr-only">ページ読み込み中…</span>
      <div className="h-8 w-40 animate-pulse rounded bg-muted motion-reduce:animate-none" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <div
            key={index}
            className="h-28 animate-pulse rounded-xl border bg-muted motion-reduce:animate-none"
          />
        ))}
      </div>
      <div className="h-72 animate-pulse rounded-xl border bg-muted motion-reduce:animate-none" />
    </output>
  );
}
