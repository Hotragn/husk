# Husk — UI principles

Rules, not suggestions. A frontend engineer should be able to build any Husk
surface from `tokens.css` plus this file without asking a designer a question.
Where a rule has an exception, the exception is written down.

The governing idea: **Husk's interface should feel like a well-made tool, not a
well-funded startup.** Tools are dense, legible, fast, and boring in the places
where boring is a feature. Every decision below is downstream of that.

---

## 1. Layout and grid

**Twelve columns, `--grid-gap` (24px), `--gutter-inline` 20px below 768px and
32px above.** Containers come from `--container-*`; nothing sets a bespoke
`max-width`.

| Surface | Container | Columns used |
| --- | --- | --- |
| Marketing page shell | `--container-xl` (1200px) | 12 |
| Marketing content block | `--container-lg` (1024px) | 8–12 |
| Docs body | `--container-md` (768px), text at `--container-prose` (68ch) | — |
| Console / dashboard | `--container-2xl` (1440px), sidebar 256px fixed | remainder |
| Auth-style single column | `--container-xs` (480px) | — |

**Asymmetry is the default.** The 12-column grid exists so that a hero can be
7/12 with 5/12 of air, a feature can be 5/12 text against 7/12 terminal, and the
next one can invert it. A page where every block is a centred 8/12 has no
hierarchy — it has a rhythm section with no melody.

**Left-aligned, ragged right, everywhere.** Body copy, headings, lists, cards,
CTAs, section intros. Centred text is permitted in exactly three places: the
hero headline and its subhead on viewports under 640px, a single empty state
inside a container narrower than 480px, and the footer's legal line. Everywhere
else, centring costs the reader a re-scan on every line and buys nothing.

**Vertical rhythm** comes from `--space-section` (96px) between major sections,
`--space-16` (64px) between blocks inside a section, and `--space-6` (24px)
between paragraphs. Sections do not all get the same height; a section is as
tall as its content plus its rhythm.

**Full-bleed is earned.** At most one full-bleed element per page, and it must
contain something that genuinely needs the width — a terminal, a provider
comparison table, a wide diagram. Never a full-bleed background colour block
whose only job is to signal "new section".

---

## 2. Density

Husk is a developer tool. The reader's baseline expectation is a man page, not a
brochure.

- **Body text is 16px** (`--font-size-md`) at `--leading-normal` (1.5). Docs
  prose gets `--leading-relaxed` (1.62). Nothing below 13.33px
  (`--font-size-sm`) ever carries a full sentence.
- **Default control height is 36px** (`--control-height-md`). 44px
  (`--control-height-lg`) for the primary CTA and every touch target. 28px
  (`--control-height-sm`) exists only for row-level actions inside a data table
  on a pointer device, and even then the hit area is padded out to 24px minimum.
- **Table rows are 40px** with 12px horizontal cell padding. A list of computers
  or runs should show 12+ rows without scrolling on a laptop. If a table needs a
  "comfortable / compact" toggle, the default was wrong.
- **Cards are for things that are genuinely separate objects.** A feature is not
  an object. Three paragraphs of prose separated by 64px of vertical space beat
  three cards, every time — cards add two borders, two shadows, and 48px of
  padding in exchange for nothing.
- **One idea per screenful.** Density means information per pixel, not elements
  per pixel. A dense page with one clear job is calm; a sparse page with five
  competing calls to action is not.

---

## 3. Motion

**Motion exists to explain a state change the user caused. Nothing else.**

### Where motion is used

