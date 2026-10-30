import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Notes, notesInstructions } from './notes.js';

let dir = '';
let folder = '';
let notes: Notes;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'husk-notes-'));
  folder = join(dir, 'memory');
  notes = new Notes(folder);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The error code a command fails with, if it fails. */
function refusal(run: () => unknown): string | undefined {
  try {
    run();
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
}

describe("a bot's notes", () => {
  it('keeps notes as plain files, under the paths models trained on the memory tool write', () => {
    expect(notes.run({ command: 'view' })).toBe('You have no notes yet.');
    expect(notes.run({ command: 'create', path: '/memories/prefs.md', file_text: 'Reply in French.\nKeep it short.' })).toBe('Saved prefs.md.');
    expect(readFileSync(join(folder, 'prefs.md'), 'utf8')).toBe('Reply in French.\nKeep it short.');
    expect(notes.run({ command: 'str_replace', path: 'prefs.md', old_str: 'French', new_str: 'Spanish' })).toBe('Changed prefs.md.');
    expect(notes.run({ command: 'insert', path: 'prefs.md', insert_line: 0, insert_text: '# Preferences' })).toBe('Added to prefs.md.');
    expect(notes.run({ command: 'view', path: 'prefs.md', view_range: [1, 2] })).toBe('prefs.md:\n     1\t# Preferences\n     2\tReply in Spanish.');
    expect(notes.run({ command: 'rename', path: 'prefs.md', new_path: 'people/ana.md' })).toBe('Renamed prefs.md to people/ana.md.');
    expect(notes.run({ command: 'view', path: '/memories' })).toMatch(/^1 note, .+:\n- people\/ana\.md \(/);
    expect(notes.run({ command: 'delete', path: 'people/ana.md' })).toBe('Deleted people/ana.md.');
    expect(notes.list()).toEqual([]);
  });

  it('never reaches outside its folder', () => {
    writeFileSync(join(dir, 'secret.txt'), 'outside');
    for (const path of ['../secret.txt', '/memories/../../secret.txt', 'C:/Windows/win.ini', 'a/./b.md']) {
      expect(refusal(() => notes.run({ command: 'view', path }))).toBe('E_FS_DENIED');
    }
    // A path that looks absolute names a note inside the folder.
    notes.run({ command: 'create', path: '/etc/passwd', file_text: 'x' });
    expect(readFileSync(join(folder, 'etc', 'passwd'), 'utf8')).toBe('x');
  });

  it('refuses a link inside the folder rather than follow it', () => {
    mkdirSync(folder);
    mkdirSync(join(dir, 'elsewhere'));
    // A junction on Windows, which needs no special rights; a plain link elsewhere.
    symlinkSync(join(dir, 'elsewhere'), join(folder, 'linked'), 'junction');
    expect(refusal(() => notes.run({ command: 'create', path: 'linked/x.md', file_text: 'x' }))).toBe('E_FS_DENIED');
    expect(notes.list()).toEqual([]);
  });

  it('keeps notes short, and masks a secret before it is saved', () => {
    expect(refusal(() => notes.run({ command: 'create', path: 'big.md', file_text: 'x'.repeat(64 * 1024 + 1) }))).toBe('E_QUOTA');
    for (let i = 0; i < 16; i++) notes.run({ command: 'create', path: `n${i}.md`, file_text: 'x'.repeat(64 * 1024) });
    expect(refusal(() => notes.run({ command: 'create', path: 'one-more.md', file_text: 'x' }))).toBe('E_QUOTA');

    const key = `sk-ant-api03-${'A'.repeat(40)}`;
    expect(notes.run({ command: 'create', path: 'n0.md', file_text: `The key is ${key}` })).toBe('Replaced n0.md. A value that looked like a secret was masked before saving.');
    expect(readFileSync(join(folder, 'n0.md'), 'utf8')).not.toContain(key);
  });

  it('says what went wrong in words a model can act on', () => {
    notes.run({ command: 'create', path: 'a.md', file_text: 'one one' });
    expect(refusal(() => notes.run({ command: 'str_replace', path: 'a.md', old_str: 'one', new_str: 'two' }))).toBe('E_TOOL_ERROR');
    expect(refusal(() => notes.run({ command: 'view', path: 'missing.md' }))).toBe('E_TOOL_ERROR');
    expect(refusal(() => notes.run({ command: 'rename', path: 'a.md', new_path: 'a.md' }))).toBe('E_TOOL_ERROR');
    expect(refusal(() => notes.run({ command: 'forget' }))).toBe('E_TOOL_ERROR');
  });

  it('tells the bot which notes it has, leaving out half-written ones', () => {
    notes.run({ command: 'create', path: 'todo.md', file_text: 'ship it' });
    writeFileSync(join(folder, '.todo.md.123.tmp'), 'half');
    expect(notesInstructions(folder)).toContain('Your notes right now: todo.md.');
    expect(notesInstructions(join(dir, 'nothing-yet'))).toContain('You have no notes yet.');
  });
});
