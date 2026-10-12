'use client';

import { useEffect, useRef, useState } from 'react';
import { LIMITS } from '@/lib/limits';

type Result = { id: string; type: string; url: string; content: string; breadcrumbs: string[] };
function isResult(value: unknown, slug: string, generation: string): value is Result {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<Result>;
  if (typeof result.url !== 'string' || typeof result.content !== 'string' || typeof result.id !== 'string' ||
      typeof result.type !== 'string' || !Array.isArray(result.breadcrumbs) || !result.breadcrumbs.every(part => typeof part === 'string')) return false;
  try {
    const target = new URL(result.url, window.location.origin);
    return target.origin === window.location.origin && target.pathname.split('/')[1] === slug && target.searchParams.get('g') === generation;
  } catch { return false; }
}

export function ProjectSearch({ slug, generation }: { slug: string; generation: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [state, setState] = useState<'idle' | 'searching' | 'ready' | 'error'>('idle');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const normalized = query.trim();
    if (!open || !normalized) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setState('searching');
      try {
        const response = await fetch(`/api/search/${encodeURIComponent(slug)}?query=${encodeURIComponent(normalized)}&g=${encodeURIComponent(generation)}`,
          { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('search_unavailable');
        const value: unknown = await response.json();
        if (!Array.isArray(value)) throw new Error('search_unavailable');
        setResults(value.filter(item => isResult(item, slug, generation)).slice(0, LIMITS.maxSearchResults));
        setState('ready');
      } catch {
        if (!controller.signal.aborted) { setResults([]); setState('error'); }
      }
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [generation, open, query, slug]);
  return (
    <div className="relative">
      <button type="button" aria-expanded={open} aria-controls="project-search-panel"
        onClick={() => {
          if (open) { setOpen(false); setQuery(''); setResults([]); setState('idle'); }
          else { setOpen(true); requestAnimationFrame(() => input.current?.focus()); }
        }}
        className="rounded-md border px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        Search this project
      </button>
      {open ? (
        <div id="project-search-panel" className="absolute right-0 top-full z-50 mt-2 w-[min(24rem,90vw)] rounded-lg border bg-background p-3 shadow-lg">
          <label htmlFor="project-search" className="mb-2 block text-sm font-medium">Search this project</label>
          <input ref={input} id="project-search" type="search" value={query} maxLength={LIMITS.maxSearchQueryBytes}
            onChange={event => { setQuery(event.target.value); setResults([]); setState('idle'); }} placeholder="Search documentation"
            className="w-full rounded-md border bg-background px-3 py-2 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          <div aria-live="polite" role="status" className="mt-2 max-h-72 overflow-auto text-sm">
            {state === 'searching' ? <p>Searching…</p> : null}
            {state === 'error' ? <p>Search is temporarily unavailable.</p> : null}
            {state === 'ready' && results.length === 0 ? <p>No matching pages.</p> : null}
            {results.map(result => (
              <a key={result.id} href={result.url} className="block rounded-md px-2 py-2 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="block font-medium">{result.breadcrumbs.at(-1) ?? 'Documentation page'}</span>
                <span className="mt-1 block text-muted-foreground">{result.content}</span>
              </a>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