| Where | Duration | Easing | What it communicates |
| --- | --- | --- | --- |
| Hover / colour change | `--duration-1` 80ms | `--ease-move` | This is interactive |
| Press | `--duration-2` 120ms | `--ease-move` | Received |
| Focus ring appearing | `--duration-2` 120ms | `--ease-move` | Where you are |
| Checkbox / switch | `--duration-2` 120ms | `--ease-toggle` | Committed (the only overshoot in the system) |
| Dropdown, tooltip, tab underline | `--duration-3` 180ms | `--ease-enter` / `--ease-exit` | Where this came from |
| Accordion, drawer, popover | `--duration-4` 240ms | `--ease-enter` / `--ease-exit` | This was hidden, not new |
| Modal | `--duration-5` 320ms | `--ease-enter` | Context shift |
| Dismissal | `--duration-2` 120ms | `--ease-cut` | Gone |
| Determinate progress | — | `--ease-linear` | Real measured progress only |
| Streamed model output | `--duration-7` 700ms | `--ease-linear` | Tokens arriving, one per frame, matching real arrival |

Exits are always faster than entrances. `ease-in-out` is not in the token set
and must not be reintroduced: it is symmetric, and interface motion is not.

### Where motion is banned

1. **Scroll-triggered reveals.** No fade-up-on-scroll, no stagger, no
   intersection-observer choreography. The content was already there; animating
   it in tells the reader the page is a slideshow and costs them time on every
   scroll. If a section needs an entrance to feel important, it is not important.
2. **Parallax.** Of any depth, on anything.
3. **Anything that loops.** No pulsing dots, no breathing glows, no shimmering
   gradients, no drifting background shapes, no animated mesh. A looping
   animation is a permanent low-grade demand on attention with no information in
   it. The single exception is an indeterminate spinner, which must appear only
   after 400ms of actual waiting and must disappear the instant it can be
   replaced by a real number.
4. **Number count-ups.** A number that spins from 0 to its value is unreadable
   for the duration of the animation and is usually decorating a metric nobody
   asked for.
5. **Typewriter effects on marketing copy.** Streaming model output can animate
   because it is genuinely arriving over time. A headline that types itself is
   lying about latency.
6. **Auto-advancing carousels, tickers, and marquees.** Movement the user did
   not cause and cannot stop.
7. **Hover animations that move layout.** Scale, translate and shadow on hover
   are fine; anything that changes an element's box and reflows a neighbour is
   not.
8. **Page transitions.** Navigation should feel like it already happened.

### `prefers-reduced-motion`

`tokens.css` collapses every duration token to `0ms` and forces
`transition-duration: 1ms` globally under the query. Two things you must still
get right by hand:

- **A collapsed transition is not a removed state change.** The dropdown still
  opens, the ring still appears, the row still highlights — instantly.
- **Anything animating that is not a CSS transition must be handled in JS.**
  Streamed output renders in complete chunks rather than character-by-character.
  Spinners become a static label: `Working…`.

---

## 4. The interaction-state matrix

Every interactive element implements every one of these states. "We did not
design that state" is how a UI rots.

### The nine states

`rest` · `hover` · `active` (pressed) · `focus-visible` · `selected` ·
`disabled` · `loading` · `invalid` · `read-only`

`focus-visible` composes with all of the others — a focused, hovered, selected
row shows all three treatments at once. It is never replaced.

### Buttons

| | Primary | Secondary | Ghost | Destructive |
| --- | --- | --- | --- | --- |
| **rest** | bg `--color-primary-fill`, text `--color-primary-on-fill`, no border | bg transparent, text `--color-text`, 1px `--color-border-strong` | bg transparent, text `--color-text-muted`, no border | bg transparent, text `--color-danger`, 1px `--color-danger-border` |
| **hover** | bg `--color-primary-200` | bg `--color-raised`, border `--color-text-subtle` | bg `--color-raised`, text `--color-text` | bg `--color-danger-subtle` |
| **active** | bg `--color-primary-400`, `translateY(1px)` | bg `--color-surface`, `translateY(1px)` | bg `--color-surface` | bg `--color-danger-subtle`, `translateY(1px)` |
| **focus-visible** | `--shadow-focus` (2px gap, then 2px `--color-border-focus`) | same | same | same |
| **selected** | n/a | bg `--color-raised`, border `--color-border-focus` | bg `--color-raised`, text `--color-text` | n/a |
| **disabled** | `opacity: var(--opacity-disabled)`, `cursor: not-allowed`, no hover response | same | same | same |
| **loading** | label stays, spinner replaces the leading icon slot, width does not change, `aria-busy="true"` | same | same | same |
| **invalid** | n/a | n/a | n/a | n/a |
| **read-only** | n/a | n/a | n/a | n/a |

