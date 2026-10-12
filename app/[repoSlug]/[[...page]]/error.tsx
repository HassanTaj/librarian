'use client';

export default function ReaderError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="mx-auto max-w-3xl px-5 py-16"><h1 className="text-2xl font-semibold">Documentation unavailable</h1><p className="mt-3 text-muted-foreground">The documentation could not be loaded. Try again shortly.</p><button className="mt-5 rounded-md border px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={reset}>Try again</button></main>;
}
