import { Suspense, type ReactNode } from 'react';
import DocumentationSkeleton from './skeleton';

export default function RepositoryLayout({ children }: { children: ReactNode }) {
  return <Suspense fallback={<DocumentationSkeleton />}>{children}</Suspense>;
}
