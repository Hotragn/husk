# Husk logo — usage

Six files, all hand-authored SVG, all with a `viewBox`, none with an external
reference. There is no raster version and there does not need to be: everything
here is straight-line geometry that rasterises cleanly at any size.

| File | What it is | Ink box | Use it for |
| --- | --- | --- | --- |
| `mark.svg` | The symbol, two colours | 29 × 29 in a 32 viewBox | App icon, avatar, anywhere the wordmark would be redundant |
| `mark-mono.svg` | The symbol, `currentColor` | 29 × 29 in a 32 viewBox | One-colour print, embroidery, engraving, anywhere colour is not available |
| `wordmark.svg` | The logotype, `currentColor` | 182 × 68 | Inline in running text, nav bars where the mark already appears elsewhere |
| `lockup-horizontal.svg` | Mark + wordmark, side by side | 288 × 76 | The default. Site header, README, slide footers |
| `lockup-stacked.svg` | Mark above wordmark | 182 × 194 | Square-ish spaces: social avatars with text, sticker sheets, poster corners |
| `favicon.svg` | Simplified mark on its own dark tile | 32 × 32 | Browser tabs, bookmark bars, and nothing else |

---

## The concept

**A husk split open with the core still lit.** The heavy left half is the shell —
four long facets, pointed top and bottom, with a mouth cut into one side; the
narrower right half is the peel, hinged away from it. Between them sits a single
bright blade: the core, which is also a terminal caret.

Two rules follow from that and explain most of the decisions below:

1. **The shell is warm and matte, the core is cold and lit.** Gold (`primary`) is
   always the two outer pieces. Teal (`accent`) is always the blade. They never
   swap and they never gradient into each other.
2. **The asymmetry is load-bearing.** The two shell pieces are deliberately
   unequal in mass. Make them equal and the mark stops being a husk and starts
   being an eye. Never mirror it, never symmetrise it.

---

## Clear space

**One quarter of the asset's own height, on all four sides.** Measure from the
ink, not from the file's `viewBox` — every file in this directory is already
trimmed close to its ink, but the mark carries 1.5 units of padding per side in
its 32-unit box.

| Asset | Rendered height | Clear space |
| --- | --- | --- |
| `mark.svg` at 64px | 64 | 16 on every side |
| `lockup-horizontal.svg` at 40px tall | 40 | 10 on every side |
| `lockup-stacked.svg` at 120px tall | 120 | 30 on every side |
| `wordmark.svg` at 28px tall | 28 | 7 on every side (≈ two stem widths) |

Nothing enters that box: no text, no rule, no other logo, no edge of the
viewport, no card border. On a site header, the clear space is measured to the
nav's first link, not to its bounding box.

---

## Minimum sizes

Below these, the three shapes stop separating and the mark turns into a blob.
These are floors, not targets.

| Asset | Minimum | What breaks below it |
| --- | --- | --- |
| `favicon.svg` | 16px | Nothing — it was drawn for exactly this |
| `mark.svg` | 20px | The 2.7-unit gaps fall under 1 CSS px and the core merges into the shell |
| `mark-mono.svg` | 24px | One colour needs more separation than two do; the peel joins the shell |
| `wordmark.svg` | 72px wide (≈ 27px tall) | The `s` diagonal thins out and the `k` junction closes up |
| `lockup-horizontal.svg` | 140px wide | The mark drops under its own 20px floor |
| `lockup-stacked.svg` | 96px wide | Same |

If you need the mark under 20px, use `favicon.svg`. That is what it is for: the
facets are shortened, the ink is pulled in from the edges, and the three shapes
are pushed apart to 2.7-3.2 units so they survive a tab strip.

---

## On dark and on light

`mark.svg` and both lockups carry an internal `<style>` block with two layers of
control:

```css
.husk-shell { fill: var(--husk-mark-shell, #deb076); }
.husk-core  { fill: var(--husk-mark-core,  #42d0cf); }
.husk-word  { stroke: var(--husk-word, #f8f5f1); }
@media (prefers-color-scheme: light) { /* the 700-step equivalents */ }
```

**Read this before you ship it.** The `prefers-color-scheme` query reads the
*operating system*, not the background the logo is sitting on. It is the right
default for a site whose own theme follows the OS. It is wrong for a light card
inside a dark page, a dark hero inside a light page, or any site with a manual
theme switch — a dark-mode user looking at your light hero will get the
dark-theme logo on a light background.

So:

**If your surface's lightness is not tied to `prefers-color-scheme`, inline the
SVG and set the three custom properties yourself.**

