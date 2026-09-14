#!/usr/bin/env python3
"""
The CDP driver, which runs *inside* the computer.

The whole point of this file is where it executes. Chromium's
``--remote-debugging-port`` binds loopback and nothing widens that bind address:
an unauthenticated CDP port is a remote-code-execution primitive, so it stays on
the machine's own loopback where only the machine can reach it. WSL2's port relay
forwards ``0.0.0.0`` listeners only, and ``docker -p`` cannot publish a
container-loopback socket either, so a driver on the host is not a thing that can
work. A driver on the computer is, and it needs nothing but ``python3``.

One process per command. Connect, run a short script of CDP steps, print one
JSON object on stdout, exit. Chromium outlives the process, so page state
persists across invocations even though the driver holds none. The cost is a
Python start plus a websocket handshake, call it 150ms; the lever if that ever
stops being acceptable is to put more steps in one invocation, which is why the
request is a list rather than a single command.

Protocol, stdin -> stdout, both one JSON object:

  request  {"port": 9222, "ws": "ws://...", "targetId": "ABC",
            "timeoutMs": 60000, "steps": [...]}
  step     {"op": "send", "method": "Page.navigate", "params": {}, "session": true}
           {"op": "wait", "event": "Page.loadEventFired", "timeoutMs": 30000,
            "optional": true}
           ...plus "soft": true to turn a rejected command into a recorded
           error, and "skipIf": {"step": 0, "key": "errorText"} to drop a step
           when an earlier one already said the rest is pointless. Both exist so
           that a sequence which depends on its own outcome still fits in one
           invocation -- waiting 30s for a load event after a navigation that
           was refused is the case that motivated them.
  ok       {"ok": true, "results": [...], "browser": "...", "sessionId": "..."}
  failure  {"ok": false, "kind": "...", "message": "...", "details": {}}

A failure is still exit code 0 and still valid JSON. A non-zero exit or
unparseable stdout means the driver itself could not run, which is a different
problem with a different fix, and the host side keeps them apart.
"""

import base64
import json
import os
import socket
import struct
import sys
import time
import traceback
from urllib.parse import urlparse
from urllib.request import urlopen

# The kinds the host maps onto husk error codes. Keep them few and distinct.
UNREACHABLE = 'unreachable'    # nothing is listening -- the browser never came up or died
BROWSER_GONE = 'browser_gone'  # it answered, then the socket went away mid-command
TIMEOUT = 'timeout'            # a command or an event did not arrive in budget
PROTOCOL = 'protocol'          # Chromium rejected the command
BAD_TARGET = 'bad_target'      # the page we were told to drive is not there any more
INTERNAL = 'internal'          # a bug in this file

# Reading a 12 MB full-page screenshot off the socket must not be mistaken for a
# hang, so once a frame header is in hand the payload gets its own generous
# budget rather than the caller's.
PAYLOAD_GRACE_SEC = 60.0


class DriverError(Exception):
    def __init__(self, kind, message, details=None):
        Exception.__init__(self, message)
        self.kind = kind
        self.message = message
        self.details = details or {}


def _now():
    return time.monotonic()


def _left(deadline, boundary=True):
    """Seconds until the deadline, or a timeout if it has passed."""
    r = deadline - _now()
    if r <= 0:
        raise DriverError(TIMEOUT, 'the driver ran out of time', {'boundary': boundary})
    return r


def discover(port, deadline):
    """Ask the browser for its own websocket URL, on the loopback it bound."""
    url = 'http://127.0.0.1:%d/json/version' % port
    try:
        handle = urlopen(url, timeout=min(5.0, _left(deadline)))
        try:
            body = json.loads(handle.read().decode('utf-8'))
        finally:
            handle.close()
    except DriverError:
        raise
    except Exception as exc:
        raise DriverError(
            UNREACHABLE,
            'nothing answered the DevTools endpoint on 127.0.0.1:%d' % port,
            {'cause': str(exc)},
        )

    ws = body.get('webSocketDebuggerUrl')
    if not isinstance(ws, str):
        raise DriverError(
            UNREACHABLE,
            'something other than Chromium is listening on 127.0.0.1:%d' % port,
            {'body': body},
        )
    return ws, body.get('Browser', '')


