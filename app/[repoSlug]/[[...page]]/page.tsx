import type { ComponentProps, ComponentType, ReactNode } from 'react';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/page';
import { notFound } from 'next/navigation';
import { auth } from '@/auth';
import { getMDXComponents } from '@/mdx-components';
import { ProjectSelector } from '@/components/project-selector';
import { ProjectSearch } from '@/components/project-search';
import { AccountControls, PrivateContentGuard } from '@/components/private-content-guard';
import { SignInButton } from '@/components/sign-in-button';
import { isCatalogSlug, listDirectoryCards } from '@/lib/catalog';
import { getMongo } from '@/lib/mongo';
import { withRuntimeContent } from '@/lib/content/source';
import { resolveContentLink } from '@/lib/content/paths';
import { baseOptions } from '@/lib/layout.shared';

type RouteProps = { params: Promise<{ repoSlug: string; page?: string[] }>; searchParams: Promise<{ g?: string | string[] }> };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requestedGeneration(value: string | string[] | undefined) {
  if (Array.isArray(value)) notFound();
  if (value !== undefined && !uuid.test(value)) notFound();
  return value;
}

function pageSlugs(input?: string[]) {
  return input?.at(-1) === 'index' ? input.slice(0, -1) : input;
}

function returnTo(slug: string, page?: string[], generation?: string) {
  const path = [slug, ...(page ?? [])].map(encodeURIComponent).join('/');
  return `/${path}${generation ? `?g=${encodeURIComponent(generation)}` : ''}`;
}

function renderUnavailable(error: unknown): never {
  if (error instanceof Error && ['unauthorized', 'not_found', 'content_unavailable'].includes(error.message)) notFound();
  throw error;
}

function repositoryComponents(slug: string, generation: string, path: string) {
  const trusted = getMDXComponents();
  const Anchor = trusted.a as ComponentType<ComponentProps<'a'>>;
  return getMDXComponents({
    a: ({ href, ...props }: ComponentProps<'a'>) => {
      const target = href ? resolveContentLink(slug, generation, path, href) : href;
      const external = target?.startsWith('https:');
      return <Anchor {...props} href={target} {...(external ? { rel: 'noopener noreferrer', referrerPolicy: 'no-referrer' as const } : {})} />;
    },
    img: ({ src, style, ...props }: ComponentProps<'img'>) => (
      // eslint-disable-next-line @next/next/no-img-element -- Assets have runtime dimensions and must use the guarded route.
      <img {...props} alt={props.alt ?? ''} loading={props.loading ?? 'lazy'} decoding={props.decoding ?? 'async'}
        src={typeof src === 'string' ? resolveContentLink(slug, generation, path, src, true) : undefined}
        style={{ maxWidth: '100%', height: 'auto', ...style }} />
    ),
  });
}

export default async function Reader({ params, searchParams }: RouteProps) {
  const [{ repoSlug }, query] = await Promise.all([params, searchParams]);
  if (!isCatalogSlug(repoSlug)) notFound();
  const generationId = requestedGeneration(query.g);
  const localReturn = returnTo(repoSlug, (await params).page, generationId);
  const { db, contentRoot } = await getMongo();
  if (!contentRoot) throw new Error('storage_unavailable');
  const projects = await listDirectoryCards(db);
  try {
    return await withRuntimeContent(db, contentRoot, repoSlug, generationId, async ({ loader, manifest }, signal, authorization) => {
      signal.throwIfAborted();
      const page = loader.getPage(pageSlugs((await params).page));
      if (!page) notFound();
      const rendered = await page.data.load().then(renderer => renderer.render(repositoryComponents(repoSlug, generationId ?? manifest.generationId, page.path)));
      signal.throwIfAborted();
      const toc = rendered.toc.map(item => ({ ...item, url: `${page.url}${item.url}` }));
      let showAccountControls = authorization.privateContent;
      if (!showAccountControls) {
        try { showAccountControls = Boolean((await auth())?.user?.id); } catch { /* Public content stays available when session lookup is unavailable. */ }
      }
      const layout = (
        <DocsLayout tree={loader.pageTree} {...baseOptions} searchToggle={{ enabled: false }}
          nav={{ ...baseOptions.nav, children: <div className="flex items-center gap-2"><ProjectSelector projects={projects} current={repoSlug} /><ProjectSearch slug={repoSlug} generation={manifest.generationId} />{showAccountControls ? <AccountControls /> : null}</div> }}>
          <DocsPage toc={toc} full={page.data.frontmatter.full as boolean | undefined}>
            <DocsTitle>{page.data.title}</DocsTitle>
            {page.data.description ? <DocsDescription>{page.data.description}</DocsDescription> : null}
            <DocsBody>{rendered.body as ReactNode}</DocsBody>
          </DocsPage>
        </DocsLayout>
      );
      if (!authorization.privateContent) return layout;
      if (authorization.roleVerifiedAt === null) throw new Error('unauthorized');
      return <PrivateContentGuard verifiedAt={authorization.roleVerifiedAt}>{layout}</PrivateContentGuard>;
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'unauthorized') {
      let showSignIn = true;
      try { showSignIn = !(await auth())?.user?.id; } catch { /* Keep sign-in available when session lookup is unavailable. */ }
      return (
        <main className="mx-auto max-w-3xl px-5 py-16">
          <h1 className="text-2xl font-semibold">Restricted project</h1>
          <p className="mt-3 text-muted-foreground">This project requires a verified repository reader role. Sign in if you have access, or ask the project owner to grant it.</p>
          {showSignIn ? <SignInButton redirectTo={localReturn} className="mt-5 rounded-md border px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /> : <AccountControls />}
        </main>
      );
    }
    renderUnavailable(error);
  }
}

export async function generateMetadata({ params, searchParams }: RouteProps) {
  const [{ repoSlug }, query] = await Promise.all([params, searchParams]);
  if (!isCatalogSlug(repoSlug)) notFound();
  const generationId = requestedGeneration(query.g);
  const { db, contentRoot } = await getMongo();
  if (!contentRoot) throw new Error('storage_unavailable');
  try {
    return await withRuntimeContent(db, contentRoot, repoSlug, generationId, async ({ loader }) => {
      const page = loader.getPage(pageSlugs((await params).page));
      if (!page) notFound();
      return { title: page.data.title, description: page.data.description };
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'unauthorized') return { title: 'Restricted project', description: 'Sign in to request access.' };
    renderUnavailable(error);
  }
}
