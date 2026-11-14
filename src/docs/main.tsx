import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Box,
  Check,
  ChevronRight,
  CircleHelp,
  Cloud,
  Code2,
  Compass,
  Crosshair,
  ExternalLink,
  FileBox,
  Focus,
  Keyboard,
  Layers3,
  Link2,
  Menu,
  Maximize2,
  Move3D,
  Paintbrush,
  Ruler,
  ScanLine,
  Search,
  Settings2,
  Shield,
  Sparkles,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { articleById, articles, groups, searchDocs } from './content';
import type { DocArticle, DocImage, DocSection } from './types';
import './styles.css';

const icons: Record<string, LucideIcon> = {
  bookopen: BookOpen,
  rocket: Sparkles,
  panelstopleft: Layers3,
  orbit: Compass,
  boxes: Layers3,
  workflow: Compass,
  scaneye: ScanLine,
  download: ArrowDownToLine,
  palette: Settings2,
  zap: Sparkles,
  headset: Compass,
  terminal: Code2,
  book: BookOpen,
  box: Box,
  compass: Compass,
  import: FileBox,
  navigation: Compass,
  parts: Layers3,
  move: Move3D,
  transform: Move3D,
  alignment: Crosshair,
  align: Crosshair,
  paint: Paintbrush,
  anchors: Focus,
  joint: Link2,
  joints: Link2,
  ruler: Ruler,
  measure: Ruler,
  inspection: ScanLine,
  export: ArrowDownToLine,
  save: FileBox,
  cloud: Cloud,
  drive: Cloud,
  settings: Settings2,
  keyboard: Keyboard,
  code: Code2,
  shield: Shield,
  help: CircleHelp,
};
function ArticleIcon({ article, size = 16 }: { article: DocArticle; size?: number }) {
  const Icon =
    icons[article.icon.toLowerCase()] ??
    (article.group === 'Build & assemble'
      ? Crosshair
      : article.group === 'Inspect & finish'
        ? ScanLine
        : BookOpen);
  return <Icon size={size} strokeWidth={1.6} aria-hidden="true" />;
}
const guideHref = (id: string) => `?guide=${encodeURIComponent(id)}`;
const currentGuide = () => new URLSearchParams(window.location.search).get('guide');

function Brand() {
  return (
    <a className="docs-brand" href="./" aria-label="Kitbasher documentation home">
      <svg width="28" height="32" viewBox="0 0 30 34" fill="none" aria-hidden="true">
        <path d="M15 1 28 8.5v16L15 32 2 24.5v-16L15 1Z" stroke="currentColor" strokeWidth="1.8" />
        <path d="m2 8.5 13 7.6 13-7.6M15 16v16" stroke="currentColor" strokeWidth="1.8" />
        <path d="m9 5.2 13 7.5v7.1l-7 4.1-7-4.1V12.7" stroke="currentColor" strokeWidth="1.8" />
      </svg>
      <span>
        kitbasher<span className="brand-period">.</span>
      </span>
    </a>
  );
}

