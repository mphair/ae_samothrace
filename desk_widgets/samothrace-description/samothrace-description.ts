// Samothrace Monument Description -- shows the description text (and
// inline images) for whichever monument is currently selected in the
// "Samothrace Map" widget, via Desk's shared, project-scoped state. The
// two widgets never talk to each other directly.
//
// Text files under Data/mapDescriptions use a plain-text convention (see
// ./Data/mapCode for the structure this mirrors -- no code from there is
// reused, only the file's own line-format convention, re-derived here by
// inspecting the real .txt files):
//   - lines are separated by CR, LF, or CRLF
//   - a line starting with "<Code>: " tags that line (Monument, Date,
//     Material, Location, Header, Subheader, Part, Caption, Title, ...)
//   - a line containing "Bibliography:" (however it's introduced) starts
//     the bibliography section; every plain paragraph after it is a
//     citation
//   - lines mentioning "Glennon" or "JAG_UNEDITED" are internal editorial
//     notes and are dropped entirely, never shown
//   - each "Caption:" line pairs, in order, with
//     SamoWebsite_<webCode>_Image<n>.jpg (n = 1, 2, 3, ... in the order
//     Caption lines appear)

interface Window {
  desk?: {
    self: {
      setSubtitle(text: string | null): Promise<{ ok: boolean }>;
    };
    fs: {
      readFile(path: string): Promise<{ contents: string }>;
    };
    documents: {
      open(path: string): Promise<{ handle: string }>;
      read(handle: string, opts: { offset: number; length: number }): Promise<{ data: string; eof: boolean }>;
      close(handle: string): Promise<{ closed: boolean }>;
    };
    state: {
      get(key: string): Promise<{ value: unknown; edit: unknown }>;
    };
    events: {
      subscribe(names: string[]): Promise<{ ok: boolean }>;
      onMessage(callback: (name: string, payload: unknown, senderInstanceId: string) => void): void;
    };
  };
}

const STATE_KEY = 'samothrace.selectedMonument';

interface SelectedMonument {
  webCode: string;
  label: string;
  name: string;
  plan: string;
}