```html
<!-- on any dark surface -->
<span style="--husk-mark-shell:#deb076; --husk-mark-core:#42d0cf; --husk-word:#f8f5f1">
  <!-- inlined lockup-horizontal.svg -->
</span>

<!-- on any light surface -->
<span style="--husk-mark-shell:#623d00; --husk-mark-core:#005251; --husk-word:#252019">
  <!-- inlined lockup-horizontal.svg -->
</span>
```

Or bind them to the design tokens once, globally, and forget about it:

```css
:root { --husk-mark-shell: var(--color-text-primary);
        --husk-mark-core:  var(--color-text-accent);
        --husk-word:       var(--color-text); }
```

That is the recommended wiring. `--color-text-primary` and `--color-text-accent`
already resolve to `primary-300`/`accent-300` in dark and `primary-700`/
`accent-700` in light, which are exactly the values the mark wants.

### Approved colour pairings

| Surface | Shell | Core | Wordmark |
| --- | --- | --- | --- |
| `--color-bg` / `--color-surface` (dark) | `#deb076` primary-300 | `#42d0cf` accent-300 | `#f8f5f1` neutral-50 |
| `--color-bg` / `--color-surface` (light) | `#623d00` primary-700 | `#005251` accent-700 | `#252019` |
| Photograph, video, uncontrolled | `#f8f5f1` | `#f8f5f1` | `#f8f5f1` — use `mark-mono.svg`, single colour, no exceptions |
| Print, one ink | `currentColor` | `currentColor` | `currentColor` |
| Solid gold field (`primary-300`) | — | — | Whole lockup in `#0f0b07` via `mark-mono.svg` + `currentColor` |

On a photograph the mark never gets a drop shadow, an outline, or a scrim.
Either the photograph has a calm enough region for a single-colour mark, or the
mark does not go on the photograph.

---

## Misuse

Each of these has been done to a logo before and each one breaks something
specific.

1. **Do not mirror or flip it.** The peel is on the right because a husk opens
   away from its heavy side. Flipped, it reads as a `)(` bracket pair.
2. **Do not equalise the two shell pieces.** This is the one that turns it into
   an eye. It is also the most tempting "cleanup" a well-meaning designer will
   make.
3. **Do not rotate it.** Not 15°, not 45°, not "just to add energy". The
   pointed top and bottom are the vertical axis of a seed.
4. **Do not recolour the core to gold, or the shell to teal.** Warm shell, cold
   core. That distinction *is* the brand's central idea; inverting it says the
   opposite thing.
5. **Do not put a gradient on any part of it.** Not a subtle one. Not on the
   core "so it glows". The core is lit by being a flat bright colour next to a
   flat dull one.
6. **Do not add a glow, bloom, outer shadow, or bevel.** See rule 5, and see
   `UI-PRINCIPLES.md` on why glowing shapes are the house style of the products
   Husk is not.
7. **Do not stretch it.** Set one dimension and let the `viewBox` do the other.
   `preserveAspectRatio` is at its default for a reason.
8. **Do not redraw the wordmark in a real typeface.** It is not set in
   Bricolage Grotesque and it should not be. If you need "husk" in running
   text, use Bricolage Grotesque and do not call it the wordmark.
9. **Do not letterspace, condense, or re-weight the wordmark.** The stroke is 9
   units against a 44-unit x-height. That ratio is the wordmark.
10. **Do not lock the mark to any other logo without clear space.** Partner
    lockups get a `1px` `--color-border` rule between them, at full clear space
    on both sides.
11. **Do not use `favicon.svg` anywhere except a favicon.** It ships its own
    background tile and it is a different, coarser drawing.
12. **Do not add a tagline inside the lockup.** "Empty by design" is copy, not
    a logo element. It goes in the paragraph below.

---

## Implementation notes

**Favicon.** Serve the SVG and let the browser scale it:

```html
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
```

`favicon.svg` carries its own `#0f0b07` tile with a 6-unit corner radius,
because a browser tab strip is not a surface you control and a transparent mark
disappears against half of them.

**Inline over `<img>`.** Inlining is what makes the custom properties work, it
removes a request, and it lets the mark inherit `currentColor` in the mono case.
Use `<img>` only when you genuinely cannot inline, and then only on a surface
whose lightness follows the OS.

**Accessibility.** Every file has a `<title>` and `role="img"`. When the logo is
next to the word "husk" in text, hide it instead: `aria-hidden="true"` plus
`focusable="false"`, so a screen reader does not say "Husk" twice.

**Do not run these through an aggressive SVG optimiser.** The path data is
already minimal, and most optimisers will strip the `<style>` block, the
`<title>`, or the `role` attribute, all of which are load-bearing here.
