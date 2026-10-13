'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { SearchProvider, type SharedProps } from 'fumadocs-ui/contexts/search';
import { SearchTrigger } from 'fumadocs-ui/layouts/shared/slots/search-trigger';
import { SearchDialog, SearchDialogOverlay, SearchDialogContent, SearchDialogHeader, SearchDialogInput, SearchDialogClose, SearchDialogList, SearchDialogIcon, SearchDialogListItem } from 'fumadocs-ui/components/dialog/search';
import { LIMITS } from '@/lib/limits';
type Result = { id: string; type: 'page' | 'heading' | 'text'; url: string; content: string; breadcrumbs: string[] };
function isResult(value: unknown, slug: string, generation: string): value is Result {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<Result>;
  if (typeof result.url !== 'string' || typeof result.content !== 'string' || typeof result.id !== 'string' ||
      !['page', 'heading', 'text'].includes(result.type ?? '') || !Array.isArray(result.breadcrumbs) || !result.breadcrumbs.every(part => typeof part === 'string')) return false;
  try {
    const target = new URL(result.url, window.location.origin);
    return target.origin === window.location.origin && target.pathname.split('/')[1] === slug && target.searchParams.get('g') === generation;
  } catch { return false; }
}

function highlightedText(content: ReactNode) {
  if (typeof content !== 'string') return content;
  // Only the search engine's highlight tags are interpreted; other HTML remains text.
  return content.split(/(<mark>[\s\S]*?<\/mark>)/g).map((part, index) => part.startsWith('<mark>')
    ? <span key={index} style={{ color: 'var(--color-fd-primary)', textDecoration: 'underline' }}>{part.slice(6, -7)}</span>
    : part);
}

function ProjectSearchDialog({ slug, generation, open, onOpenChange }: SharedProps & { slug: string; generation: string }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [state, setState] = useState<'idle' | 'searching' | 'ready' | 'error'>('idle');

  function changeQuery(value: string) {
    setQuery(value);
    setResults([]);
    setState('idle');
  }

  function changeOpen(value: boolean) {
    if (!value) changeQuery('');
    onOpenChange(value);
  }

  useEffect(() => {
    const normalized = query.trim();
    if (!open || !normalized) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setState('searching');
      try {
        const response = await fetch(
          '/api/search/' + encodeURIComponent(slug) + '?query=' + encodeURIComponent(normalized) + '&g=' + encodeURIComponent(generation),
          { cache: 'no-store', signal: controller.signal },
        );
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

  return <SearchDialog open={open} onOpenChange={changeOpen} search={query} onSearchChange={changeQuery} isLoading={state === 'searching'}>
    <SearchDialogOverlay />
    <SearchDialogContent>
      <SearchDialogHeader>
        <SearchDialogIcon />
        <SearchDialogInput maxLength={LIMITS.maxSearchQueryBytes} />
        <SearchDialogClose />
      </SearchDialogHeader>
      {query.trim() ? <SearchDialogList
        items={results}
        Empty={() => <p role="status" className="p-3 text-sm">{state === 'error' ? 'Search is temporarily unavailable.' : state === 'ready' ? 'No matching pages.' : 'Searching…'}</p>}
        Item={({ item, onClick }) => <SearchDialogListItem item={item} onClick={onClick}>
          <span className="block font-medium">{'breadcrumbs' in item ? item.breadcrumbs?.at(-1) ?? 'Documentation page' : 'Documentation page'}</span>
          <span className="block text-fd-muted-foreground">{'content' in item ? highlightedText(item.content) : ''}</span>
        </SearchDialogListItem>}
      /> : null}
    </SearchDialogContent>
  </SearchDialog>;
}

export function ProjectSearchProvider({ slug, generation, children }: { slug: string; generation: string; children: ReactNode }) {
  return <SearchProvider SearchDialog={ProjectSearchDialog} options={{ slug, generation }}>{children}</SearchProvider>;
}

export function ProjectSearch({ slug, generation }: { slug: string; generation: string }) {
  return <ProjectSearchProvider slug={slug} generation={generation}><SearchTrigger aria-label="Search this project" /></ProjectSearchProvider>;
}
