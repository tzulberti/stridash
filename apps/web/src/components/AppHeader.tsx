import { useEffect, useState } from 'react';
import { t } from '../lib/i18n/index';

export function AppHeader(props: {
  goHome: () => void;
  openConnections: () => void;
  openGear: () => void;
  openSettings: () => void;
  signOut: () => void;
}) {
  const { goHome, openConnections, openGear, openSettings, signOut } = props;
  const [menuOpen, setMenuOpen] = useState(false);

  // hamburger menu: any click outside of it closes it
  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      const wrap = document.querySelector('.menu-wrap');
      if (wrap && !wrap.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [menuOpen]);

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
      <div className="menu-wrap">
        <button
          type="button"
          className="hamburger"
          aria-label={t('nav.menu')}
          aria-expanded={menuOpen}
          onClick={(e) => {
            e.stopPropagation(); // the outside-click listener would re-close it
            setMenuOpen((v) => !v);
          }}
        >
          ☰
        </button>
        {menuOpen && (
          <nav className="menu">
            <a
              href="/connections"
              onClick={(e) => {
                e.preventDefault();
                openConnections();
                setMenuOpen(false);
              }}
            >
              {t('nav.providers')}
            </a>
            <a
              href="/gear"
              onClick={(e) => {
                e.preventDefault();
                openGear();
                setMenuOpen(false);
              }}
            >
              {t('nav.gear')}
            </a>
            <a
              href="/settings"
              onClick={(e) => {
                e.preventDefault();
                openSettings();
                setMenuOpen(false);
              }}
            >
              {t('nav.settings')}
            </a>
            <button type="button" className="danger" onClick={signOut}>
              {t('nav.signOut')}
            </button>
          </nav>
        )}
      </div>
    </header>
  );
}
