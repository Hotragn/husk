import { HUSK_VERSION, LICENCE, REPO_URL, WEB_URL } from '@/lib/site';

export function Footer() {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <span>Husk {HUSK_VERSION}</span>
        <span>{LICENCE}</span>
        <a href={WEB_URL}>Husk home</a>
        <a href={REPO_URL} rel="noreferrer noopener" target="_blank">
          Source
        </a>
        <span>
          These docs use Vercel Web Analytics and serve fonts locally.
          The installed Husk runtime has no product telemetry.
        </span>
      </div>
    </footer>
  );
}