The button label never changes on hover and never changes width during loading.
A button that reflows while you are clicking it is a button you will misclick.

### Inputs, selects, textareas

| State | Treatment |
| --- | --- |
| **rest** | bg `--color-sunken`, 1px `--color-border-strong`, text `--color-text`, placeholder `--color-text-subtle` |
| **hover** | border `--color-text-subtle` |
| **focus-visible** | border `--color-border-focus` **and** `--shadow-focus-inset`. The border alone is not enough — a 1px colour change is not a 3:1 non-text contrast change against every neighbouring state. |
| **selected** (text selection) | `--color-selection-bg` / `--color-selection-text` |
| **disabled** | `opacity: var(--opacity-disabled)`, bg `--color-surface`, no border change on hover |
| **loading** | `aria-busy`, spinner in the trailing slot, input stays focusable and its value stays selectable |
| **invalid** | border `--color-danger-border`, message below in `--color-danger` at `--font-size-sm`, `aria-invalid="true"`, `aria-describedby` pointing at the message. **Never colour alone** — the message is the signal, the colour is the emphasis. |
| **read-only** | bg `--color-surface`, border `--color-border`, text `--color-text-muted`, still focusable, still copyable |

### Links

Inline links in prose are `--color-text-accent` with a 1px underline at
`text-underline-offset: 0.18em`. On hover the underline goes to 2px; the colour
does not change. On `focus-visible` the standard ring applies. Visited is not
styled — in a docs site it produces a two-tone page that reads as a bug.

Links that are navigation, not prose, drop the underline and rely on position;
they must still change something other than colour on hover (background).

### Rows and cards

| State | Treatment |
| --- | --- |
| **rest** | bg `--color-surface`, bottom border `--color-border` |
| **hover** | bg `--color-raised`, cursor pointer only if the whole row is a target |
| **active** | bg `--color-raised`, no transform (rows do not press) |
| **focus-visible** | ring on the row, inset by 2px so it does not clip against the neighbour |
| **selected** | bg `--color-raised`, 2px left border `--color-border-focus`, plus a checkmark or checkbox — never selection-by-colour alone |
| **disabled** | `opacity: var(--opacity-disabled)`, no hover |
| **loading** | skeleton at the row's real height (see §6) |
| **invalid** | 2px left border `--color-danger-border` plus an inline message |

### Tabs, toggles, segmented controls

Selected tab: text `--color-text`, 2px bottom border `--color-border-focus`.
Unselected: text `--color-text-subtle`, transparent border. Hover on an
unselected tab moves the text to `--color-text` — the underline does not preview.
Arrow keys move between tabs; `Home`/`End` jump to the ends.

---

## 5. Focus

**One ring, everywhere, and it is never removed.**

```css
:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: 2px;
  border-radius: var(--radius-xs);
}
```

- `--color-border-focus` is `accent-400` in dark (7.31:1 vs bg, 6.69:1 vs
  surface, 5.88:1 vs raised) and `accent-600` in light (5.42 / 5.71 / 6.00).
  All well clear of the 3:1 non-text floor, on every surface in the system.
- **The 2px offset is not cosmetic.** It puts a gap of page background between
  the ring and the control, which is what keeps the ring visible on a control
  that is itself teal or gold.
- On elements that cannot afford an outer ring (a table row, an input inside a
  clipped container) use `--shadow-focus-inset` instead. Never nothing.
- `:focus:not(:focus-visible)` clears the outline so a mouse click on a button
  does not leave a ring. Keyboard focus always shows it.
- Under `forced-colors: active` the ring becomes `2px solid CanvasText`.
- **`outline: none` without a replacement in the same rule is a bug**, and worth
  a lint rule.

---

## 6. Empty, loading, and error patterns

### Empty states