function Figure({ figure, priority = false }: { figure: DocImage; priority?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [enlarged, setEnlarged] = useState(false);
  return (
    <figure className="docs-figure">
      <button
        type="button"
        className="figure-trigger"
        aria-label={`Enlarge image: ${figure.alt}`}
        onClick={() => {
          setEnlarged(true);
          dialog.current?.showModal();
        }}
      >
        <img
          src={figure.src}
          alt={figure.alt}
          width={1440}
          height={960}
          loading={priority ? 'eager' : 'lazy'}
        />
        <span className="figure-expand">
          <Maximize2 size={13} /> Enlarge image
        </span>
      </button>
      <figcaption>{figure.caption}</figcaption>
      <dialog
        ref={dialog}
        className="image-lightbox"
        aria-label="Enlarged image"
        onClose={() => setEnlarged(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.close();
        }}
      >
        <button
          type="button"
          className="image-lightbox-close"
          aria-label="Close image"
          onClick={() => dialog.current?.close()}
        >
          <X size={22} />
        </button>
        {enlarged && (
          <div className="image-lightbox-content">
            <img src={figure.src} alt={figure.alt} />
            <p className="image-lightbox-caption">{figure.caption}</p>
          </div>
        )}
      </dialog>
    </figure>
  );
}

function Section({ section }: { section: DocSection }) {
  return (
    <section className="article-section" id={section.id}>
      <h2>
        <a href={`#${section.id}`}>
          {section.title}
          <span aria-hidden="true">#</span>
        </a>
      </h2>
      {section.paragraphs?.map((paragraph, i) => (
        <p key={i}>{paragraph}</p>
      ))}
      {section.steps && (
        <ol className="article-steps">
          {section.steps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      )}
      {section.bullets && (
        <ul>
          {section.bullets.map((bullet, i) => (
            <li key={i}>{bullet}</li>
          ))}
        </ul>
      )}
      {section.table && (
        <div
          className="table-scroll"
          role="region"
          aria-label={`${section.title} reference table`}
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                {section.table.headers.map((header) => (
                  <th key={header} scope="col">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {section.table.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) =>
                    j === 0 ? (
                      <th key={j} scope="row">
                        {cell}
                      </th>
                    ) : (
                      <td key={j}>{cell}</td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {section.code && <CodeBlock code={section.code.value} language={section.code.language} />}
      {section.note && (
        <aside className={`article-note ${section.note.tone === 'warning' ? 'warning' : ''}`}>
          <span className="note-icon">
            {section.note.tone === 'warning' ? <Shield size={18} /> : <Sparkles size={18} />}
          </span>
          <div>
            <strong>{section.note.title}</strong>
            <p>{section.note.text}</p>
          </div>
        </aside>
      )}
      {section.image && <Figure figure={section.image} />}
    </section>
  );
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [status, setStatus] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setStatus('Copied');
    } catch {
      setStatus('Select the code to copy');
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus(''), 2500);
  };
  return (
    <div className="code-block">
      <div>
        <span>{language}</span>
        <button onClick={() => void copy()} aria-label="Copy code">
          {status === 'Copied' && <Check size={13} />}
          <span aria-live="polite">{status || 'Copy'}</span>
        </button>
      </div>
      <pre tabIndex={0}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function Navigation({ active, onNavigate }: { active: string | null; onNavigate?: () => void }) {
  return (
    <nav className="docs-nav" aria-label="Documentation">
      <a
        className={`nav-overview ${active === null ? 'active' : ''}`}
        href="./"
        aria-current={active === null ? 'page' : undefined}
        onClick={onNavigate}
      >
        <BookOpen size={16} /> Overview
      </a>
      {groups.map((group) => (
        <div className="nav-group" key={group}>
          <h2>{group}</h2>
          {articles
            .filter((article) => article.group === group)
            .map((article) => (
              <a
                key={article.id}
                href={guideHref(article.id)}
                className={active === article.id ? 'active' : ''}
                aria-current={active === article.id ? 'page' : undefined}
                onClick={onNavigate}
              >
                <ArticleIcon article={article} />
                <span>{article.title}</span>
              </a>
            ))}
        </div>
      ))}
      <a
        className="nav-feedback"
        href="https://github.com/nimerix/kitbasher/issues"
        target="_blank"
        rel="noopener noreferrer"
      >
        <CircleHelp size={15} /> Questions or feedback <ExternalLink size={12} />
      </a>
    </nav>
  );
}

function Home() {
  const paths = [
    {
      id: 'quick-start',
      number: '01',
      title: 'Build your first assembly',
      text: 'From your first selection to a saved, editable scene.',
      icon: Box,
    },
    {
      id: 'alignment',
      number: '02',
      title: 'Find the right fit',
      text: 'Match points, paint contact areas, and refine imperfect scans.',
      icon: Crosshair,
    },
    {
      id: 'export',
      number: '03',
      title: 'Take it to the next step',
      text: 'Prepare separate parts for a slicer, Blender, or another session.',
      icon: ArrowDownToLine,
    },
  ];
  return (
    <div className="docs-home">
      <div className="home-intro">
        <h1 tabIndex={-1}>
          Your workbench,
          <br />
          <span>explained.</span>
        </h1>
        <p>
          A practical guide to assembling multipart models.
          <br className="desktop-break" /> Learn the tools, get a precise fit, and bring your next
          build together.
        </p>
        <div className="home-actions">
          <a className="primary-link" href={guideHref('quick-start')}>
            Start your first assembly <ArrowRight size={16} />
          </a>
          <a className="text-link" href={guideHref('interface')}>
            Explore the workbench <ChevronRight size={15} />
          </a>
        </div>
      </div>
      <div className="home-workbench">
        <div className="image-titlebar">
          <span className="window-dots">
            <i />
            <i />
            <i />
          </span>
          <span>Scout · MK.04</span>
          <span>ASSEMBLY WORKBENCH</span>
        </div>
        <Figure
          priority
          figure={{
            src: './images/workbench.webp',
            alt: 'Kitbasher with the 15-part Scout robot in a 3D viewport, searchable parts on the left, assembly tools above, and the transform inspector on the right.',
            caption:
              'The workbench: your parts on the left, a real 3D canvas in the middle, and precise controls on the right.',
          }}
        />
      </div>
      <section className="home-section">
        <div className="section-heading">
          <h2>A good place to start</h2>
          <span>Learn by doing</span>
        </div>
        <div className="learning-paths">
          {paths.map(({ id, number, title, text, icon: Icon }) => (
            <a href={guideHref(id)} key={id}>
              <div className="path-top">
                <Icon size={21} strokeWidth={1.5} />
                <span>{number}</span>
              </div>
              <h3>{title}</h3>
              <p>{text}</p>
              <span className="path-arrow">
                <ArrowRight size={17} />
              </span>
            </a>
          ))}
        </div>
      </section>
      <section className="home-section">
        <div className="section-heading">
          <h2>The right tool for every join</h2>
          <a href={guideHref('workflows')}>
            See assembly workflows <ArrowRight size={14} />
          </a>
        </div>
        <p className="section-description">
          Start with a rough placement. Refine with the geometry you have.
        </p>
        <div className="tool-directory">
          {['transforms', 'alignment', 'contact-paint', 'flush-fit', 'anchors', 'planes'].map(
            (id) => {
              const article = articleById.get(id);
              return article ? (
                <a key={id} href={guideHref(id)}>
                  <span className="directory-icon">
                    <ArticleIcon article={article} size={20} />
                  </span>
                  <div>
                    <h3>{article.title}</h3>
                    <p>{article.description}</p>
                  </div>
                  <ChevronRight size={15} />
                </a>
              ) : null;
            },
          )}
        </div>
      </section>
      <section className="home-bottom">
        <div>
          <Keyboard size={23} strokeWidth={1.5} />
          <h2>Less clicking. More building.</h2>
          <p>Find every default key, pointer gesture, and custom binding.</p>
          <a href={guideHref('keyboard-shortcuts')}>
            Keyboard & mouse reference <ArrowRight size={14} />
          </a>
        </div>
        <div>
          <Cloud size={23} strokeWidth={1.5} />
          <h2>Keep your work close.</h2>
          <p>Save editable scenes locally, or connect Drive for automatic saves.</p>
          <a href={guideHref('saving')}>
            Saving & recovery <ArrowRight size={14} />
          </a>
        </div>
      </section>
    </div>
  );
}

function Article({ article }: { article: DocArticle }) {
  const index = articles.indexOf(article);
  const previous = articles[index - 1],
    next = articles[index + 1];
  return (
    <>
      <article className="docs-article">
        <div className="breadcrumbs">
          <a href="./">Docs</a>
          <ChevronRight size={12} />
          <span>{article.group}</span>
        </div>
        <h1 tabIndex={-1}>{article.title}</h1>
        <p className="article-description">{article.description}</p>
        <p className="article-intro">{article.intro}</p>
        {article.image && <Figure figure={article.image} priority />}
        <details className="mobile-toc">
          <summary>On this page</summary>
          {article.sections.map((section) => (
            <a href={`#${section.id}`} key={section.id}>
              {section.title}
            </a>
          ))}
        </details>
        {article.sections.map((section) => (
          <Section section={section} key={section.id} />
        ))}
        {article.related.length > 0 && (
          <section className="related-guides">
            <h2>Keep exploring</h2>
            <div>
              {article.related.map((id) => {
                const related = articleById.get(id);
                return related ? (
                  <a href={guideHref(id)} key={id}>
                    <ArticleIcon article={related} />
                    <span>{related.title}</span>
                    <ArrowRight size={14} />
                  </a>
                ) : null;
              })}
            </div>
          </section>
        )}
        <nav className="article-pagination" aria-label="Adjacent guides">
          {previous ? (
            <a href={guideHref(previous.id)}>
              <span>
                <ArrowLeft size={13} /> Previous
              </span>
              <strong>{previous.title}</strong>
            </a>
          ) : (
            <span />
          )}
          {next && (
            <a href={guideHref(next.id)}>
              <span>
                Next <ArrowRight size={13} />
              </span>
              <strong>{next.title}</strong>
            </a>
          )}
        </nav>
      </article>
      <aside className="docs-toc" aria-label="On this page">
        <span>On this page</span>
        <nav>
          {article.sections.map((section) => (
            <a href={`#${section.id}`} key={section.id}>
              {section.title}
            </a>
          ))}
        </nav>
        <a
          className="toc-source"
          href="https://github.com/nimerix/kitbasher/issues"
          target="_blank"
          rel="noopener noreferrer"
        >
          Suggest an improvement <ExternalLink size={12} />
        </a>
      </aside>
    </>
  );
}

function SearchDialog({
  dialog,
  onNavigate,
}: {
  dialog: React.RefObject<HTMLDialogElement | null>;
  onNavigate: () => void;
}) {
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const results = searchDocs(query);
  const suggestions = ['quick-start', 'alignment', 'google-drive', 'keyboard-shortcuts'];
  useEffect(() => {
    const element = dialog.current;
    const reset = () => setQuery('');
    element?.addEventListener('close', reset);
    return () => element?.removeEventListener('close', reset);
  }, [dialog]);
  return (
    <dialog
      ref={dialog}
      className="search-dialog"
      aria-label="Search documentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) e.currentTarget.close();
      }}
    >
      <div className="search-input-row">
        <Search size={19} />
        <input
          ref={input}
          autoFocus
          aria-label="Search documentation"
          placeholder="Search tools, workflows, and shortcuts…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              dialog.current?.querySelector<HTMLAnchorElement>('.search-result')?.focus();
            }
            if (e.key === 'Enter' && results[0]) {
              dialog.current?.querySelector<HTMLAnchorElement>('.search-result')?.click();
            }
          }}
        />
        <button aria-label="Close search" onClick={() => dialog.current?.close()}>
          <X size={18} />
        </button>
      </div>
      <div className="search-results">
        <p className="search-caption" role="status">
          {!query.trim()
            ? 'Popular guides'
            : results.length
              ? `${results.length} ${results.length === 1 ? 'guide' : 'guides'} found`
              : 'No matching guides'}
        </p>
        {query.trim()
          ? results.map(({ article, snippet }) => (
              <a
                className="search-result"
                key={article.id}
                href={guideHref(article.id)}
                onClick={onNavigate}
              >
                <ArticleIcon article={article} size={19} />
                <div>
                  <span>{article.group}</span>
                  <strong>{article.title}</strong>
                  <p>{snippet}</p>
                </div>
                <ArrowRight size={15} />
              </a>
            ))
          : suggestions.map((id) => {
              const article = articleById.get(id)!;
              return (
                <a className="search-result" href={guideHref(id)} key={id} onClick={onNavigate}>
                  <ArticleIcon article={article} size={18} />
                  <div>
                    <span>{article.group}</span>
                    <strong>{article.title}</strong>
                    <p>{article.description}</p>
                  </div>
                  <ArrowRight size={15} />
                </a>
              );
            })}
        {query.trim() && !results.length && (
          <div className="search-empty">
            <Search size={25} />
            <p>
              Try a tool name such as “anchors”, a file type such as “STL”, or a task such as
              “save”.
            </p>
            <button
              onClick={() => {
                setQuery('');
                input.current?.focus();
              }}
            >
              Clear search
            </button>
          </div>
        )}
      </div>
      <div className="search-footer">
        <span>
          <kbd>↓</kbd> Move to results
        </span>
        <span>
          <kbd>esc</kbd> Close
        </span>
      </div>
    </dialog>
  );
}

function App() {
  const [guide, setGuide] = useState(currentGuide);
  const search = useRef<HTMLDialogElement>(null),
    mobile = useRef<HTMLDialogElement>(null);
  const article = guide ? articleById.get(guide) : undefined;
  const closeDialogs = () => {
    search.current?.close();
    mobile.current?.close();
  };
  useEffect(() => {
    const update = () => {
      setGuide(currentGuide());
      closeDialogs();
      requestAnimationFrame(() => {
        const section = document.getElementById(location.hash.slice(1));
        if (section) section.scrollIntoView();
        else window.scrollTo(0, 0);
      });
    };
    window.addEventListener('popstate', update);
    const click = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const target = (event.target as Element).closest<HTMLAnchorElement>('a');
      if (!target || target.target || target.hasAttribute('download')) return;
      const url = new URL(target.href);
      if (url.origin !== location.origin || url.pathname !== location.pathname || url.hash) return;
      event.preventDefault();
      history.pushState(null, '', url);
      update();
      requestAnimationFrame(() =>
        document.querySelector<HTMLHeadingElement>('main h1')?.focus({ preventScroll: true }),
      );
    };
    const keys = (event: KeyboardEvent) => {
      const editable = (event.target as HTMLElement).matches(
        'input, textarea, select, [contenteditable="true"]',
      );
      if (
        (!editable && event.key === '/') ||
        ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k')
      ) {
        event.preventDefault();
        if (!search.current?.open) {
          mobile.current?.close();
          search.current?.showModal();
        }
      }
    };
    document.addEventListener('click', click);
    document.addEventListener('keydown', keys);
    return () => {
      window.removeEventListener('popstate', update);
      document.removeEventListener('click', click);
      document.removeEventListener('keydown', keys);
    };
  }, []);
  useEffect(() => {
    document.title = `${article?.title ?? (guide ? 'Guide not found' : 'Your workbench, explained')} · Kitbasher Docs`;
    const sidebar = document.querySelector<HTMLElement>('.docs-sidebar');
    const active = sidebar?.querySelector<HTMLElement>('[aria-current="page"]');
    if (sidebar && active) {
      if (active.offsetTop < sidebar.scrollTop) sidebar.scrollTop = active.offsetTop - 20;
      else if (active.offsetTop + active.offsetHeight > sidebar.scrollTop + sidebar.clientHeight)
        sidebar.scrollTop = active.offsetTop + active.offsetHeight - sidebar.clientHeight + 20;
    }
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute(
        'content',
        article?.description ??
          'The illustrated Kitbasher manual. Learn every tool and build your next assembly.',
      );
    if (location.hash)
      requestAnimationFrame(() =>
        document.getElementById(location.hash.slice(1))?.scrollIntoView(),
      );
  }, [article, guide]);
  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="docs-header">
        <button
          className="mobile-menu"
          aria-label="Open documentation navigation"
          onClick={() => mobile.current?.showModal()}
        >
          <Menu size={21} />
        </button>
        <Brand />
        <a href="./" className="docs-label">
          Docs
        </a>
        <button
          className="header-search"
          aria-label="Search documentation"
          onClick={() => search.current?.showModal()}
        >
          <Search size={15} />
          <span>Search documentation…</span>
          <kbd>⌘ / Ctrl K</kbd>
        </button>
        <a
          className="header-github"
          href="https://github.com/nimerix/kitbasher"
          target="_blank"
          rel="noopener noreferrer"
        >
          GitHub <ExternalLink size={12} />
        </a>
        <a className="open-workbench" href="../">
          Open workbench <ArrowUpRight />
        </a>
      </header>
      <aside className="docs-sidebar">
        <button className="sidebar-search" onClick={() => search.current?.showModal()}>
          <Search size={15} />
          <span>Search the docs</span>
          <kbd>/</kbd>
        </button>
        <Navigation active={guide} />
      </aside>
      <main id="main-content" className={`docs-main ${guide ? 'has-article' : ''}`}>
        {article ? (
          <Article article={article} />
        ) : guide ? (
          <div className="not-found">
            <CircleHelp size={32} />
            <h1 tabIndex={-1}>This guide isn’t here.</h1>
            <p>Find what you need in the sidebar, or search the documentation.</p>
            <a className="primary-link" href="./">
              Back to the overview <ArrowLeft size={15} />
            </a>
          </div>
        ) : (
          <Home />
        )}
        <footer className="docs-footer">
          <span>Made for your next assembly.</span>
          <div>
            <a href="../privacy.html">Privacy</a>
            <a
              href="https://github.com/nimerix/kitbasher/blob/main/LICENSE"
              target="_blank"
              rel="noopener noreferrer"
            >
              MIT License
            </a>
            <span>Kitbasher · Michael Pearce</span>
          </div>
        </footer>
      </main>
      <SearchDialog dialog={search} onNavigate={closeDialogs} />
      <dialog className="mobile-navigation" ref={mobile} aria-label="Documentation navigation">
        <div className="mobile-navigation-header">
          <Brand />
          <button aria-label="Close navigation" onClick={() => mobile.current?.close()}>
            <X size={20} />
          </button>
        </div>
        <Navigation active={guide} onNavigate={closeDialogs} />
      </dialog>
    </>
  );
}
function ArrowUpRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4 12 12 4M4 4h8v8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
