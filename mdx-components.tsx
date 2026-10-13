import type { MDXComponents } from 'mdx/types';
import type { ReactNode } from 'react';
import { Callout } from 'fumadocs-ui/components/callout';
import defaultMdxComponents from 'fumadocs-ui/mdx';

function Columns({ cols, children }: { cols: number; children?: ReactNode }) {
  const columns = cols === 1 ? 'grid-cols-1' : cols === 2 ? 'grid-cols-1 sm:grid-cols-2'
    : cols === 3 ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4';
  return <div className={`my-5 grid gap-4 ${columns}`}>{children}</div>;
}

function Steps({ children }: { children?: ReactNode }) {
  return <ol className="my-5 grid list-decimal gap-4 border-s ps-6">{children}</ol>;
}

function Step({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return <li className="ps-2"><h3 className="mb-2 font-semibold">{title}</h3>{children}</li>;
}

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Info: (props: React.ComponentProps<typeof Callout>) => <Callout {...props} type="info" />,
    Note: (props: React.ComponentProps<typeof Callout>) => <Callout {...props} type="info" />,
    Warning: (props: React.ComponentProps<typeof Callout>) => <Callout {...props} type="warning" />,
    Columns,
    Steps,
    Step,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;
