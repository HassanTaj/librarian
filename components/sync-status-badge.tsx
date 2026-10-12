export type SyncStatus = 'pending' | 'running' | 'succeeded' | 'failed';

const styles: Record<SyncStatus, string> = {
  pending: 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
  running: 'border-green-300 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300',
  succeeded: 'border-primary/40 bg-primary/10 text-primary dark:border-primary dark:bg-primary dark:text-primary-foreground',
  failed: 'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300',
};

export function SyncStatusBadge({ status }: { status: SyncStatus }) {
  return <span role="status" aria-label={`Sync status: ${status}`} className={`rounded-full border px-2.5 py-1 text-xs font-medium capitalize ${styles[status]}`}>{status}</span>;
}