An empty state is a place where the product explains itself, not a place for an
illustration. The shape is always: **one line of what this is, one line of why
it is empty, one command or one button.**

```
No computers running.

A computer starts the first time an agent needs one — nothing is spun
up in advance.

  husk run "echo hello"          [ Start one ]
```

No centred illustration. No "Nothing here yet! 🎉". No empty state that is
taller than the content it replaces.

Distinguish **empty** (nothing exists yet — teach) from **filtered to nothing**
(things exist, your filter excluded them — offer to clear the filter) from
**failed to load** (see below). These are three different messages and shipping
one for all three is the most common version of this mistake.

### Loading

- **Under 400ms: show nothing.** A spinner that flashes for 200ms reads as a
  glitch.
- **400ms to ~2s: skeletons**, at the true height and shape of the incoming
  content, so nothing reflows on arrival. Skeletons are `--color-raised`
  rectangles. They do **not** shimmer — see §7.
- **Over ~2s: a real status line**, in monospace, saying what is happening.
  `Pulling ghcr.io/husk/base:0.1.0 — 42 MB of 118 MB`. Husk almost always knows
  what it is waiting for, and naming it is worth more than any animation.
- **Streaming**: render tokens as they arrive, keep the scroll pinned to the
  bottom only while the user is already at the bottom, and always show a stop
  control.
- Every loading region carries `aria-busy="true"` and announces completion
  through a polite live region.

### Errors

The `BUILD-CONTRACT.md` rule — every error carries a `code` and a one-line
`hint` — is a UI rule too.

**Anatomy:** the error `code` in mono at `--font-size-sm` in
`--color-text-subtle`; the human sentence at body size in `--color-text`; the
fix as a command in a copyable `--color-sunken` block or as a button. Container
is `--color-danger-subtle` with a 3px left border in `--color-danger-border`.

- **Errors appear where the thing failed**, not in a corner toast. A toast is
  for something that succeeded quietly.
- **Never "Something went wrong."** If we truly do not know, say what we do
  know: what was attempted, what the code was, and where the log is.
- **Never a raw stack trace in the primary view.** Put it behind
  `Details` / `--verbose`, and make it selectable and copyable in one action.
- **The error says what state the system is in now.** "The computer is still up
  and still has your files" is often the most valuable sentence in the message.
- Errors are announced through an `aria-live="assertive"` region and move focus
  to the error only if the user's next action must happen there.

---

## 7. Accessibility floor

Not aspirations. The floor. A surface that misses any of these is not shippable.

**Contrast.** Every pairing in `tokens.css` carries its measured ratio; all 96
audited pairs meet AA (4.5:1 body, 3:1 large text and non-text UI). If you need a
colour that is not in the tokens, you are introducing an unaudited pair — do not.

**Keyboard.** Every path that can be completed with a mouse can be completed
with a keyboard, in a sane order:

- A visible skip link is the first focusable element on every page
  (`--z-max` is reserved for it).
- Tab order follows the DOM; `tabindex` is `0` or `-1` and never a positive
  number.
- Modals trap focus, restore it to the trigger on close, and close on `Escape`.
- Dropdowns and menus: `Escape` closes, arrow keys move, `Home`/`End` jump,
  typing jumps to a match.
- The terminal view is reachable and escapable by keyboard — `Escape` must exit
  the terminal's key capture and return focus to the page, and that must be
  discoverable, not folklore.
- No hover-only affordance anywhere. A row action that only appears on hover
  must also appear on `:focus-within`.

**Target size.** 24×24 CSS px absolute floor (WCAG 2.2 AA, 2.5.8), 44×44
(`--target-comfortable`) for anything on a touch surface or in a primary flow.
Where the visible control is smaller, pad the hit area — do not grow the visual.

**Motion.** `prefers-reduced-motion` handled as §3 describes. Nothing becomes
unreachable; nothing loses a state change.