function isSelectedMonument(v: unknown): v is SelectedMonument {
  return !!v && typeof v === 'object' && typeof (v as any).webCode === 'string';
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return s.replace(/[&<>"']/g, (c) => map[c] ?? c);
}

// ── Parsing the description .txt format ──

interface DescLine {
  code: string | null; // null = a plain paragraph line
  text: string;
}

function splitLines(raw: string): string[] {
  return raw.split(/\r\n|\r|\n/);
}

function parseDescriptionLines(raw: string): DescLine[] {
  const out: DescLine[] = [];
  for (const rawLine of splitLines(raw)) {
    if (rawLine.includes('Glennon') || rawLine.includes('JAG_UNEDITED')) continue; // internal editorial notes
    const line = rawLine.trim();
    if (!line) continue; // blank lines are just paragraph separators; spacing is handled by CSS
    const firstToken = line.split(' ')[0] ?? '';
    if (firstToken.endsWith(':')) {
      const code = firstToken.slice(0, -1);
      out.push({ code, text: line.slice(firstToken.length).trim() });
    } else {
      out.push({ code: null, text: line });
    }
  }
  return out;
}

const HEADING_CODES: Record<string, string> = { Title: 'h1', Monument: 'h1', Header: 'h2', Subheader: 'h3', Part: 'h4' };
const META_CODES = new Set(['Date', 'Material', 'Location']);

function renderDescriptionHtml(lines: DescLine[], imageDataUris: Record<number, string | null>): string {
  const parts: string[] = [];
  let captionIndex = 0;
  let inBibliography = false;

  for (const line of lines) {
    const rawHasBibliographyMarker = line.text.includes('Bibliography:') || (line.code ?? '').includes('Bibliography');
    if (rawHasBibliographyMarker && !inBibliography) {
      inBibliography = true;
      parts.push('<h2 class="bib-heading">Selected Bibliography</h2>');
      continue;
    }

    if (line.code && HEADING_CODES[line.code]) {
      const tag = HEADING_CODES[line.code];
      parts.push(`<${tag} class="field-${line.code.toLowerCase()}">${escapeHtml(line.text)}</${tag}>`);
    } else if (line.code && META_CODES.has(line.code)) {
      parts.push(`<p class="meta-line"><strong>${escapeHtml(line.code)}:</strong> ${escapeHtml(line.text)}</p>`);
    } else if (line.code === 'Caption') {
      captionIndex += 1;
      const uri = imageDataUris[captionIndex];
      const img = uri ? `<img src="${uri}" alt="${escapeHtml(line.text || 'Figure ' + captionIndex)}" />` : '';
      const caption = line.text ? `<figcaption>${escapeHtml(line.text)}</figcaption>` : '';
      parts.push(`<figure class="figure">${img}${caption}</figure>`);
    } else if (line.code === null) {
      const cls = inBibliography ? 'bib-entry' : 'paragraph';
      parts.push(`<p class="${cls}">${escapeHtml(line.text)}</p>`);
    } else {
      // An unrecognized code -- render defensively rather than dropping data.
      parts.push(`<p class="paragraph"><strong>${escapeHtml(line.code)}:</strong> ${escapeHtml(line.text)}</p>`);
    }
  }
  return parts.join('\n');
}

function countCaptions(lines: DescLine[]): number {
  return lines.filter((l) => l.code === 'Caption').length;
}

// ── Fetching binary images via the documents capability ──

async function fetchImageDataUri(path: string): Promise<string | null> {
  const desk = window.desk;
  if (!desk) return null;
  let handle: string | null = null;
  try {
    handle = (await desk.documents.open(path)).handle;
    const { data, eof } = await desk.documents.read(handle, { offset: 0, length: 8 * 1024 * 1024 });
    if (!data || !eof) return null; // every description image here is well under 8 MiB
    return `data:image/jpeg;base64,${data}`;
  } catch {
    return null;
  } finally {
    if (handle) desk.documents.close(handle).catch(() => {});
  }
}

interface RenderedEntry {
  html: string;
  subtitle: string;
}

const renderCache = new Map<string, Promise<RenderedEntry>>();

async function buildDescription(webCode: string, name: string): Promise<RenderedEntry> {
  const desk = window.desk;
  if (!desk) throw new Error('Desk bridge unavailable');
  const dir = `Data/mapDescriptions/${webCode}`;
  const { contents } = await desk.fs.readFile(`${dir}/SamoWebsite_${webCode}.txt`);
  const lines = parseDescriptionLines(contents);
  const captionCount = countCaptions(lines);

  const images: Record<number, string | null> = {};
  await Promise.all(
    Array.from({ length: captionCount }, (_, i) => i + 1).map(async (n) => {
      images[n] = await fetchImageDataUri(`${dir}/SamoWebsite_${webCode}_Image${n}.jpg`);
    }),
  );

  return { html: renderDescriptionHtml(lines, images), subtitle: name || webCode };
}

function loadDescription(webCode: string, name: string): Promise<RenderedEntry> {
  let cached = renderCache.get(webCode);
  if (!cached) {
    cached = buildDescription(webCode, name);
    renderCache.set(webCode, cached);
  }
  return cached;
}

// ── Element ──

class SamothraceDescriptionElement extends HTMLElement {
  private contentEl: HTMLElement | null = null;
  private placeholderEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;

  connectedCallback(): void {
    const template = document.getElementById('samothrace-description-template');
    if (!(template instanceof HTMLTemplateElement)) {
      throw new Error('samothrace-description-template not found');
    }
    const shadow = this.attachShadow({ mode: 'open' });
    shadow.appendChild(template.content.cloneNode(true));

    this.contentEl = shadow.querySelector('.content');
    this.placeholderEl = shadow.querySelector('.placeholder');
    this.statusEl = shadow.querySelector('.status-overlay');

    void this.init();
  }

  private setStatus(text: string | null): void {
    if (!this.statusEl) return;
    if (text) {
      this.statusEl.textContent = text;
      (this.statusEl as HTMLElement).style.display = 'flex';
    } else {
      (this.statusEl as HTMLElement).style.display = 'none';
    }
  }

  private async init(): Promise<void> {
    const desk = window.desk;
    if (!desk) {
      this.setStatus('Desk bridge unavailable');
      return;
    }
    try {
      await desk.events.subscribe(['desk.state.changed']);
    } catch {
      // Live updates won't arrive, but the initial state.get below still works.
    }
    desk.events.onMessage((name, payload) => {
      if (name !== 'desk.state.changed') return;
      const p = payload as { key?: string; value?: unknown };
      if (p?.key === STATE_KEY) void this.show(isSelectedMonument(p.value) ? p.value : null);
    });

    try {
      const { value } = await desk.state.get(STATE_KEY);
      await this.show(isSelectedMonument(value) ? value : null);
    } catch (err) {
      this.setStatus(`Failed to load selection: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async show(selection: SelectedMonument | null): Promise<void> {
    if (!selection || !selection.webCode) {
      if (this.contentEl) this.contentEl.innerHTML = '';
      if (this.placeholderEl) (this.placeholderEl as HTMLElement).style.display = 'flex';
      void window.desk?.self.setSubtitle(null);
      this.setStatus(null);
      return;
    }

    if (this.placeholderEl) (this.placeholderEl as HTMLElement).style.display = 'none';
    this.setStatus('Loading…');
    try {
      const entry = await loadDescription(selection.webCode, selection.name);
      if (this.contentEl) {
        this.contentEl.innerHTML = entry.html;
        this.contentEl.scrollTop = 0;
      }
      void window.desk?.self.setSubtitle(entry.subtitle);
      this.setStatus(null);
    } catch (err) {
      this.setStatus(`Failed to load description: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

customElements.define('samothrace-description', SamothraceDescriptionElement);
