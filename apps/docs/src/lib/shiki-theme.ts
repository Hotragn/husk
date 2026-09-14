import type { ThemeRegistration } from 'shiki';

/**
 * Two Shiki themes built from `brand/tokens.css`.
 *
 * Shiki resolves colours at build time and bakes them into inline styles, so it
 * cannot read a CSS custom property. Every value below is therefore a literal
 * copied from the token file, and the token it came from is named in a comment
 * beside it. If a token changes, this file changes with it.
 *
 * The palette is deliberately small. Husk's brand has two hues — husk gold for
 * the dry outer layer, core teal for the live inner one — and a nine-colour
 * rainbow would be a third design language nobody asked for. So: strings and
 * literals in gold, keywords and functions in teal, everything structural in
 * the neutral ramp, and comments at the muted step.
 */

interface Palette {
  bg: string;
  fg: string;
  muted: string;
  gold: string;
  goldDim: string;
  teal: string;
  tealDim: string;
  neutral: string;
  danger: string;
  info: string;
  selection: string;
}

// Dark, from :root in tokens.css.
const DARK: Palette = {
  bg: '#070503', // --color-sunken
  fg: '#f8f5f1', // --color-text
  muted: '#9e9992', // --color-text-subtle
  gold: '#deb076', // --color-text-primary / primary-300
  goldDim: '#c38e48', // --color-primary-400
  teal: '#42d0cf', // --color-text-accent / accent-300
  tealDim: '#00b0af', // --color-accent-400
  neutral: '#bdb8b1', // --color-text-muted / neutral-300
  danger: '#fc6661', // --color-danger
  info: '#65c7f8', // --color-info
  selection: '#005251', // --color-selection-bg
};

// Light, from [data-theme="light"] in tokens.css.
const LIGHT: Palette = {
  bg: '#eeeae2', // --color-sunken
  fg: '#252019', // --color-text
  muted: '#6c675f', // --color-text-subtle
  gold: '#623d00', // --color-text-primary / primary-700
  goldDim: '#855500', // --color-primary-600
  teal: '#005251', // --color-text-accent / accent-700
  tealDim: '#006f6e', // --color-accent-600
  neutral: '#5b564e', // --color-text-muted
  danger: '#a20519', // --color-danger
  info: '#006083', // --color-info
  selection: '#c0f6f4', // --color-selection-bg
};

function build(name: string, type: 'dark' | 'light', c: Palette): ThemeRegistration {
  return {
    name,
    type,
    colors: {
      'editor.background': c.bg,
      'editor.foreground': c.fg,
      'editor.selectionBackground': c.selection,
    },
    settings: [
      { settings: { background: c.bg, foreground: c.fg } },
      {
        scope: ['comment', 'punctuation.definition.comment', 'string.comment'],
        settings: { foreground: c.muted, fontStyle: 'italic' },
      },
      {
        scope: ['string', 'string.quoted', 'constant.other.symbol', 'meta.embedded.assembly'],
        settings: { foreground: c.gold },
      },
      {
        scope: ['constant.numeric', 'constant.language', 'constant.character', 'constant.other'],
        settings: { foreground: c.goldDim },
      },
      {
        scope: ['keyword', 'storage', 'storage.type', 'keyword.operator.new', 'keyword.control'],
        settings: { foreground: c.teal },
      },
      {
        scope: ['entity.name.function', 'support.function', 'meta.function-call.generic'],
        settings: { foreground: c.tealDim },
      },
      {
        scope: ['variable', 'variable.other', 'meta.definition.variable.name', 'support.variable'],
        settings: { foreground: c.fg },
      },
      {
        scope: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'],
        settings: { foreground: c.tealDim },
      },
      {
        scope: ['entity.name.tag', 'punctuation.definition.tag'],
        settings: { foreground: c.teal },
      },
      {
        scope: ['entity.other.attribute-name'],
        settings: { foreground: c.gold },
      },
      {
        scope: ['punctuation', 'meta.brace', 'keyword.operator'],
        settings: { foreground: c.neutral },
      },
      // YAML and JSON keys carry most of the meaning in this documentation set,
      // so they get the accent rather than the neutral used for plain variables.
      {
        scope: ['support.type.property-name', 'entity.name.tag.yaml', 'meta.object-literal.key'],
        settings: { foreground: c.teal },
      },
      {
        scope: ['invalid', 'invalid.illegal'],
        settings: { foreground: c.danger },
      },
      {
        scope: ['markup.inserted', 'meta.diff.header.to-file'],
        settings: { foreground: c.info },
      },
      {
        scope: ['markup.deleted', 'meta.diff.header.from-file'],
        settings: { foreground: c.danger },
      },
      {
        scope: ['markup.heading', 'markup.bold'],
        settings: { foreground: c.gold, fontStyle: 'bold' },
      },
    ],
  };
}

export const huskDark = build('husk-dark', 'dark', DARK);
export const huskLight = build('husk-light', 'light', LIGHT);