**Semantics.** Real elements: `<button>` for actions, `<a href>` for navigation,
`<table>` for tabular data, one `<h1>` per page and no skipped heading levels.
Icon-only buttons carry an `aria-label`. Decorative SVG carries
`aria-hidden="true"` and `focusable="false"`.

**Colour is never the only channel.** Status uses an icon or a word alongside
the hue; selection uses a border or a check alongside the fill; validity uses a
message alongside the border.

**Zoom and reflow.** Usable at 200% zoom and at a 320px-wide viewport with no
horizontal scrolling, except for genuinely two-dimensional content (a wide table
or a terminal), which may scroll within its own region.

**Forced colors.** Test in Windows High Contrast. Anything whose meaning is
carried by a background colour needs a border to survive it.

---

## 8. AI slop: patterns this site must not exhibit

These are the tells. Each is named, each fails for a specific reason, each has a
replacement. If a design review finds one of these, it is not a matter of taste.

### 1. The glowing purple-blue gradient blob

*What it is:* a soft radial gradient in violet/indigo bleeding out from behind
the hero, usually with a second one in the corner and a blur of 200px.
*Why it fails:* it is the single most copied visual on the AI-tools internet, it
carries zero information, and it makes the reader's first thought "another one of
these" instead of "what does this do". It also actively fights our palette, which
is warm gold against cold teal for a reason.
*Instead:* a flat `--color-bg`. If the hero needs depth, give it a real object —
a terminal frame in `--color-sunken` showing real `husk doctor` output.

### 2. Floating 3D spheres, orbs, meshes, and wireframe globes

*What it is:* a three.js scene with a slowly rotating iridescent shape, or a
particle network, or a globe with arcs.
*Why it fails:* it depicts nothing. It costs a WebGL context, a main-thread
budget, and a battery on a laptop whose owner is about to judge us on
performance. A rotating sphere on an infrastructure product says "we could not
think of anything true to show".
*Instead:* show the artefact. A `husk.yaml`. A provider table. A terminal. Husk
produces genuinely photogenic text output; use it.

### 3. The empty "trusted by" wall

*What it is:* a row of greyscale logos, or worse, a row of placeholder
rectangles, under the words "Trusted by teams at".
*Why it fails:* we have no telemetry, so we cannot count users; we have no
customers to name. It is a claim we are not permitted to make (`BRAND.md` §5),
and this audience checks.
*Instead:* the command. `claude mcp add husk -- npx -y @husk-ai/mcp` is stronger
social proof than a logo wall, because the reader can run it. If we later have
real, named, permissioned users, quote one of them saying something specific.

### 4. The fake dashboard screenshot

*What it is:* a rendered mock of a UI that does not exist, with invented
metrics, smooth fake charts, and a green "+24%".
*Why it fails:* it is a lie with a bounding box, and the first person who
installs the product finds out. It also biases the roadmap toward building the
screenshot.
*Instead:* a real screenshot, or real terminal output pasted as text. Text is
better anyway: selectable, searchable, diffable, and it does not go stale as a
2× PNG.

### 5. The generic three-card feature grid

*What it is:* three equal cards, each with a lucide icon in a rounded square, a
three-word title, and two lines of copy. Usually followed by another three.
*Why it fails:* it flattens hierarchy — the three most important things about a
product are never equally important — and the format forces every idea into the
same two lines, which is how "Free and local by default" ends up the same size
as "Dark mode".
*Instead:* asymmetric sections. The most important claim gets a full block with
a terminal next to it. The second gets a half. The rest get a plain list. And
where a card genuinely helps, it holds an *object* — a provider, a computer, a
husk — not a feature.

### 6. Everything centre-aligned

*What it is:* centred headline, centred subhead, centred paragraph, centred
buttons, centred three cards, centred footer, all the way down.
*Why it fails:* centred text gives the eye no fixed left margin, so every line
costs a re-scan; centred layouts have no hierarchy because nothing can be
subordinate to anything else; and a page-length centre axis reads as a slide
deck.
*Instead:* left-aligned, on a grid, asymmetric. See §1 for the three places
centring is allowed.

