import styles from '@/components/documentation-skeleton.module.css';

function Block({ width = '100%', height = 18, pill = false }: { width?: number | string; height?: number; pill?: boolean }) {
  return <div style={{ width, height, maxWidth: '100%', borderRadius: pill ? 9999 : 6, backgroundColor: 'rgba(128, 128, 128, 0.35)' }} className="animate-pulse motion-reduce:animate-none" />;
}

function Paragraph() {
  return <div className={styles.rows}><Block /><Block width="92%" /><Block width="75%" /></div>;
}

export default function DocumentationSkeleton() {
  return <main role="status" aria-label="Loading documentation" aria-busy="true">
    <span className="sr-only">Loading documentation…</span>
    <div aria-hidden="true" className={styles.layout}>
      <header className={styles.mobileHeader}><Block width={32} height={32} /><Block width={176} /><Block width={32} height={32} /></header>
      <aside className={styles.sidebar}>
        <div className={styles.brand}><Block width={32} height={32} /><Block width={160} /></div>
        <div className={styles.rows}><Block height={36} /><Block height={40} /></div>
        <div className={styles.rows}>
          {[0, 1, 2, 3, 4, 5, 6].map(row => <div key={row} style={{ paddingLeft: row > 1 && row < 5 ? 16 : 0 }}><Block width={row % 2 ? '85%' : '95%'} height={24} /></div>)}
        </div>
        <div className={styles.controls}><Block width={36} height={36} pill /><Block width={64} height={36} pill /><Block width={36} height={36} pill /></div>
      </aside>
      <article className={styles.article}>
        <div className={styles.rows}><Block width="80%" height={36} /><Block width="95%" height={24} /><Block width="65%" height={24} /></div>
        <section className={styles.section}><Paragraph /></section>
        <section className={styles.section + ' ' + styles.cards}>
          {[0, 1, 2].map(card => <div key={card} className={styles.card}><Block width={32} height={32} /><Block width="70%" height={22} /><Paragraph /></div>)}
        </section>
        <section className={styles.section}>
          <Block width="45%" height={28} />
          <div className={styles.section}><Paragraph /></div>
          <div className={styles.section} style={{ border: '1px solid var(--color-fd-border)', borderRadius: 12, padding: 20 }}><Paragraph /></div>
        </section>
      </article>
      <aside className={styles.toc}>
        <div className={styles.rows}><Block width={128} height={20} />{[0, 1, 2, 3, 4].map(row => <div key={row} style={{ paddingLeft: row === 2 || row === 3 ? 16 : 0 }}><Block width={row % 2 ? '65%' : '85%'} /></div>)}</div>
      </aside>
    </div>
  </main>;
}