def _xor(payload, mask):
    out = bytearray(payload)
    for i in range(len(out)):
        out[i] ^= mask[i & 3]
    return bytes(out)


class Ws(object):
    """
    Enough RFC 6455 to talk to Chromium and no more.

    Client frames must be masked; server frames never are. Chromium negotiates
    no extensions when we offer none, so there is no compression to undo. It
    does not fragment CDP replies in practice, but continuation is four lines
    and a desync would be maddening to debug, so it is handled.
    """

    def __init__(self, url, deadline):
        parts = urlparse(url)
        host = parts.hostname or '127.0.0.1'
        port = parts.port or 80
        path = parts.path or '/'
        if parts.query:
            path = path + '?' + parts.query

        try:
            self.sock = socket.create_connection((host, port), timeout=_left(deadline))
        except DriverError:
            raise
        except OSError as exc:
            raise DriverError(
                UNREACHABLE,
                'could not open a socket to the browser at %s:%d' % (host, port),
                {'cause': str(exc)},
            )
        self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.buf = b''

        key = base64.b64encode(os.urandom(16)).decode('ascii')
        req = (
            'GET %s HTTP/1.1\r\n'
            'Host: %s:%d\r\n'
            'Upgrade: websocket\r\n'
            'Connection: Upgrade\r\n'
            'Sec-WebSocket-Key: %s\r\n'
            'Sec-WebSocket-Version: 13\r\n'
            '\r\n'
        ) % (path, host, port, key)
        self._write(req.encode('ascii'))

        head = self._read_until(b'\r\n\r\n', deadline)
        status = head.split(b'\r\n', 1)[0]
        if b'101' not in status:
            raise DriverError(
                UNREACHABLE,
                'the browser refused the websocket upgrade',
                {'status': status.decode('latin-1', 'replace')},
            )

    def _write(self, data):
        try:
            self.sock.sendall(data)
        except OSError as exc:
            raise DriverError(BROWSER_GONE, 'the browser closed the connection while husk was writing to it', {'cause': str(exc)})

    def _recv(self, deadline, boundary):
        self.sock.settimeout(_left(deadline, boundary))
        try:
            chunk = self.sock.recv(65536)
        except socket.timeout:
            raise DriverError(TIMEOUT, 'the browser did not answer in time', {'boundary': boundary})
        except OSError as exc:
            raise DriverError(BROWSER_GONE, 'the connection to the browser failed', {'cause': str(exc)})
        if not chunk:
            raise DriverError(BROWSER_GONE, 'the browser closed the connection')
        return chunk

    def _read_until(self, marker, deadline):
        while marker not in self.buf:
            self.buf += self._recv(deadline, True)
        head, self.buf = self.buf.split(marker, 1)
        return head

    def _read_exact(self, n, deadline, boundary):
        while len(self.buf) < n:
            self.buf += self._recv(deadline, boundary)
        data, self.buf = self.buf[:n], self.buf[n:]
        return data

    def _read_one(self, deadline):
        """One raw frame. `boundary` says whether a timeout lost any bytes."""
        first = self._read_exact(2, deadline, True)
        # Past this point a timeout would strand a half-read frame and desync
        # the stream, so the payload is not allowed to fail the caller's budget.
        inner = max(deadline, _now() + PAYLOAD_GRACE_SEC)
        fin = bool(first[0] & 0x80)
        opcode = first[0] & 0x0F
        length = first[1] & 0x7F
        if length == 126:
            length = struct.unpack('>H', self._read_exact(2, inner, False))[0]
        elif length == 127:
            length = struct.unpack('>Q', self._read_exact(8, inner, False))[0]
        # A masked server frame is a protocol violation; Chromium never sends one.
        payload = self._read_exact(length, inner, False) if length else b''
        return fin, opcode, payload

    def read_message(self, deadline):
        """One logical text message, reassembling continuations and handling control frames."""
        chunks = []
        opcode = None
        while True:
            fin, op, payload = self._read_one(deadline)
            if op == 0x8:
                raise DriverError(BROWSER_GONE, 'the browser closed the websocket')
            if op == 0x9:
                self.send_frame(payload, 0xA)
                continue
            if op == 0xA:
                continue
            if op != 0x0:
                opcode = op
                chunks = [payload]
            else:
                chunks.append(payload)
            if fin:
                break
        data = b''.join(chunks)
        if opcode == 0x2:
            # Chromium sends CDP as text. A binary frame means we are not talking
            # to Chromium, and decoding it as JSON would be a guess.
            raise DriverError(UNREACHABLE, 'the peer sent a binary frame; this is not a CDP endpoint')
        return data.decode('utf-8', 'replace')

    def send_frame(self, payload, opcode):
        header = bytearray()
        header.append(0x80 | opcode)
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack('>H', n)
        else:
            header.append(0x80 | 127)
            header += struct.pack('>Q', n)
        mask = os.urandom(4)
        header += mask
        self._write(bytes(header) + _xor(payload, mask))

    def send_text(self, text):
        self.send_frame(text.encode('utf-8'), 0x1)

    def close(self):
        try:
            self.send_frame(b'', 0x8)
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass


