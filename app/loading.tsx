function Skeleton({ className = '', height = 20, width = '100%', pill = false }: { className?: string; height?: number; width?: number | string; pill?: boolean }) {
  return <div aria-hidden="true" style={{ height, width, maxWidth: '100%', borderRadius: pill ? 9999 : 6, backgroundColor: 'rgba(128, 128, 128, 0.35)' }} className={'animate-pulse motion-reduce:animate-none ' + className} />;
}

export default function Loading() {
  const issueCard = Math.floor(Math.random() * 2);

  return <main role="status" aria-label="Loading documentation directory" aria-busy="true" className="mx-auto w-full max-w-6xl px-5 py-12 sm:px-8">
    <span className="sr-only">Loading documentation directory…</span>
    <header className="mb-8">
      <nav aria-hidden="true" className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Skeleton height={32} width={32} />
          <Skeleton width={176} />
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <Skeleton width={48} />
          <Skeleton width={96} />
          <div style={{ height: 40, width: 80 }} className="flex items-center justify-center rounded-lg border">
            <Skeleton width={56} />
          </div>
          <div style={{ height: 40, width: 64 }} className="flex items-center justify-center gap-2 rounded-full border px-2">
            <Skeleton width={20} pill />
            <Skeleton width={20} pill />
          </div>
        </div>
      </nav>
      <div aria-hidden="true">
        <Skeleton height={40} width={560} className="mt-2" />
        <Skeleton height={24} width={512} className="mt-3" />
      </div>
    </header>

    <div aria-hidden="true" className="mb-7 flex flex-col gap-4 rounded-lg border bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="w-full max-w-md">
        <div className="flex h-10 w-full items-center rounded-md border bg-background px-3">
          <Skeleton width={224} />
        </div>
      </div>
      <div className="flex h-9 items-center gap-2 self-start rounded-full border border-primary/50 px-3 sm:self-auto">
        <Skeleton width={20} pill />
        <Skeleton width={40} />
        <Skeleton width={20} pill />
      </div>
    </div>

    <ul aria-hidden="true" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {[0, 1].map(item => <li key={item}>
        <article className="flex h-full flex-col rounded-lg border bg-card p-5">
          <div className="mb-3 flex min-w-0 items-center justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <Skeleton width={20} pill className="shrink-0" />
              <Skeleton height={28} className="min-w-0 flex-1" />
              <Skeleton height={24} width={64} pill className="shrink-0" />
            </div>
            <Skeleton width={20} pill className="shrink-0" />
          </div>
          <div style={{ display: 'grid', gap: 8 }} className="mt-2">
            <Skeleton />
            <Skeleton width="92%" />
            <Skeleton width="75%" />
          </div>
          {item === issueCard ? <div style={{ borderColor: 'rgba(239, 68, 68, 0.5)', backgroundColor: 'rgba(127, 29, 29, 0.15)' }} className="mt-4 rounded-md border p-3">
            <div aria-hidden="true" style={{ height: 20, width: 176, maxWidth: '100%', backgroundColor: 'rgba(252, 165, 165, 0.6)' }} className="animate-pulse rounded-sm motion-reduce:animate-none" />
          </div> : null}
          <div style={{ marginTop: 'auto' }} className="flex justify-start pt-3">
            <Skeleton height={28} width={96} pill />
          </div>
        </article>
      </li>)}
    </ul>
  </main>;
}
