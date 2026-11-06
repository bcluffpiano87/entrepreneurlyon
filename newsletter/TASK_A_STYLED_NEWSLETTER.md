# Task: Dynamic Styled Newsletter + Public Route

## Objective

Transform the newsletter assembly endpoint in `worker.js` from its current basic styled output into a dynamic, premium newsletter page. Also add a public `/newsletter` route so the newsletter can be published at `entrepreneurlyon.fr/newsletter`.

## Files to read before starting

- `worker.js` -- the full file (1170 lines). The newsletter logic starts at `handleNewsletterAssemble` (line ~893). Read the entire file to understand the routing, helpers, and patterns.
- `styles.css` -- for the site's brand design language
- `newsletter/research_nodes/frontend-specialist.mdc` -- follow these working constraints

## What exists now

The function `handleNewsletterAssemble` (line ~893) fetches newsletter sections from Airtable and renders them as styled HTML with basic CSS. It works correctly -- your job is to upgrade the visual design while keeping all the data-fetching and section assembly logic intact.

Current helpers you must keep unchanged:
- `fetchNewsletterSectionsForIssue` (line ~1086) -- paginated Airtable fetch
- `renderMarkdown` (line ~1122) -- markdown to HTML converter
- `escapeHtml` (line ~885) -- XSS protection
- `sectionBody()` and `includeOptional()` -- defined inside `handleNewsletterAssemble`
- `RECORD_ID_PATTERN` (line 36) -- record ID validation regex

## The newsletter structure (9 sections)

