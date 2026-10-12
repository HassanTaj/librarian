import type { DirectoryCard } from './directory';

export function ProjectSelector({ projects, current }: { projects: DirectoryCard[]; current: string }) {
  const selected = projects.find(project => project.slug === current);
  return (
    <details className="relative">
      <summary aria-label={`Select project. Current: ${selected?.title ?? current}`}
        className="flex cursor-pointer list-none items-center rounded-md border px-2 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {selected?.title ?? 'Select project'}
      </summary>
      <ul aria-label="Projects" className="absolute left-0 top-full z-50 mt-2 min-w-48 rounded-lg border bg-background p-1 shadow-lg">
        {projects.map(project => (
          <li key={project.slug}>
            <a href={project.url} aria-current={project.slug === current ? 'page' : undefined}
              className="flex items-center justify-between gap-3 rounded-md px-2 py-2 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <span>{project.title}</span>
              <span className="text-xs text-muted-foreground">{project.visibility === 'private' ? 'Restricted' : 'Public'}</span>
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}
