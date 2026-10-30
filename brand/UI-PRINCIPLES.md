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
| Page entrance, once per load | `--duration-6` 560ms, `--duration-8` 760ms for the headline | `--ease-enter` | This page has finished arriving |
| Section head entering the viewport | `--duration-6` 620ms | `--ease-enter` | You have reached a new part |
| Streamed model output | `--duration-7` 700ms | `--ease-linear` | Tokens arriving, one per frame, matching real arrival |
| Scroll-scrubbed sequence | none — scroll position *is* the clock | `--ease-linear` | This is a diagram you are dragging, not a film you are watching |
| Object tracking the pointer | none — continuous, bounded | — | This object is responding to you specifically |

Exits are always faster than entrances. `ease-in-out` is not in the token set
and must not be reintroduced: it is symmetric, and interface motion is not.

### Scroll as a clock

A scroll-scrubbed sequence is not an animation in the sense the bans below are
about, and the distinction is worth stating before the list rather than as an
exception inside it.

An animation on a timer asserts a duration. A sequence bound to scroll position
asserts nothing: the reader sets the clock, it runs backwards as readily as
forwards, it stops where they stop, and a reader who does not care is past it
at whatever speed they scroll. That is a diagram being dragged, not a film
being played, and the difference is why the typewriter ban below survives
intact while the homepage types a command into a composer.

Permitted only when all four hold:

- **Scroll position is the only input.** No timer, no autoplay, no "finish the
  sequence once it has started". If the reader stops, it stops.
- **It is reversible.** Scrolling up un-types, un-fires and un-assembles. A
  sequence that only plays forwards is a film with a scroll-shaped remote.
- **The content underneath is real and readable without it.** Every string the
  sequence animates ships in the document, visible, at first paint. The state
  it animates *from* is added by script after mount, so a crawler, a reader
  with JS off and a failed hydration all get the content rather than a stack of
  `opacity: 0`. This is the same non-negotiable as the reveal below.
- **`prefers-reduced-motion` removes the sequence, not shortens it**, and does
  not download the library that would have run it.

One per page. The homepage's is the chat that gets a computer, between the hero
and "Husk does three things" — it is the animated form of what those two sections
already say in prose, which is why it has no heading of its own.

### Where motion is banned

1. **Scroll-triggered reveals, except on section heads, under every condition
   below.** This was an outright ban and is now a narrow permission. The
   original reasoning has not been refuted and is worth keeping in view: the
   content was already there, animating it in tells the reader the page is a
   slideshow, and *if a section needs an entrance to feel important, it is not
   important.* That last sentence is still the test to apply before adding one.

   What changed is not the argument, it is the scope. A 560ms rise on the
   heading of a section the reader has just arrived at marks a boundary they
   caused by scrolling, which is what the top of this section asks motion to
   do. Applying the same treatment to body copy, a table, a terminal or a code
   block is still banned: those are content, and a reader who has to wait for
   a paragraph is being charged for decoration.

   Permitted only when all five hold:

   - **It fires once.** Unobserve on first intersection. A reveal that replays
     on scroll-back is a loop with extra steps, and loops are item 4.
   - **The content ships visible.** The class that hides it is added by script
     after mount, so a crawler, a reader with JS off, and a failed hydration
     all get the page rather than a stack of `opacity: 0`. This is the
     difference between an entrance and a content-blocking animation, and it
     is not negotiable.
   - **`prefers-reduced-motion` removes it**, not shortens it. See below.
   - **It completes before it is read.** Fire on a root margin that starts the
     motion before the element reaches the fold.
   - **Heads only.** Never on the prose, the tables, the terminals or the code.

2. **Entrance animations on anything below the first screen, other than the
   above and the one named here.** A hero may introduce itself once per load.
   The rest of the page has already been introduced by the hero.

   The named exception is the `husk.yaml` frame, which lies back and rotates up
   as the reader scrolls into it. It is licensed under *Scroll as a clock*
   above rather than as an entrance: it is scrubbed, it reverses, and the file
   is fully rendered and selectable at every angle including the first. The
   reason it is allowed at all is that this section is the one place the page
   hands over the artefact — the argument everywhere else is "we show you real
   output", and this is the output. One per page, and this is it.

   A code block is still banned from the *reveal* in item 1, and that has not
   changed: fading a code block in on a timer makes the reader wait to read.
   Tilting one they are already dragging does not.

3. **Scroll-driven parallax.** Of any depth, on anything. Layers travelling at
   different speeds behind text is depth faked at the expense of the thing the
   reader is trying to read, and it is the single most common way a page
   announces that its motion was chosen before its content.

   What this no longer bans is an object tracking the pointer: the hero's mark
   leans about six degrees towards the cursor and settles when it stops. That
   is not parallax — there are no layers, nothing behind it moves, no text is
   displaced, and the input is a pointer the reader is moving deliberately,
   which is a hover state with more axes. Bounded, on one object, never on
   anything containing copy. It does not exist on touch, where there is no
   pointer to track.

4. **Anything that loops, unless the loop is the information.** No pulsing
   dots, no breathing glows, no shimmering gradients, no animated mesh. A
   looping animation is a permanent low-grade demand on attention with no
   information in it, and that sentence is still the test.

   Two things pass it, and they are the whole list:

   - **An indeterminate spinner**, which must appear only after 400ms of actual
     waiting and must disappear the instant it can be replaced by a real number.
   - **The provider orbit's outer ring**, and this one is the marginal case.
     It is decorative: a dashed circle turning once every 140 seconds, carrying
     nothing. It is here because the alternative was drifting the provider
     nodes themselves, and a click target that moves is a click target you
     miss. If anything in this section is ever cut for failing its own test,
     cut this first.

   Note what is *not* on the list. The hero's kernel does not pulse and does
   not breathe, and no caret blinks: an earlier draft of this clause permitted
   a blinking terminal caret in the hero object, the caret was cut with the
   glyph it sat in, and a permission for something nothing does is how a rule
   file starts drifting from the code. Nothing on either site idles.

