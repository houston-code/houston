// The header and footer every generated page shares (build-legal.mjs, build-docs.mjs).
// The hand-written pages (index.html, 404.html, contact.html) repeat the same markup;
// change them together.

export const escapeHtml = (s) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// `current` marks the matching nav link with aria-current ("docs" on the docs pages).
export function siteHeader({ current } = {}) {
  const docsCurrent = current === "docs" ? ' aria-current="page"' : "";
  return `<header class="site-header">
    <div class="wrap">
      <a class="brand" href="/" aria-label="Houston home">
        <img src="/assets/icon-60.png" alt="" width="30" height="30" />
        <span>Houston</span>
        <span class="beta-badge">Beta</span>
      </a>
      <nav class="nav" aria-label="Primary">
        <a class="nav-link" href="/#why">Security</a>
        <a class="nav-link" href="/#features">Features</a>
        <a class="nav-link" href="/docs/"${docsCurrent}>Docs</a>
        <a class="nav-link" href="/#faq">FAQ</a>
        <a class="nav-link" href="https://github.com/houston-code/houston" rel="noopener">GitHub</a>
        <button class="theme-toggle" id="theme-toggle" type="button" aria-label="Dark theme" aria-pressed="false" hidden>
          <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>
          <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
        </button>
        <a class="btn btn-primary btn-sm" href="/#download">Download</a>
      </nav>
    </div>
  </header>`;
}

export const SITE_FOOTER = `<footer class="site-footer">
    <div class="wrap">
      <div class="footer-grid">
        <div class="footer-brand">
          <a class="brand" href="/" aria-label="Houston home">
            <img src="/assets/icon-60.png" alt="" width="30" height="30" />
            <span>Houston</span>
          </a>
          <p>A cross-platform coding agent. Bring your own model.</p>
        </div>
        <nav class="footer-col" aria-labelledby="footer-product">
          <h2 id="footer-product">Product</h2>
          <ul>
            <li><a href="/#features">Features</a></li>
            <li><a href="/#download">Download</a></li>
            <li><a href="/docs/">Docs</a></li>
            <li><a href="/#faq">FAQ</a></li>
            <li><a href="https://github.com/houston-code/houston/releases" rel="noopener">Releases</a></li>
          </ul>
        </nav>
        <nav class="footer-col" aria-labelledby="footer-project">
          <h2 id="footer-project">Project</h2>
          <ul>
            <li><a href="https://github.com/houston-code/houston" rel="noopener">GitHub</a></li>
            <li><a href="https://github.com/houston-code/houston/issues" rel="noopener">Report an issue</a></li>
            <li><a href="https://github.com/houston-code/houston/blob/main/CONTRIBUTING.md" rel="noopener">Contributing</a></li>
            <li><a href="https://github.com/houston-code/houston/blob/main/SECURITY.md" rel="noopener">Security policy</a></li>
            <li><a href="/contact">Contact</a></li>
          </ul>
        </nav>
        <nav class="footer-col" aria-labelledby="footer-legal">
          <h2 id="footer-legal">Legal</h2>
          <ul>
            <li><a href="/privacy">Privacy</a></li>
            <li><a href="https://github.com/houston-code/houston/blob/main/LICENSE" rel="noopener">License (Apache-2.0)</a></li>
            <li><a href="https://github.com/houston-code/houston/blob/main/TRADEMARK.md" rel="noopener">Trademark policy</a></li>
          </ul>
        </nav>
      </div>
      <div class="footer-bottom">
        <span>© <span id="year">2026</span> The Houston Authors</span>
      </div>
    </div>
  </footer>`;
