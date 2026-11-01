#!/usr/bin/env node
/**
 * A stand-in MCP server that only records who connected.
 *
 * It has no tools, prompts or resources and runs nothing. For each process it
 * appends one line when the process starts, one when a client initializes, and
 * one when the client disconnects, to the log file given as the first argument
 * (default: mcp-probe.log in the home directory). The point is to see, without
 * running Husk, what each chat app calls itself in `clientInfo`, which protocol
 * it speaks and what it declares it can do, and whether two chats get two
 * processes.
 *
 * Logged: time, pid, clientInfo name and version, the protocol version asked
 * for, and the names of the capabilities declared.
 * Nothing else: no environment, no arguments, no message content.
 *
 * Usage: node scripts/mcp-probe.mjs [log-file]
 * Stdio framing per https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
 */
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const logFile = process.argv[2] || join(homedir(), 'mcp-probe.log');
const short = (v) => (typeof v === 'string' ? v.replace(/[^\x20-\x7e]/g, '').slice(0, 80) : undefined);
const log = (event, extra = {}) =>
  appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), event, pid: process.pid, ...extra }) + '\n');

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

log('start');

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return; // notifications need no answer
  if (msg.method === 'initialize') {
    const p = msg.params ?? {};
    log('initialize', {
      client: short(p.clientInfo?.name),
      clientVersion: short(p.clientInfo?.version),
      protocol: short(p.protocolVersion),
      capabilities: p.capabilities && typeof p.capabilities === 'object' ? Object.keys(p.capabilities).map(short) : [],
    });
    send({
      id: msg.id,
      result: {
        protocolVersion: short(p.protocolVersion) ?? '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'husk-probe', version: '0.0.1' },
      },
    });
  } else if (msg.method === 'tools/list') {
    send({ id: msg.id, result: { tools: [] } });
  } else if (msg.method === 'ping') {
    send({ id: msg.id, result: {} });
  } else {
    send({ id: msg.id, error: { code: -32601, message: 'husk-probe has nothing but an empty tool list' } });
  }
});

process.stdin.on('end', () => {
  log('disconnect');
  process.exit(0);
});