| # | Heading | Content type | Design treatment |
|---|---|---|---|
| 1 | None (opening blurb) | Intro text + Quote of the Month | White card, 18px font, pull quote with left border at end |
| 2 | "Events" | New events + prior month recap photos | Kicker "02 Events", date-styled rows, photo grid (3-up square thumbnails for recap) |
| 3 | Dynamic (from `topicHeading` variable) | Guest article, longest section | **Dark band card** (#1a1a1a bg, white text), 16:9 hero image slot, guest byline area |
| 4 | "Partners" | 3 partner blocks | 3-column grid on desktop, stacks on mobile. Only shown if `includeOptional(4)` returns true |
| 5 | "Entrepreneur Highlights" | Member profiles | Avatar placeholder (round) + name/role cards |
| 6 | "Entrepreneur Need to Know" | Money, tax, regulations | Tinted fact box (#f5f5f5 bg), bullet points with bolded figures |
| 7 | "Agencies" | Agency descriptions | Compact list. Only shown if `includeOptional(7)` returns true |
| 8 | "Free Coworking" | Coworking spot recommendation | 3:2 photo slot, name, neighbourhood, address/hours as meta |
| 9 | "Community Events" | Events in other channels | Compact event rows |

## Design system

### Brand tokens

| Token | Value | Use |
|---|---|---|
| ink | `#1a1a1a` | text, buttons, dark band background |
| canvas | `#f5f5f5` | page background, fact boxes, chips |
| card | `#ffffff` | section cards |
| muted | `#666` / `#888` / `#999` | meta text, kickers |
| line | `#eeeeee` | inner rules, borders |

### Typography

- Font stack: `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif` (matches site)
- Masthead: 32px desktop, 28px mobile, weight 800
- Section headings (H2): 24px
- Body: 17px, line-height 1.6
- Meta/kicker: 12-13px uppercase, letter-spacing 0.08em
- Pull quote: 20px italic

### Shape and spacing

- Card border-radius: 12px
- Inner media border-radius: 10px
- Pill buttons: border-radius 999px
- Spacing scale: 8, 16, 24, 32px
- Cards separated by 16px gaps (grey canvas shows between them)
- Max-width: 640px centered
- Card padding: 28px desktop, 20px mobile

## Key design features to implement

### 1. Section kicker numbers

Each section gets a small numbered kicker above its heading:

```html
<p class="kicker"><b>02</b> Events</p>
<h2>Events</h2>
```

```css
.kicker { font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: #888; margin: 0 0 6px; }
.kicker b { color: #1a1a1a; margin-right: 6px; }
```

Section 1 (opening) does NOT get a kicker. It is unnumbered.

### 2. Separate cards per section (not one big card)

Instead of wrapping all sections in a single `.nl-card`, each section becomes its own white card separated by 16px of grey canvas. The exception is the dark band card for section 3.

### 3. Sticky navigation pill bar

Under the masthead (header with "Entrepreneur Lyon" and the month), add a sticky navigation bar with pills linking to each section:

```html
<nav class="nav" id="top">
  <a href="#events">Events</a>
  <a href="#topic">Topic</a>
  <a href="#highlights">Highlights</a>
  <a href="#need-to-know">Need to Know</a>
  <a href="#coworking">Coworking</a>
  <a href="#community">Community</a>
</nav>
```

Only include pills for sections that are present (skip Partners and Agencies if `includeOptional` returns false).

```css
html { scroll-behavior: smooth; scroll-padding-top: 64px; }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
.nav { position: sticky; top: 0; z-index: 10; background: rgba(245,245,245,.85);
       backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
       display: flex; gap: 6px; overflow-x: auto; padding: 10px 16px;
       scrollbar-width: none; scroll-snap-type: x proximity; max-width: 640px; margin: 0 auto; }
.nav::-webkit-scrollbar { display: none; }
.nav a { flex: none; scroll-snap-align: start; padding: 7px 12px; border-radius: 999px;
         background: #fff; color: #1a1a1a; font-size: 13px; font-weight: 600; text-decoration: none;
         white-space: nowrap; }
.nav a:hover { background: #1a1a1a; color: #fff; }
```

Each section card gets a matching `id` attribute for the anchor links.

### 4. Dark band for Topic of the Month (section 3)

Section 3 gets an inverted color scheme:

```css
.card--dark { background: #1a1a1a; color: #fff; border-radius: 12px; }
.card--dark .kicker { color: #999; }
.card--dark .kicker b { color: #fff; }
.card--dark a { color: #fff; text-decoration: underline; }
.card--dark p { color: #eee; }
.card--dark h2 { color: #fff; }
```

### 5. Image placeholders

Add image placeholder areas that show where photos should go. These render as dashed-border boxes with a "+" icon when no image is in the content:

```css
.ph { aspect-ratio: 16 / 9; border: 1.5px dashed #ccc; border-radius: 10px; background: #fafafa;
      display: grid; place-items: center; text-align: center; color: #999; font-size: 13px; padding: 12px; }
.ph::before { content: "+"; display: block; font-size: 22px; color: #bbb; }
```

Place image slots in these sections:
- Section 2 (Events): After the events list, a 3-up photo grid area for event recap photos. Use `aspect-ratio: 1` for square thumbnails.
- Section 3 (Topic): A 16:9 hero image slot at the top of the section, before the article text.
- Section 5 (Highlights): Round avatar placeholders (64x64, `border-radius: 50%`).
- Section 8 (Coworking): A 3:2 photo slot.

The placeholder should ONLY appear when the section content does not already contain an image (check if the rendered HTML contains `<img`). If the content has images, show those instead.

```css
.media { aspect-ratio: 16 / 9; border-radius: 10px; overflow: hidden; background: #eee; margin: 0 0 16px; }
.media img { width: 100%; height: 100%; object-fit: cover; display: block; }
.photo-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin: 16px 0; }
.photo-grid .media { aspect-ratio: 1; margin: 0; }
@media (max-width: 480px) { .photo-grid { grid-template-columns: repeat(2, 1fr); } }
```

### 6. Pull quote styling (section 1)

The opening section often ends with a blockquote (Quote of the Month). Style it as an oversized pull quote:

```css
blockquote { margin: 24px 0 0; padding: 0 0 0 20px; border-left: 3px solid #1a1a1a; font-size: 20px; line-height: 1.45; font-style: italic; }
blockquote cite { display: block; margin-top: 10px; font-size: 14px; font-style: normal; color: #666; }
```

In the dark band (section 3), blockquote border color should be `#666`.

### 7. Fact box for Need to Know (section 6)

```css
.facts { background: #f5f5f5; border-radius: 10px; padding: 16px 18px; }
.facts li { margin: 0 0 6px; }
.facts strong { font-variant-numeric: tabular-nums; }
```

Wrap section 6 content in a `.facts` container.

### 8. Partners 3-column grid (section 4)

The existing `partnersHtml()` function splits content by double-newlines. Keep that logic but use CSS grid:

```css
.grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
@media (max-width: 480px) { .grid3 { grid-template-columns: 1fr; } }
```

### 9. Scroll reveal animation (progressive enhancement)

Add a subtle fade-up on scroll for cards. This is a CSS-only progressive enhancement:

```css
@supports (animation-timeline: view()) {
  @media (prefers-reduced-motion: no-preference) {
    .card { animation: reveal 1ms linear both; animation-timeline: view(); animation-range: entry 0% entry 40%; }
  }
}
@keyframes reveal { from { opacity: .3; transform: translateY(16px); } to { opacity: 1; transform: none; } }
```

### 10. Reading progress bar

A thin bar at the very top of the viewport that fills as you scroll:

```css
.progress { position: fixed; top: 0; left: 0; right: 0; height: 3px; background: #1a1a1a;
            transform-origin: 0 50%; transform: scaleX(0); z-index: 11; }
@supports (animation-timeline: scroll()) {
  .progress { animation: grow 1ms linear both; animation-timeline: scroll(root); }
}
@keyframes grow { to { transform: scaleX(1); } }
```

Add `<div class="progress"></div>` as the first child of `<body>`.

## New route: GET /newsletter (public publish URL)

Add a new route in the `fetch` handler (before the `env.ASSETS.fetch` fallback):

```javascript
if (url.pathname === "/newsletter" && request.method === "GET") {
  return handleNewsletterPublic(env);
}
```

The `handleNewsletterPublic` function:
1. Fetches from the Newsletter Issues table with `filterByFormula`: `{published}=1`
2. Sorts by the `month` field descending (or just takes the most recent record)
3. If no published issue found, returns a simple "No newsletter published yet" page
4. If found, extracts the record ID and calls the same rendering logic as `handleNewsletterAssemble` but without the `?issue=` parameter requirement

This means you need to refactor the rendering portion of `handleNewsletterAssemble` into a shared helper function like `renderNewsletterPage(env, issueId)` that both routes can call.

**Important**: The user needs to add a `published` checkbox field to their Newsletter Issues table in Airtable. The field name must be exactly `published`.

## Responsive breakpoints

- Desktop: max-width 640px centered, 28px card padding, 3-column grids
- Mobile (max-width: 480px): 20px card padding, single-column grids, smaller masthead, nav pills scroll horizontally

## Technical constraints

1. All CSS in a single `<style>` tag in `<head>` -- no external stylesheets
2. No JavaScript required. CSS-only progressive enhancements are fine
3. Escape all user content with `escapeHtml()` before `renderMarkdown()`
4. Plain ASCII only in string literals
5. Do not modify any other route or function in worker.js
6. Use PowerShell syntax for terminal commands (semicolons not &&)
7. Keep `Cache-Control: no-store` on the assemble endpoint; use `Cache-Control: public, max-age=300` on the `/newsletter` public endpoint

## How to verify

1. Deploy with `npx wrangler deploy` from `c:\Dev\entrepreneurlyon`
2. Visit `https://entrepreneurlyon.fr/api/newsletter/assemble?issue=rec88ufcesGQQGyk2`
3. Verify: sticky nav, section cards with kickers, dark band on Topic of the Month, image placeholders, pull quote styling, fact box on Need to Know, partners grid, scroll animations, progress bar
4. Test `/newsletter` -- should show "No newsletter published yet" until the user adds a `published` checkbox to Airtable
5. Test mobile by resizing browser to 375px width
6. Test with empty sections (should show "[Section not yet approved]" styled text)
7. Test with sections 4 and 7 empty (cards omitted, nav pills omitted)