class Conn(object):
    def __init__(self, ws):
        self.ws = ws
        self.next_id = 1
        self.events = []

    def _pump(self, deadline):
        return json.loads(self.ws.read_message(deadline))

    def call(self, method, params, session_id, deadline):
        msg_id = self.next_id
        self.next_id += 1
        msg = {'id': msg_id, 'method': method, 'params': params or {}}
        if session_id:
            msg['sessionId'] = session_id
        self.ws.send_text(json.dumps(msg))

        while True:
            msg = self._pump(deadline)
            if msg.get('id') == msg_id:
                if 'error' in msg:
                    err = msg['error'] or {}
                    raise DriverError(
                        PROTOCOL,
                        '%s: %s' % (method, err.get('message', 'protocol error')),
                        {'method': method, 'code': err.get('code'), 'data': err.get('data')},
                    )
                return msg.get('result', {})
            if 'id' in msg:
                continue  # a reply to a command we are no longer waiting on
            if 'method' in msg:
                self._note(msg, session_id)

    def _note(self, msg, session_id):
        # A target that detaches takes the page with it; without this, a closed
        # tab means the caller waits out the whole budget for nothing.
        if msg.get('method') == 'Target.detachedFromTarget':
            gone = (msg.get('params') or {}).get('sessionId')
            if gone and gone == session_id:
                raise DriverError(BAD_TARGET, 'the page was closed while the command was in flight')
        self.events.append(msg)

    def wait_event(self, event, session_id, deadline):
        for i, buffered in enumerate(self.events):
            if buffered.get('method') != event:
                continue
            if session_id and buffered.get('sessionId') not in (None, session_id):
                continue
            del self.events[i]
            return buffered.get('params', {})

        while True:
            msg = self._pump(deadline)
            if 'id' in msg:
                continue
            if msg.get('method') != event:
                self._note(msg, session_id)
                continue
            if session_id and msg.get('sessionId') not in (None, session_id):
                self._note(msg, session_id)
                continue
            return msg.get('params', {})


def attach(conn, target_id, deadline):
    try:
        res = conn.call('Target.attachToTarget', {'targetId': target_id, 'flatten': True}, None, deadline)
    except DriverError as exc:
        if exc.kind == PROTOCOL:
            raise DriverError(
                BAD_TARGET,
                'husk could not attach to the page (target %s)' % target_id,
                {'cause': exc.message},
            )
        raise
    session_id = res.get('sessionId')
    if not isinstance(session_id, str):
        raise DriverError(BAD_TARGET, 'Chromium attached to the page without returning a session', {'result': res})
    return session_id


