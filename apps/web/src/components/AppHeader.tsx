import { t } from '../lib/i18n/index';

export function AppHeader(props: {
  current?: string;
  goHome: () => void;
  openConnections: () => void;
  openGear: () => void;
  openSettings: () => void;
  signOut: () => void;
}) {
  const { current, goHome, openConnections, openGear, openSettings, signOut } = props;
  const active = (name: string) => (current === name ? 'active' : undefined);

  return (
    <header>
      <a
        className="brand"
        href="/"
        title={t('nav.brandTitle')}
        onClick={(e) => {
          e.preventDefault();
          goHome();
        }}
      >
        <h1>🦾 Stridash</h1>
      </a>
      <nav className="header-nav" aria-label="Primary">
        <a
          href="/connections"
          className={active('connections')}
          aria-current={current === 'connections' ? 'page' : undefined}
          onClick={(e) => {
            e.preventDefault();
            openConnections();
          }}
        >
          {t('nav.providers')}
        </a>
        <a
          href="/gear"
          className={active('gear')}
          aria-current={current === 'gear' ? 'page' : undefined}
          onClick={(e) => {
            e.preventDefault();
            openGear();
          }}
        >
          {t('nav.gear')}
        </a>
        <a
          href="/settings"
          className={active('settings')}
          aria-current={current === 'settings' ? 'page' : undefined}
          onClick={(e) => {
            e.preventDefault();
            openSettings();
          }}
        >
          {t('nav.settings')}
        </a>
        <button type="button" className="btn ghost small" onClick={signOut}>
          {t('nav.signOut')}
        </button>
      </nav>
    </header>
  );
}