### 7. Icon-in-a-rounded-square, everywhere

*What it is:* every heading, list item, and card prefixed with a 40px rounded
square containing a 20px stroke icon tinted with the brand colour.
*Why it fails:* the icons are chosen after the copy and mean nothing — a
lightning bolt for "fast", a shield for "secure", a puzzle piece for
"integrations". They add visual weight with no semantic weight, and the shield
in particular would be an outright lie here.
*Instead:* no decorative icons. Icons appear only where they carry information
the text does not: a provider status glyph, an isolation indicator, a copy
button. If you cannot say what an icon means without the label next to it, delete
the icon.

### 8. Ambient "alive" motion

*What it is:* pulsing dots, breathing glows, shimmering skeleton loaders,
slow-drifting gradient meshes, twinkling stars.
*Why it fails:* it is motion with no information, which is the definition of
noise, and it makes a static page feel like it is loading forever. Shimmer on
skeletons specifically implies progress that is not being measured.
*Instead:* stillness. Skeletons are flat `--color-raised` blocks. A running
computer is indicated by the word "running" and a solid `--color-success` dot,
not a pulsing one.

### 9. The vanity metrics strip

*What it is:* "10,000+ developers · 99.99% uptime · 50ms cold starts" across a
band under the hero, often with count-up animation.
*Why it fails:* three of those we cannot measure and one is someone else's
number. Unverifiable numbers are worse than no numbers to an audience that reads
changelogs for fun.
*Instead:* numbers we own and can defend, in context, in prose: "a cold
`docker version` takes about 800 ms, so provider probes are cached for 30
seconds."

### 10. Glassmorphism

*What it is:* semi-transparent panels with `backdrop-filter: blur()`, a 1px
white inner border, and a soft shadow, stacked on a colourful background.
*Why it fails:* it drops contrast below AA in a way that varies with whatever
is scrolling behind it, so the same text is compliant in one scroll position and
not in another. It also requires the colourful background from pattern 1.
*Instead:* opaque surfaces from the `--color-surface` / `--color-raised` stack.
`--blur-md` is permitted on exactly one element: the sticky header, over
scrolling content, with an opaque fallback colour behind it.

### 11. The em-dash-and-tricolon voice in the UI

*What it is:* "Fast. Secure. Simple." "Build — deploy — scale." Three-word
staccato fragments as section headings.
*Why it fails:* it is the prose equivalent of the three-card grid, it says
nothing checkable, and it reads as machine-generated because it usually is.
*Instead:* headings that are claims with verbs in them. "The free path is the
default path." "`husk doctor` tells you if you are isolated."

### 12. Dark mode as an inverted light mode

*What it is:* pure `#000` or pure `#111` background, pure `#fff` text, and the
same accent colour as light mode at the same lightness.
*Why it fails:* pure white on pure black causes halation and is genuinely
uncomfortable to read at length; a mid-tone accent that works on white is either
invisible or vibrating on black.
*Instead:* what `tokens.css` already does. `--color-bg` is `#0f0b07`, a warm
near-black; text is `#f8f5f1`, not `#fff`; and the brand foregrounds move from
the 700 step in light to the 300 step in dark. Dark is the primary theme here
and light is the port, not the other way around.

---

## 9. The review checklist

Before any Husk surface ships:

- [ ] Tab through the whole page. Every interactive element gets a visible ring;
      nothing is reachable that should not be; nothing is unreachable.
- [ ] Set the OS to reduced motion. Every state change still happens.
- [ ] Zoom to 200%, then to a 320px viewport. Nothing is clipped, nothing
      scrolls horizontally except a table or a terminal.
- [ ] Every colour comes from a token. No literal hex in a component.
- [ ] Every one of the nine interaction states exists for every control.
- [ ] Empty, filtered-empty, loading, and error are four different screens.
- [ ] Every error names a next action.
- [ ] Nothing on the page moves unless the user moved it.
- [ ] Read §8 top to bottom against the page. Zero hits.
- [ ] The word "sandbox" does not appear without a provider next to it.