5. **Number count-ups.** A number that spins from 0 to its value is unreadable
   for the duration of the animation and is usually decorating a metric nobody
   asked for.

6. **Time-driven typewriter effects on marketing copy.** Streaming model output
   can animate because it is genuinely arriving over time. A headline that
   types itself is lying about latency.

   That argument is unrefuted and unchanged; what it turns on is the clock.
   A string typing itself on a timer claims a duration it does not have. A
   string typing itself under a scrub claims nothing — it un-types when the
   reader scrolls back, which no latency ever does. The homepage types the
   install command into a chat composer under *Scroll as a clock* above, and
   the same string sits in the setup section further down, whole, static and
   copyable.

   Nothing types itself on a timer. Not a headline, not a lead, not a command.

7. **Auto-advancing carousels, tickers, and marquees.** Movement the user did
   not cause and cannot stop.

8. **Hover animations that move layout.** Scale, translate and shadow on hover
   are fine; anything that changes an element's box and reflows a neighbour is
   not.

9. **Page transitions.** Navigation should feel like it already happened.

### `prefers-reduced-motion`

`tokens.css` collapses every duration token to `0ms` and forces
`transition-duration: 1ms` globally under the query. Two things you must still
get right by hand:

- **A collapsed transition is not a removed state change.** The dropdown still
  opens, the ring still appears, the row still highlights — instantly.
- **Anything animating that is not a CSS transition must be handled in JS.**
  Streamed output renders in complete chunks rather than character-by-character.
  Spinners become a static label: `Working…`.
- **An entrance is removed, not collapsed.** The two permitted above are
  decoration, not state, and the rule at the top of this list does not apply to
  them: there is no state change to preserve. Check the query in JS before the
  observer is constructed, so the element is never hidden in the first place —
  a 1ms fade from `opacity: 0` still has a frame at zero, and that frame is a
  flash. `animation: none` and `display: none`, not `1ms`.

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
  `Pulling debian:bookworm-slim — 42 MB of 118 MB`. Husk almost always knows
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
a terminal frame in `--color-sunken` showing real `husk doctor` output, or the
mark itself with a light on it.

*What this does not ban:* light coming off a lit object. The hero's core is
emissive and throws a small additive halo the width of the mark. The pattern
above is a gradient behind the content, unattached to anything, sized in
hundreds of pixels of blur; a highlight on the thing the scene is actually
lighting is the opposite — it is what makes the object read as an object. The
test is whether removing it changes what the reader can tell about the
subject. Remove the wash and you lose nothing. Remove the core's glow and the
core stops being lit, which is half of "a split husk with a **lit** core".

### 2. Floating 3D spheres, orbs, meshes, and wireframe globes

*What it is:* a three.js scene with a slowly rotating iridescent shape, or a
particle network, or a globe with arcs.
*Why it fails:* it depicts nothing. It costs a WebGL context, a main-thread
budget, and a battery on a laptop whose owner is about to judge us on
performance. A rotating sphere on an infrastructure product says "we could not
think of anything true to show".
*Instead:* show the artefact. A `husk.yaml`. A provider table. A terminal. Husk
produces genuinely photogenic text output; use it.

*Amended:* the ban is the reason, not the technology. "It depicts nothing" is
the whole of the case, and it is still the test every 3D object on either site
has to pass. Two do:

- **The hero object** is the headline beside it. "Your AI chat gets a computer."
  is two things and a connection, so the object is a chat
  panel with an exchange in it, a machine below and behind, and a cable
  carrying one pulse into the machine's port, which lights when it arrives. A
  reader who looks at it and then reads the headline should find the headline
  already familiar. It does not rotate on its own and there is nothing
  iridescent about it.

  Three earlier versions of that object failed this test and are worth naming,
  because each failed differently: a lathed husk (a flat blob head-on — a
  surface with no wall has no inside to show), the mark extruded (solid and
  legible, but the mark is already in the header, the footer and the chat
  launcher, and a fourth copy depicts the brand rather than the product), and a
  ribbed seed pod (a good object, and still a seed rather than a computer).
  "It depicts nothing" is the test; "it depicts *us*" does not pass it either.
- **The isolation viewer** depicts `Availability.isolated` for the provider the
  reader picked — plates closed on a kernel boundary, standing off it when
  there is not one. That reading is in the readout underneath in words, in the
  table above it in a row, and in the shape. Never the shape alone.

The costs the pattern names are real and are still owed: both objects are
`ssr:false` behind an IntersectionObserver, both degrade to an SVG built from
the same tables, and the hero's canvas is *unmounted* when it leaves the
viewport so the page never holds two WebGL contexts. A rotating sphere would
still fail this section. It fails on "depicts nothing", not on being 3D.

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

*Amended, narrowly:* §3 item 4 now permits three loops and names them — a
spinner, a terminal caret, and the provider orbit's outer ring. The first two
carry the same information ("waiting"). The third is decoration and is
labelled as such there, including which one to cut first. Nothing else on
either site idles, and the list is closed: if a fourth loop is ever proposed,
it is this section it has to get past, not §3.

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
- [ ] Nothing on the page moves unless the user moved it, the hero's one
      entrance aside, and nothing loops except the three §3 item 4 names.
- [ ] Every scroll-scrubbed sequence reverses, and its content is readable with
      JS off. Check the served HTML, not the hydrated page.
- [ ] Read §8 top to bottom against the page. Zero hits.
- [ ] The word "sandbox" does not appear without a provider next to it.
