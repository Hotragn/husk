/**
 * End-to-end smoke test, run by CI and by anyone debugging an install.
 *
 * Deliberately does not mock: it creates a real computer with whatever provider is
 * available, drives every tool through the same `callTool` the MCP handler uses,
 * and cleans up. If this passes, `claude mcp add husk` will work.
 */
import { ComputerManager } from '@husk-ai/runtime';
import { TOOLS, callTool } from './tools.js';
import type { ToolResult } from './tools.js';

const out = (s: string) => process.stdout.write(s + '\n');

async function main(): Promise<void> {
  const manager = new ComputerManager();

  const status = await manager.status();
  out('providers:');
  for (const p of status) {
    out(`  ${p.name.padEnd(8)} available=${String(p.available).padEnd(5)} isolated=${p.isolated ?? '?'}  ${p.reason ?? ''}`);
  }

  out(`\ntools: ${TOOLS.map((t) => t.name).join(', ')}`);

  const computer = await manager.create({ name: 'mcp-smoke', idleTimeoutSec: 300 });
  out(`\ncomputer ${computer.id} on ${computer.info.provider}`);

  let failures = 0;
  const check = (label: string, result: ToolResult) => {
    // Image blocks carry no text. Name them rather than printing several
    // hundred kilobytes of base64 into a smoke log.
    const text = result.content
      .map((c) => (c.type === 'text' ? c.text : `[${c.mimeType}, ${c.data.length} base64 chars]`))
      .join('\n');
    const status = result.isError ? 'FAIL' : 'ok';
    if (result.isError) failures++;
    out(`\n[${status}] ${label}\n${text.split('\n').slice(0, 8).join('\n')}`);
  };

  try {
    check('computer_info', await callTool(computer, 'computer_info', {}));
    check('write_file', await callTool(computer, 'write_file', { path: '/work/hello.txt', content: 'hello husk\n' }));
    check('shell (read it back)', await callTool(computer, 'shell', { command: 'cat /work/hello.txt' }));
    check('list_dir', await callTool(computer, 'list_dir', { path: '/work' }));
    check('edit_file', await callTool(computer, 'edit_file', {
      path: '/work/hello.txt',
      old_string: 'hello husk',
      new_string: 'edited by husk',
    }));
    check('read_file', await callTool(computer, 'read_file', { path: '/work/hello.txt' }));

    // These two must report an error rather than throwing.
    const missing = await callTool(computer, 'edit_file', {
      path: '/work/hello.txt',
      old_string: 'not present anywhere',
      new_string: 'x',
    });
    out(`\n[${missing.isError ? 'ok' : 'FAIL'}] edit_file reports a missing match`);
    if (!missing.isError) failures++;

    const denied = await callTool(computer, 'shell', { command: 'sudo rm -rf /' });
    out(`[${denied.isError ? 'ok' : 'FAIL'}] shell refuses a destructive command`);
    if (!denied.isError) failures++;

    const escaped = await callTool(computer, 'read_file', { path: '/etc/passwd' });
    out(`[${escaped.isError ? 'ok' : 'FAIL'}] read_file refuses a path outside the jail`);
    if (!escaped.isError) failures++;
  } finally {
    await computer.destroy();
    out('\ncomputer destroyed');
  }

  if (failures > 0) {
    out(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  out('\nall checks passed');
}

main().catch((err) => {
  process.stderr.write(`smoke failed: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
