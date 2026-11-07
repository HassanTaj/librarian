import styles from './instance-settings.module.css';

export const settingsSections = { auth: 'Auth', zitadel: 'Zitadel', mongodb: 'MongoDB', githubApp: 'GitHub App', githubWebhook: 'GitHub webhook', runtime: 'Runtime and documentation', host: 'Host prerequisites', validation: 'Validation', audit: 'Audit' };

function Skeleton({ width = '100%', height = 20 }: { width?: number | string; height?: number }) {
  return <div aria-hidden="true" className="animate-pulse motion-reduce:animate-none" style={{ width, height, maxWidth: '100%', borderRadius: 6, backgroundColor: 'rgba(128, 128, 128, 0.35)' }} />;
}

export function InstanceSettingsSkeleton() {
  return <div role="status" aria-label="Loading instance settings" aria-busy="true" className={styles.settings}>
    <span className="sr-only">Loading instance settings…</span>
    <div aria-hidden="true">
      <div className={styles.overview}>
        <div className="grid gap-2"><Skeleton width={140} height={27} /><Skeleton width={520} height={22} /></div>
        <Skeleton width={120} height={26} />
      </div>
      <div className={styles.tabList}>
        {Object.entries(settingsSections).map(([key, label]) => <div key={key} className={styles.tab}><Skeleton width={`${label.length * .5}rem`} height={20} /></div>)}
      </div>
      <div className={styles.panel}><div className={styles.group}>
        <Skeleton width={240} height={24} />
        {['Display name', 'Description', 'Public origin', 'Default documentation folder'].map((label, index) => <div key={label} className="grid gap-2">
          <Skeleton width={label.length * 7} height={20} /><Skeleton height={index === 1 ? 96 : 42} />
        </div>)}
        <Skeleton height={22} width="85%" /><Skeleton height={22} width="95%" />
      </div></div>
      <div className={styles.actions}>{[100, 80, 88].map(width => <Skeleton key={width} width={width} height={38} />)}</div>
    </div>
  </div>;
}

export default function InstanceSettingsLoading() {
  return <main className={styles.page}>
    <nav aria-hidden="true" className="mb-8 flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-2"><Skeleton width={32} height={32} /><Skeleton width={176} /></div>
      <div className="flex flex-wrap items-center gap-4">{[48, 96, 120, 80, 64].map(width => <Skeleton key={width} width={width} height={32} />)}</div>
    </nav>
    <Skeleton width={280} height={36} />
    <InstanceSettingsSkeleton />
  </main>;
}
