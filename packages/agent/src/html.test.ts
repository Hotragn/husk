import { describe, expect, it } from 'vitest';
import { decodeEntities, extractTitle, htmlToText, looksLikeHtml } from './html.js';

describe('htmlToText', () => {
  it('drops scripts and styles entirely', () => {
    const text = htmlToText('<p>keep</p><script>const secret = 1;</script><style>p{color:red}</style>');
    expect(text).toBe('keep');
  });

  it('turns block elements into line breaks', () => {
    expect(htmlToText('<h1>Title</h1><p>One</p><p>Two</p>')).toBe('Title\n\nOne\n\nTwo');
  });

  it('bullets list items', () => {
    expect(htmlToText('<ul><li>a</li><li>b</li></ul>')).toContain('- a');
  });

  it('decodes entities', () => {
    expect(htmlToText('<p>a &amp; b &lt; c &#39;d&#39;</p>')).toBe("a & b < c 'd'");
  });

  it('collapses runaway whitespace', () => {
    expect(htmlToText('<p>a     b</p>\n\n\n\n<p>c</p>')).toBe('a b\n\nc');
  });
});

describe('extractTitle', () => {
  it('finds and cleans the title', () => {
    expect(extractTitle('<html><head><title>  Hello &amp;  world </title></head>')).toBe('Hello & world');
  });

  it('returns undefined when there is none', () => {
    expect(extractTitle('<html><body>x</body></html>')).toBeUndefined();
  });
});

describe('decodeEntities', () => {
  it('handles decimal and hex numeric references', () => {
    expect(decodeEntities('&#65;&#x42;')).toBe('AB');
  });

  it('leaves unknown entities alone rather than eating them', () => {
    expect(decodeEntities('&notarealentity;')).toBe('&notarealentity;');
  });
});

describe('looksLikeHtml', () => {
  it('trusts the content type when there is one', () => {
    expect(looksLikeHtml('text/html; charset=utf-8', '')).toBe(true);
    expect(looksLikeHtml('application/json', '<p>x</p>')).toBe(false);
  });

  it('sniffs the body when there is no content type', () => {
    expect(looksLikeHtml(null, '<!doctype html><html><body>x')).toBe(true);
    expect(looksLikeHtml(null, '{"a":1}')).toBe(false);
  });
});