def run(req):
    overall = float(req.get('timeoutMs', 60000)) / 1000.0
    deadline = _now() + overall

    port = req.get('port')
    ws_url = req.get('ws')
    browser = ''
    if not ws_url:
        ws_url, browser = discover(int(port), deadline)

    try:
        ws = Ws(ws_url, deadline)
    except DriverError as exc:
        # A cached websocket URL goes stale every time Chromium restarts. One
        # rediscovery is cheaper than making every caller handle the relaunch.
        if exc.kind != UNREACHABLE or not port or not req.get('ws'):
            raise
        ws_url, browser = discover(int(port), deadline)
        ws = Ws(ws_url, deadline)

    try:
        conn = Conn(ws)
        session_id = None
        target_id = req.get('targetId')
        # A session belongs to a connection, so it cannot be cached across
        # invocations the way a target id can. Attaching per call is the price
        # of statelessness, and it is one round trip on a loopback socket.
        if target_id:
            session_id = attach(conn, target_id, deadline)

        results = []
        for step in req.get('steps') or []:
            op = step.get('op', 'send')
            step_deadline = deadline
            if step.get('timeoutMs') is not None:
                step_deadline = min(deadline, _now() + float(step['timeoutMs']) / 1000.0)
            routed = session_id if step.get('session') else None

            skip = step.get('skipIf')
            if skip is not None:
                index = int(skip.get('step', -1))
                prior = results[index] if -len(results) <= index < len(results) else None
                if isinstance(prior, dict) and prior.get(skip.get('key')):
                    results.append({'skipped': True})
                    continue

            # The inverse: run this step only if an earlier one succeeded.
            # Needed because a driver invocation is a fresh process with a fresh
            # connection, so a wait in a *later* invocation cannot see an event
            # that already fired. Click-then-wait-for-load has to be one batch,
            # and the load wait has to be dropped when nothing navigated.
            only = step.get('skipUnless')
            if only is not None:
                index = int(only.get('step', -1))
                prior = results[index] if -len(results) <= index < len(results) else None
                if not (isinstance(prior, dict) and prior.get(only.get('key'))):
                    results.append({'skipped': True})
                    continue

            if op == 'send':
                try:
                    results.append(conn.call(step['method'], step.get('params') or {}, routed, step_deadline))
                except DriverError as exc:
                    # `soft` is for commands whose failure is information rather
                    # than an outcome -- scrolling a detached node, closing a tab
                    # that is already closed. Only Chromium's own rejection is
                    # softened; a dead browser stays fatal.
                    if step.get('soft') and exc.kind == PROTOCOL:
                        results.append({'error': exc.message})
                    else:
                        raise
            elif op == 'wait':
                try:
                    params = conn.wait_event(step['event'], routed, step_deadline)
                    results.append({'fired': True, 'params': params})
                except DriverError as exc:
                    # A wait that times out cleanly at a frame boundary is a
                    # normal outcome -- a page with no load event is still a
                    # page -- but a timeout mid-frame has desynced the stream
                    # and is not survivable.
                    if step.get('optional') and exc.kind == TIMEOUT and exc.details.get('boundary', True):
                        results.append({'fired': False})
                    else:
                        raise
            else:
                raise DriverError(INTERNAL, 'unknown step op %r' % (op,))

        out = {'ok': True, 'results': results, 'ws': ws_url}
        if browser:
            out['browser'] = browser
        if session_id:
            out['sessionId'] = session_id
        return out
    finally:
        ws.close()


def main():
    try:
        raw = sys.stdin.read()
        req = json.loads(raw) if raw.strip() else {}
    except Exception as exc:
        sys.stdout.write(json.dumps({'ok': False, 'kind': INTERNAL, 'message': 'the driver was given input it could not parse', 'details': {'cause': str(exc)}}))
        return 0

    try:
        out = run(req)
    except DriverError as exc:
        out = {'ok': False, 'kind': exc.kind, 'message': exc.message, 'details': exc.details}
    except Exception as exc:
        out = {
            'ok': False,
            'kind': INTERNAL,
            'message': 'the browser driver crashed: %s' % (exc,),
            'details': {'traceback': traceback.format_exc()[-2000:]},
        }

    sys.stdout.write(json.dumps(out))
    sys.stdout.flush()
    return 0


if __name__ == '__main__':
    sys.exit(main())
