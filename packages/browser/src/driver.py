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

Two ways to run it.

``driver.py --serve PORT`` is the usual one: one long-lived process per
computer, holding one websocket to Chromium and one CDP session per tab, reading
newline-delimited JSON requests on stdin and answering each on stdout with the
same ``id``. A Python start plus a websocket handshake was about 150ms on every
command; held open, a command costs its CDP round trips and nothing else. It
also pushes the live screen -- ``{"op": "screencast", "targetId": ..., "fps":
4}`` starts ``Page.startScreencast`` on that tab and every frame comes out as an
``{"event": "frame", ...}`` line, acknowledged no faster than ``fps`` so
Chromium never outruns the person watching. Stdin closing is the signal to
leave: a killed ``docker exec`` does not kill what it started, but this sees EOF.

``driver.py`` with one JSON request on stdin is the fallback, for providers that
cannot keep stdin open: connect, run the steps, print one JSON object, exit.
Chromium outlives the process, so page state persists across invocations even
though the driver holds none.

Either way a request is a list of steps rather than a single command, so a
sequence that depends on its own outcome is one round, and ``action`` steps are
whole page actions -- goto, click, fill, wait, snapshot, screenshot -- so that
a model's several actions are one round too (code over calls, an idea taken
from ego-lite, MIT, Copyright (c) 2026 CitroLabs). Actions are data: nothing a
model writes is executed here or on the host. The one exception is the
``script`` action, which runs a model's Python in a *separate* process in the
computer, stopped at its limit, talking to this one over pipes; see the scripts
section below. It needs serve mode, because its gotos are checked by the host.

Protocol, stdin -> stdout, one JSON object each (one per line in serve mode,
where both carry an ``id``):

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
           {"op": "action", "do": "click", "ref": "e12"} -- see ``ACTIONS``. A
           failed action records {"error": ...} and every later step is
           skipped, so a run stops where it went wrong and says where.
  ok       {"ok": true, "results": [...], "browser": "...", "sessionId": "..."}
  failure  {"ok": false, "kind": "...", "message": "...", "details": {}}

A failure is still exit code 0 and still valid JSON. A non-zero exit or
unparseable stdout means the driver itself could not run, which is a different
problem with a different fix, and the host side keeps them apart.
"""

import base64
import glob
import json
import os
import queue
import select
import signal
import socket
import struct
import subprocess
import sys
import threading
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
ACTION = 'action'              # a page action could not be done: no such element, text never appeared
INTERNAL = 'internal'          # a bug in this file

# Reading a 12 MB full-page screenshot off the socket must not be mistaken for a
# hang, so once a frame header is in hand the payload gets its own budget rather
# than the caller's. Ten seconds is ages for loopback, and it must stay under the
# host's 15-second margin past the deadline (cdp.ts), or the host kills a driver
# that was only finishing a read and would have answered.
PAYLOAD_GRACE_SEC = 10.0


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
    def __init__(self, ws, casts=None):
        self.ws = ws
        self.next_id = 1
        self.events = []
        # targetId -> sessionId. Only reused in serve mode, where the socket lives on.
        self.sessions = {}
        self.casts = casts

    def _pump(self, deadline):
        # A screencast frame waits for its ack, and Chromium sends no other until
        # it gets one. So a long command still wakes when an ack falls due, or
        # the screen would freeze for exactly as long as a slow wait_for.
        while True:
            if self.casts:
                self.casts.ack_due(self)
            due = self.casts.next_due() if self.casts else None
            if due is None or due >= deadline:
                return json.loads(self.ws.read_message(deadline))
            try:
                return json.loads(self.ws.read_message(due))
            except DriverError as exc:
                if exc.kind != TIMEOUT or not exc.details.get('boundary', True):
                    raise
                self.casts.ack_due(self)

    def send_only(self, method, params, session_id):
        """A command whose reply nobody waits for; `call` skips it when it arrives."""
        msg = {'id': self.next_id, 'method': method, 'params': params or {}}
        self.next_id += 1
        if session_id:
            msg['sessionId'] = session_id
        self.ws.send_text(json.dumps(msg))

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
        if self.casts and self.casts.take(self, msg):
            return
        # A target that detaches takes the page with it; without this, a closed
        # tab means the caller waits out the whole budget for nothing.
        if msg.get('method') == 'Target.detachedFromTarget':
            gone = (msg.get('params') or {}).get('sessionId')
            self.forget(gone)
            if gone and gone == session_id:
                raise DriverError(BAD_TARGET, 'the page was closed while the command was in flight')
        self.events.append(msg)

    def forget(self, session_id):
        for target, sid in list(self.sessions.items()):
            if sid == session_id:
                del self.sessions[target]
                if self.casts:
                    self.casts.ended(target, 'the page was closed')

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


def session_for(conn, target_id, deadline):
    """The session for a tab. A one-shot connection always attaches; a served one attaches once."""
    session_id = conn.sessions.get(target_id)
    if not session_id:
        session_id = attach(conn, target_id, deadline)
        conn.sessions[target_id] = session_id
    return session_id


def connect(port, ws_url, deadline, casts=None):
    """A connection to Chromium, rediscovering once when a cached websocket URL has gone stale."""
    browser = ''
    if not ws_url:
        ws_url, browser = discover(int(port), deadline)
        return Conn(Ws(ws_url, deadline), casts), ws_url, browser
    try:
        ws = Ws(ws_url, deadline)
    except DriverError as exc:
        # A cached websocket URL goes stale every time Chromium restarts. One
        # rediscovery is cheaper than making every caller handle the relaunch.
        if exc.kind != UNREACHABLE or not port:
            raise
        ws_url, browser = discover(int(port), deadline)
        ws = Ws(ws_url, deadline)
    return Conn(ws, casts), ws_url, browser


# -- page actions ------------------------------------------------------------
#
# Each is a whole thing a person would do to a page, run from here so that a
# model's several actions cost one round rather than one round each. The
# page-side script they need is fixed text below, or built by the host from
# JSON-quoted arguments (`wait`, `snapshot`); none of it is the model's.

# Selecting first means `fill` replaces rather than appends. Same text as `Page.type` in page.ts.
SELECT_ACTIVE = "(() => { const el = document.activeElement; if (el && 'select' in el) el.select(); })()"
# insertText fires `input`; frameworks listening for `change` need the nudge.
CHANGE_ACTIVE = "(() => { const el = document.activeElement; if (el) el.dispatchEvent(new Event('change', { bubbles: true })); })()"


def evaluate(conn, session_id, expression, deadline):
    res = conn.call(
        'Runtime.evaluate',
        {'expression': expression, 'returnByValue': True, 'awaitPromise': True, 'userGesture': True},
        session_id,
        deadline,
    )
    exc = res.get('exceptionDetails')
    if exc:
        described = (exc.get('exception') or {}).get('description') or exc.get('text') or 'unknown error'
        raise DriverError(ACTION, 'the page threw: %s' % (described,))
    return (res.get('result') or {}).get('value')


def maybe_event(conn, event, session_id, seconds, deadline):
    """Whether `event` arrives within `seconds`. A clean timeout is an answer, not an error."""
    try:
        conn.wait_event(event, session_id, min(deadline, _now() + seconds))
        return True
    except DriverError as exc:
        if exc.kind == TIMEOUT and exc.details.get('boundary', True):
            return False
        raise


def resolve(conn, session_id, step, deadline):
    """The DOM node an action means: a ref from a snapshot, or a role and an accessible name."""
    ref = step.get('ref')
    if ref:
        if not (isinstance(ref, str) and ref[:1] == 'e' and ref[1:].isdigit()):
            raise DriverError(ACTION, '%r is not an element ref; refs look like e42' % (ref,))
        return int(ref[1:])
    role, name = step.get('role'), step.get('name')
    if not role and not name:
        raise DriverError(ACTION, 'say which element: a ref, or a role and a name')
    root = conn.call('DOM.getDocument', {'depth': 0}, session_id, deadline).get('root') or {}
    query = {'nodeId': root.get('nodeId')}
    if role:
        query['role'] = role
    if name:
        query['accessibleName'] = name
    for node in conn.call('Accessibility.queryAXTree', query, session_id, deadline).get('nodes') or []:
        if not node.get('ignored') and node.get('backendDOMNodeId'):
            return node['backendDOMNodeId']
    raise DriverError(ACTION, 'nothing on the page has role %r and name %r; take a snapshot' % (role, name))


def centre(conn, session_id, backend, deadline):
    try:
        conn.call('DOM.scrollIntoViewIfNeeded', {'backendNodeId': backend}, session_id, deadline)
    except DriverError as exc:
        if exc.kind != PROTOCOL:
            raise
    try:
        quad = conn.call('DOM.getBoxModel', {'backendNodeId': backend}, session_id, deadline)['model']['content']
    except (DriverError, KeyError, TypeError) as exc:
        if isinstance(exc, DriverError) and exc.kind != PROTOCOL:
            raise
        quad = None
    if not quad or len(quad) < 8:
        raise DriverError(ACTION, 'e%d is no longer on the page; take a snapshot and use the new ref' % backend)
    xs, ys = quad[0::2], quad[1::2]
    return (min(xs) + max(xs)) / 2.0, (min(ys) + max(ys)) / 2.0


def act_goto(conn, sid, step, deadline):
    url = step.get('url')
    nav = conn.call('Page.navigate', {'url': url}, sid, deadline)
    if nav.get('errorText'):
        raise DriverError(ACTION, 'could not load %s: %s' % (url, nav['errorText']))
    loaded = maybe_event(conn, 'Page.loadEventFired', sid, float(step.get('loadTimeoutMs', 30000)) / 1000.0, deadline)
    return {'url': evaluate(conn, sid, 'location.href', deadline), 'loaded': loaded}


def act_click(conn, sid, step, deadline):
    backend = resolve(conn, sid, step, deadline)
    x, y = centre(conn, sid, backend, deadline)
    base = {'x': x, 'y': y, 'button': 'left', 'clickCount': 1, 'buttons': 1}
    conn.call('Input.dispatchMouseEvent', dict(base, type='mousePressed'), sid, deadline)
    conn.call('Input.dispatchMouseEvent', dict(base, type='mouseReleased', buttons=0), sid, deadline)
    # Most clicks navigate nothing, so wait for a load only once one has started.
    navigated = maybe_event(conn, 'Page.frameStartedLoading', sid, 0.25, deadline)
    if navigated:
        maybe_event(conn, 'Page.loadEventFired', sid, float(step.get('loadTimeoutMs', 5000)) / 1000.0, deadline)
    return {'ref': 'e%d' % backend, 'navigated': navigated}


def act_fill(conn, sid, step, deadline):
    backend = resolve(conn, sid, step, deadline)
    conn.call('DOM.focus', {'backendNodeId': backend}, sid, deadline)
    evaluate(conn, sid, SELECT_ACTIVE, deadline)
    conn.call('Input.insertText', {'text': str(step.get('text', ''))}, sid, deadline)
    evaluate(conn, sid, CHANGE_ACTIVE, deadline)
    if step.get('submit'):
        enter = {'key': 'Enter', 'code': 'Enter', 'windowsVirtualKeyCode': 13, 'nativeVirtualKeyCode': 13}
        conn.call('Input.dispatchKeyEvent', dict(enter, type='keyDown', text='\r'), sid, deadline)
        conn.call('Input.dispatchKeyEvent', dict(enter, type='keyUp'), sid, deadline)
        maybe_event(conn, 'Page.loadEventFired', sid, 10.0, deadline)
    return {'ref': 'e%d' % backend}


def act_wait(conn, sid, step, deadline):
    started = _now()
    if evaluate(conn, sid, step['expression'], deadline) is not True:
        waited = int((_now() - started) * 1000)
        raise DriverError(ACTION, '%s did not %s within %d ms' % (step.get('what', 'it'), 'go away' if step.get('gone') else 'appear', waited))
    return {'found': True, 'waitedMs': int((_now() - started) * 1000)}


def act_snapshot(conn, sid, step, deadline):
    conn.call('Accessibility.enable', {}, sid, deadline)
    tree = conn.call('Accessibility.getFullAXTree', {}, sid, deadline)
    unreachable = []
    if step.get('framesExpression'):
        try:
            unreachable = evaluate(conn, sid, step['framesExpression'], deadline) or []
        except DriverError as exc:
            if exc.kind not in (PROTOCOL, ACTION):
                raise
    return {'nodes': tree.get('nodes') or [], 'unreachable': unreachable, 'url': evaluate(conn, sid, 'location.href', deadline)}


def act_screenshot(conn, sid, step, deadline):
    params = {'format': 'png', 'captureBeyondViewport': bool(step.get('fullPage'))}
    if step.get('fullPage'):
        metrics = conn.call('Page.getLayoutMetrics', {}, sid, deadline)
        size = metrics.get('cssContentSize') or metrics.get('contentSize') or {}
        if size.get('width') and size.get('height'):
            params['clip'] = {'x': 0, 'y': 0, 'width': size['width'], 'height': size['height'], 'scale': 1}
    data = conn.call('Page.captureScreenshot', params, sid, deadline).get('data')
    if not isinstance(data, str):
        raise DriverError(ACTION, 'Chromium returned no screenshot')
    return {'data': data}


# -- scripts -------------------------------------------------------------------
#
# A model-written Python script with real control flow -- if the login form is
# there, fill it; loop over the results -- in one tool call. It runs in its own
# process in the computer, never on the host and never in this one: a runaway
# loop is stopped at its limit (see `_kill_tree` for what that reaches), a
# crash is a traceback in its own process, and this driver, its socket and the
# screencast go on. Everything from the script is treated as hostile: its lines
# are read bounded, its answers written from a thread so it cannot block this
# one by not reading, and its output, result and error are capped.
#
# The script reaches the page through `page`, whose calls come back here as
# JSON lines and run as the same actions `browser_run` uses; every goto is
# checked by the host's network policy first. That is all the check covers:
# clicks, submits, redirects and page scripts are not checked, and the script,
# like `shell`, can open 127.0.0.1's CDP port itself. The computer is the
# boundary. Names follow ego-lite's Playwright-style page API where they fit
# (MIT, Copyright (c) 2026 CitroLabs).

SCRIPT_OUTPUT_CAP = 64 * 1024
SCRIPT_RESULT_CAP = 64 * 1024
SCRIPT_ERROR_CAP = 16 * 1024
# One line from a script, read at most this much at a time and dropped past it.
SCRIPT_LINE_CAP = 1024 * 1024
# Answers held for a script that has stopped reading them, before it is stopped.
SCRIPT_BACKLOG_CAP = 1000
OVERSIZED = object()


class ScriptStalled(Exception):
    """The script stopped reading its answers: nothing it does can be trusted to finish."""

SCRIPT_RUNNER = r'''
import json, linecache, sys, time, traceback

_chan, _replies = sys.stdout, sys.stdin


class PageError(Exception):
    """A page call the browser refused: no such element, a URL the policy forbids."""


def _send(obj):
    _chan.write(json.dumps(obj) + "\n")
    _chan.flush()


def _call(op, **args):
    _send({"t": "call", "op": op, "args": dict((k, v) for k, v in args.items() if v is not None)})
    line = _replies.readline()
    if not line:
        raise SystemExit(1)
    reply = json.loads(line)
    if not reply.get("ok"):
        raise PageError(reply.get("error") or "the page call failed")
    return reply.get("value")


class _Printed(object):
    def write(self, s):
        # In pieces, so one huge print is many small lines, none of them over
        # what the driver will read in one go.
        for i in range(0, len(s), 16384):
            _send({"t": "print", "s": s[i:i + 16384]})
        return len(s)

    def flush(self):
        pass


class Page(object):
    def goto(self, url, timeout=30):
        return _call("goto", url=url, timeout=timeout)

    def click(self, ref=None, role=None, name=None):
        return _call("click", ref=ref, role=role, name=name)

    def fill(self, text, ref=None, role=None, name=None, submit=False):
        return _call("fill", text=text, ref=ref, role=role, name=name, submit=submit or None)

    def wait_for_text(self, text, timeout=15, gone=False):
        return _call("wait", text=text, timeout=timeout, gone=gone or None)

    def wait_for_url(self, part, timeout=15):
        return _call("wait", url=part, timeout=timeout)

    def wait_for_selector(self, selector, timeout=15, gone=False):
        return _call("wait", selector=selector, timeout=timeout, gone=gone or None)

    def has_text(self, text):
        return _call("wait", text=text, timeout=0)

    def snapshot(self, limit=400):
        return _call("snapshot", limit=limit)

    def text(self, ref=None, selector=None, role=None, name=None):
        return _call("text", ref=ref, selector=selector, role=role, name=name)

    def url(self):
        return _call("url")

    def title(self):
        return _call("title")


def _main():
    source = json.loads(_replies.readline())["script"]
    linecache.cache["<script>"] = (len(source), None, source.splitlines(True), "<script>")
    scope = {"__name__": "__script__", "page": Page(), "sleep": time.sleep, "PageError": PageError}
    sys.stdout = sys.stderr = _Printed()
    try:
        exec(compile(source, "<script>", "exec"), scope)
    except SystemExit as exc:
        if exc.code not in (None, 0):
            _send({"t": "error", "traceback": "the script exited with %r" % (exc.code,)})
            return
    except BaseException as exc:
        tb = exc.__traceback__
        while tb is not None and tb.tb_frame.f_code.co_filename != "<script>":
            tb = tb.tb_next
        text = "".join(traceback.format_exception(type(exc), exc, tb))
        if len(text) > 16384:
            text = text[:8192] + "\n[... %d characters cut ...]\n" % (len(text) - 16384) + text[-8192:]
        _send({"t": "error", "traceback": text})
        return
    result = scope.get("result")
    try:
        encoded = json.dumps(result)
    except (TypeError, ValueError):
        result = repr(result)
        encoded = json.dumps(result)
    # Capped here so the line is small; the driver caps it again, since a
    # script can write to the pipe without going through this.
    if len(encoded) > 65536:
        _send({"t": "done", "result": encoded[:65536], "resultTruncated": True})
        return
    _send({"t": "done", "result": result})


_main()
'''


def _wait_js(probe, want, timeout_ms):
    """The page-side wait loop. Same shape as `waitExpression` in page.ts."""
    return (
        '(async () => { const deadline = Date.now() + %d; '
        'while (Date.now() < deadline) { if ((%s) === %s) return true; '
        'await new Promise((r) => setTimeout(r, 100)); } return (%s) === %s; })()'
    ) % (max(0, int(timeout_ms)), probe, want, probe, want)


def script_call(conn, sid, op, args, deadline):
    """One `page.*` call from a script: its value, or a DriverError the script sees as PageError."""
    # Events from before this call are not this call's.
    conn.events = []
    timeout = min(600.0, max(0.0, float(args.get('timeout', 15) or 0)))
    if op == 'goto':
        url = BRIDGE.host_call(conn, 'checkUrl', {'url': str(args.get('url', ''))}, deadline)
        return act_goto(conn, sid, {'url': url, 'loadTimeoutMs': timeout * 1000}, deadline)
    if op == 'click':
        return act_click(conn, sid, args, deadline)
    if op == 'fill':
        return act_fill(conn, sid, args, deadline)
    if op == 'wait':
        if args.get('selector') is not None:
            probe = '!!document.querySelector(%s)' % json.dumps(args['selector'])
        elif args.get('url') is not None:
            probe = 'location.href.includes(%s)' % json.dumps(args['url'])
        else:
            probe = 'document.body ? document.body.innerText.includes(%s) : false' % json.dumps(args.get('text', ''))
        want = 'false' if args.get('gone') else 'true'
        return evaluate(conn, sid, _wait_js(probe, want, timeout * 1000), deadline) is True
    if op == 'snapshot':
        raw = act_snapshot(conn, sid, {}, deadline)
        return BRIDGE.host_call(conn, 'compact', {'nodes': raw['nodes'], 'limit': args.get('limit', 400)}, deadline)
    if op == 'text':
        if args.get('ref') or args.get('role') or args.get('name'):
            backend = resolve(conn, sid, args, deadline)
            obj = conn.call('DOM.resolveNode', {'backendNodeId': backend}, sid, deadline).get('object') or {}
            res = conn.call(
                'Runtime.callFunctionOn',
                {'objectId': obj.get('objectId'), 'functionDeclaration': 'function () { return this.innerText ?? this.textContent ?? ""; }', 'returnByValue': True},
                sid,
                deadline,
            )
            return (res.get('result') or {}).get('value')
        sel = json.dumps(args.get('selector') or 'body')
        return evaluate(conn, sid, '(() => { const el = document.querySelector(%s); return el ? el.innerText : null; })()' % sel, deadline)
    if op == 'url':
        return evaluate(conn, sid, 'location.href', deadline)
    if op == 'title':
        return evaluate(conn, sid, 'document.title', deadline)
    raise DriverError(ACTION, 'there is no page.%s' % (op,))


def _head_tail(text, cap):
    """Text cut in the middle to `cap` characters, so its start and its end both survive."""
    if len(text) <= cap:
        return text
    half = cap // 2
    return text[:half] + '\n[... %d characters cut ...]\n' % (len(text) - cap) + text[-half:]


def _tagged(tag):
    """Every process whose environment carries this script's tag. Linux: it reads /proc."""
    needle = ('HUSK_SCRIPT=%s' % tag).encode('ascii')
    found = []
    for path in glob.glob('/proc/[0-9]*/environ'):
        try:
            with open(path, 'rb') as handle:
                if needle in handle.read().split(b'\0'):
                    found.append(int(path.split('/')[2]))
        except (OSError, ValueError):
            pass
    return found


def _kill_tree(child, tag):
    """
    The script, its process group, and every process still carrying its tag.

    A grandchild that calls setsid leaves the group, so the group signal misses
    it, but it keeps the tag in its environment and that finds it. One that
    also scrubs its own environment escapes both -- the honest limit of this,
    and the same as a process started from `shell`. Such a survivor can hold
    the pipes open; the reader threads are daemons, nothing here joins them
    for more than a moment, and closing a pipe another thread is blocked
    reading would deadlock on its lock, so the pipes are left to the reaper.
    """
    if os.name == 'posix':
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except Exception:
            pass
        for pid in _tagged(tag):
            try:
                os.kill(pid, signal.SIGKILL)
            except Exception:
                pass
    else:
        try:
            child.kill()
        except Exception:
            pass
    try:
        child.wait(timeout=5)
    except Exception:
        pass


def act_script(conn, sid, step, deadline):
    if BRIDGE is None:
        raise DriverError(ACTION, 'scripts need the long-lived driver, which this provider cannot keep running; use browser_run')
    started = _now()
    tag = base64.b16encode(os.urandom(8)).decode('ascii')
    options = {
        'stdin': subprocess.PIPE,
        'stdout': subprocess.PIPE,
        'stderr': subprocess.PIPE,
        'env': dict(os.environ, HUSK_SCRIPT=tag),
    }
    if os.name == 'posix':
        options['start_new_session'] = True
    child = subprocess.Popen([sys.executable, '-I', '-c', SCRIPT_RUNNER], **options)

    # Bounded both ways. Lines from the script queue up to a limit and then
    # the reader stops reading, so a script that floods its stdout blocks on
    # its own write rather than filling this process; a line past
    # SCRIPT_LINE_CAP is dropped as it is read, never held whole. Replies go
    # out from a thread, so a script that stops reading its stdin stalls that
    # thread and never this one -- which still enforces the limit.
    got = queue.Queue(maxsize=256)
    replies = queue.Queue()
    stopping = threading.Event()
    stderr = []

    def offer(item):
        while not stopping.is_set():
            try:
                got.put(item, timeout=0.2)
                BRIDGE.wake()
                return
            except queue.Full:
                pass

    def read_stdout():
        dropping = False
        for raw in iter(lambda: child.stdout.readline(SCRIPT_LINE_CAP), b''):
            whole = raw.endswith(b'\n')
            if dropping or not whole:
                if not dropping:
                    offer(OVERSIZED)
                dropping = not whole
                continue
            offer(raw)
        offer(None)

    def read_stderr():
        for raw in iter(lambda: child.stderr.readline(SCRIPT_LINE_CAP), b''):
            if sum(len(b) for b in stderr) < 16384:
                stderr.append(raw)

    def write_replies():
        while True:
            data = replies.get()
            if data is None:
                return
            try:
                child.stdin.write(data)
                child.stdin.flush()
            except (OSError, ValueError):
                return

    for target in (read_stdout, read_stderr, write_replies):
        thread = threading.Thread(target=target)
        thread.daemon = True
        thread.start()

    def tell(obj):
        if replies.qsize() >= SCRIPT_BACKLOG_CAP:
            raise ScriptStalled()
        replies.put((json.dumps(obj) + '\n').encode('utf-8'))

    printed = []
    out = {'size': 0, 'truncated': False, 'resultTruncated': False}

    def say(text):
        room = SCRIPT_OUTPUT_CAP - out['size']
        if room <= 0:
            out['truncated'] = True
            return
        if len(text) > room:
            text, out['truncated'] = text[:room], True
        printed.append(text)
        out['size'] += len(text)

    result, error, finished = None, None, False
    try:
        tell({'script': str(step.get('source', ''))})
        while not finished:
            try:
                BRIDGE.wait(conn, lambda: not got.empty(), deadline)
            except DriverError as exc:
                if exc.kind != TIMEOUT or not exc.details.get('boundary', True):
                    raise
                error = 'the script was still running at its %d s limit and was stopped' % int(step.get('limitSec', 0))
                break
            raw = got.get_nowait()
            if raw is None:
                tail = b''.join(stderr).decode('utf-8', 'replace')[-4000:].strip()
                error = 'the script exited without finishing' + (':\n' + tail if tail else '')
                break
            if raw is OVERSIZED:
                say('\n[a line of over %d bytes was dropped]\n' % SCRIPT_LINE_CAP)
                continue
            try:
                msg = json.loads(raw)
            except ValueError:
                msg = {'t': 'print', 's': raw.decode('utf-8', 'replace')}
            kind = msg.get('t') if isinstance(msg, dict) else None
            if kind == 'call':
                try:
                    reply = {'ok': True, 'value': script_call(conn, sid, msg.get('op'), msg.get('args') or {}, deadline)}
                except DriverError as exc:
                    # The page said no: the script sees a PageError and decides.
                    # A dead browser or a desynced socket still fails the request.
                    if exc.kind not in (PROTOCOL, ACTION, BAD_TARGET):
                        raise
                    reply = {'ok': False, 'error': exc.message}
                tell(reply)
            elif kind == 'done':
                # Capped here too: the runner caps it, but a script can write
                # to the pipe without going through the runner.
                result, finished = msg.get('result'), True
                encoded = json.dumps(result)
                if len(encoded) > SCRIPT_RESULT_CAP:
                    result, out['resultTruncated'] = encoded[:SCRIPT_RESULT_CAP], True
                elif msg.get('resultTruncated'):
                    out['resultTruncated'] = True
            elif kind == 'error':
                error, finished = _head_tail(str(msg.get('traceback') or 'the script failed'), SCRIPT_ERROR_CAP), True
            else:
                say(str(msg.get('s', '')) if kind == 'print' else raw.decode('utf-8', 'replace'))
    except ScriptStalled:
        error = 'the script stopped reading the answers to its page calls and was stopped'
    finally:
        stopping.set()
        replies.put(None)
        _kill_tree(child, tag)
    return {
        'output': ''.join(printed),
        'truncated': out['truncated'],
        'result': result,
        'resultTruncated': out['resultTruncated'],
        'error': error,
        'ms': int((_now() - started) * 1000),
    }


ACTIONS = {
    'goto': act_goto,
    'click': act_click,
    'fill': act_fill,
    'wait': act_wait,
    'snapshot': act_snapshot,
    'screenshot': act_screenshot,
    'script': act_script,
}


def execute(conn, session_id, steps, deadline):
    results = []
    halted = False
    for step in steps:
        op = step.get('op', 'send')
        step_deadline = deadline
        if step.get('timeoutMs') is not None:
            step_deadline = min(deadline, _now() + float(step['timeoutMs']) / 1000.0)
        routed = session_id if step.get('session') else None

        if halted:
            results.append({'skipped': True})
            continue

        skip = step.get('skipIf')
        if skip is not None:
            index = int(skip.get('step', -1))
            prior = results[index] if -len(results) <= index < len(results) else None
            if isinstance(prior, dict) and prior.get(skip.get('key')):
                results.append({'skipped': True})
                continue

        # The inverse: run this step only if an earlier one succeeded.
        # Needed because a one-shot driver is a fresh process with a fresh
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
        elif op == 'action':
            fn = ACTIONS.get(step.get('do'))
            if fn is None:
                raise DriverError(INTERNAL, 'unknown action %r' % (step.get('do'),))
            if not session_id:
                raise DriverError(BAD_TARGET, 'a page action needs a page; the request named no target')
            # Events from before this action are not this action's: a load the
            # previous goto saw must not read as this click navigating.
            conn.events = []
            try:
                results.append(fn(conn, session_id, step, step_deadline))
            except DriverError as exc:
                # The page said no, or the element is not there: the run stops
                # here and says so. A dead browser still fails the whole request.
                if exc.kind not in (PROTOCOL, ACTION):
                    raise
                results.append({'error': exc.message})
                halted = True
        else:
            raise DriverError(INTERNAL, 'unknown step op %r' % (op,))
    return results


def run(req):
    """One request, one connection: the fallback for providers that cannot keep stdin open."""
    deadline = _now() + float(req.get('timeoutMs', 60000)) / 1000.0
    conn, ws_url, browser = connect(req.get('port'), req.get('ws'), deadline)
    try:
        session_id = None
        target_id = req.get('targetId')
        # A session belongs to a connection, so it cannot be cached across
        # invocations the way a target id can. Attaching per call is the price
        # of statelessness, and it is one round trip on a loopback socket.
        if target_id:
            session_id = session_for(conn, target_id, deadline)
        out = {'ok': True, 'results': execute(conn, session_id, req.get('steps') or [], deadline), 'ws': ws_url}
        if browser:
            out['browser'] = browser
        if session_id:
            out['sessionId'] = session_id
        return out
    finally:
        conn.ws.close()


# -- serve mode ----------------------------------------------------------------


class Casts(object):
    """The screencasts being pushed, one per tab, and the acks they are owed."""

    def __init__(self, emit):
        self.emit = emit
        self.by_target = {}

    def start(self, conn, target_id, session_id, fps, quality, deadline):
        cast = self.by_target.get(target_id)
        if cast and cast['sid'] == session_id:
            cast['fps'] = fps  # the pace is ours, so changing it needs no restart
            return
        conn.call('Page.startScreencast', {'format': 'jpeg', 'quality': quality, 'everyNthFrame': 1}, session_id, deadline)
        self.by_target[target_id] = {'sid': session_id, 'fps': fps, 'owed': None, 'due': 0.0}

    def stop(self, conn, target_id, deadline):
        cast = self.by_target.pop(target_id, None)
        if not cast:
            return
        try:
            conn.call('Page.stopScreencast', {}, cast['sid'], deadline)
        except DriverError as exc:
            if exc.kind != PROTOCOL:
                raise

    def take(self, conn, msg):
        """Push a frame out and owe its ack. True when the message was a frame."""
        if msg.get('method') != 'Page.screencastFrame':
            return False
        target = next((t for t, c in self.by_target.items() if c['sid'] == msg.get('sessionId')), None)
        if target is None:
            return True  # from a cast just stopped; leaving it unacked ends it
        cast = self.by_target[target]
        params = msg.get('params') or {}
        meta = params.get('metadata') or {}
        self.emit({
            'event': 'frame',
            'targetId': target,
            'data': params.get('data', ''),
            # CSS pixels, so a click on the picture maps back whatever the device scale.
            'width': int(round(meta.get('deviceWidth') or 0)),
            'height': int(round(meta.get('deviceHeight') or 0)),
        })
        # Chromium sends the next frame only once this one is acked, so the ack
        # is the throttle. A little early, because the next frame takes time to
        # arrive; the host holds each viewer to its own rate exactly.
        cast['owed'] = params.get('sessionId')
        cast['due'] = _now() + 0.9 / max(1, cast['fps'])
        return True

    def next_due(self):
        due = [c['due'] for c in self.by_target.values() if c['owed'] is not None]
        return min(due) if due else None

    def ack_due(self, conn):
        now = _now()
        for cast in self.by_target.values():
            if cast['owed'] is not None and cast['due'] <= now:
                conn.send_only('Page.screencastFrameAck', {'sessionId': cast['owed']}, cast['sid'])
                cast['owed'] = None

    def ended(self, target_id, reason):
        if self.by_target.pop(target_id, None) is not None:
            self.emit({'event': 'castEnded', 'targetId': target_id, 'reason': reason})

    def all_ended(self, reason):
        for target_id in list(self.by_target):
            self.ended(target_id, reason)


def failure(exc):
    return {'ok': False, 'kind': exc.kind, 'message': exc.message, 'details': exc.details}


def crash(exc):
    return {
        'ok': False,
        'kind': INTERNAL,
        'message': 'the browser driver crashed: %s' % (exc,),
        'details': {'traceback': traceback.format_exc()[-2000:]},
    }


class Bridge(object):
    """
    Serve mode's lines in from the host, and its questions back to the host.

    A script needs answers only the host has -- may this URL be visited, what
    does this tree compact to -- in the middle of a request. So the driver can
    ask (`{"event": "host", "call": n, ...}`), and while it waits it keeps the
    screencast's frames and acks moving. Host lines that are not replies wait
    their turn in `deferred`: one request at a time, as ever.
    """

    def __init__(self, emit, casts):
        self.emit = emit
        self.casts = casts
        self.lines = queue.Queue()
        self.wake_r, self.wake_w = socket.socketpair()
        self.deferred = []
        self.replies = {}
        self.next_call = 1
        # The host closed stdin: whatever is in flight is for nobody now.
        self.closing = False

    def wake(self):
        try:
            self.wake_w.send(b'.')
        except OSError:
            pass

    def drain(self):
        """Take replies to host calls; queue everything else, stdin's end included."""
        while True:
            try:
                raw = self.lines.get_nowait()
            except queue.Empty:
                return
            if raw is not None:
                if not raw.strip():
                    continue
                try:
                    msg = json.loads(raw)
                except ValueError:
                    msg = None
                if isinstance(msg, dict) and msg.get('op') == 'hostReply':
                    self.replies[msg.get('call')] = msg
                    continue
            else:
                self.closing = True
            self.deferred.append(raw)

    def wait(self, conn, ready, deadline):
        """Block until `ready()`, pumping Chromium meanwhile. A clean TIMEOUT at the deadline."""
        while not ready():
            if self.closing:
                # Killed from the host, or the host went away: stop the script
                # now rather than at its limit, and let the loop exit.
                raise DriverError(BROWSER_GONE, 'the host closed the driver')
            now = _now()
            if now >= deadline:
                raise DriverError(TIMEOUT, 'ran out of time', {'boundary': True})
            timeout = deadline - now
            due = self.casts.next_due()
            if due is not None:
                timeout = min(timeout, max(0.0, due - now))
            if conn.ws.buf:
                timeout = 0.0
            ready_socks = select.select([self.wake_r, conn.ws.sock], [], [], timeout)[0]
            if conn.ws.buf or conn.ws.sock in ready_socks:
                msg = conn._pump(_now() + PAYLOAD_GRACE_SEC)
                if 'method' in msg:
                    conn._note(msg, None)
                conn.events = []
            self.casts.ack_due(conn)
            if self.wake_r in ready_socks:
                self.wake_r.recv(4096)
                self.drain()

    def host_call(self, conn, op, args, deadline):
        call = self.next_call
        self.next_call += 1
        self.emit(dict(args, event='host', call=call, op=op))
        self.wait(conn, lambda: call in self.replies, deadline)
        reply = self.replies.pop(call)
        if reply.get('error'):
            raise DriverError(ACTION, str(reply['error']))
        return reply.get('value')


# Set by `serve`. A one-shot driver has no host to ask, so it runs no scripts.
BRIDGE = None


def serve(port):
    """Answer requests on stdin until it closes, holding one connection to Chromium throughout."""
    global BRIDGE

    def emit(obj):
        sys.stdout.write(json.dumps(obj) + '\n')
        sys.stdout.flush()

    casts = Casts(emit)
    bridge = BRIDGE = Bridge(emit, casts)
    state = {'conn': None}

    def drop(reason):
        conn, state['conn'] = state['conn'], None
        casts.all_ended(reason)
        if conn:
            conn.ws.close()

    def answer(req):
        deadline = _now() + float(req.get('timeoutMs', 60000)) / 1000.0
        if state['conn'] is None:
            state['conn'] = connect(port, None, deadline, casts)[0]
        conn = state['conn']
        # Events are only ever waited for within the request that caused them.
        conn.events = []
        op = req.get('op')
        target_id = req.get('targetId')
        if op == 'screencastStop':
            casts.stop(conn, target_id, deadline)
            return {'ok': True}
        session_id = session_for(conn, target_id, deadline) if target_id else None
        if op == 'screencast':
            fps = min(30, max(1, int(req.get('fps', 4))))
            casts.start(conn, target_id, session_id, fps, int(req.get('quality', 60)), deadline)
            return {'ok': True}
        return {'ok': True, 'results': execute(conn, session_id, req.get('steps') or [], deadline)}

    def handle(raw):
        try:
            req = json.loads(raw)
        except Exception as exc:
            emit({'id': None, 'ok': False, 'kind': INTERNAL, 'message': 'the driver was given a line it could not parse', 'details': {'cause': str(exc)}})
            return
        try:
            out = answer(req)
        except DriverError as exc:
            out = failure(exc)
            # Unreachable, gone, or a stream desynced mid-frame: the socket is no
            # use any more. The next request reconnects, rediscovering the URL.
            if exc.kind in (UNREACHABLE, BROWSER_GONE) or (exc.kind == TIMEOUT and not exc.details.get('boundary', True)):
                drop(exc.message)
        except Exception as exc:
            out = crash(exc)
        out['id'] = req.get('id')
        emit(out)

    # A thread reads stdin because select() takes only sockets on some
    # platforms; it wakes the loop through a socket pair, which select takes
    # everywhere.
    def read_stdin():
        for raw in sys.stdin.buffer:
            bridge.lines.put(raw)
            bridge.wake()
        bridge.lines.put(None)
        bridge.wake()

    reader = threading.Thread(target=read_stdin)
    reader.daemon = True
    reader.start()

    while True:
        # Lines a script's wait already read off stdin come first, in order.
        while bridge.deferred:
            raw = bridge.deferred.pop(0)
            if raw is None:
                drop('stdin closed')
                return 0
            handle(raw)

        conn = state['conn']
        watch = [bridge.wake_r] + ([conn.ws.sock] if conn else [])
        due = casts.next_due()
        timeout = None if due is None else max(0.0, due - _now())
        if conn and conn.ws.buf:
            timeout = 0.0
        ready = select.select(watch, [], [], timeout)[0]

        if conn and (conn.ws.buf or conn.ws.sock in ready):
            try:
                msg = conn._pump(_now() + PAYLOAD_GRACE_SEC)
                if 'method' in msg:
                    conn._note(msg, None)
                # Nobody is waiting between requests, so nothing is kept.
                conn.events = []
            except DriverError as exc:
                drop(exc.message)
        if state['conn']:
            try:
                casts.ack_due(state['conn'])
            except DriverError as exc:
                drop(exc.message)

        if bridge.wake_r in ready:
            bridge.wake_r.recv(4096)
            bridge.drain()


def main(argv):
    if len(argv) == 3 and argv[1] == '--serve':
        return serve(int(argv[2]))

    try:
        raw = sys.stdin.read()
        req = json.loads(raw) if raw.strip() else {}
    except Exception as exc:
        sys.stdout.write(json.dumps({'ok': False, 'kind': INTERNAL, 'message': 'the driver was given input it could not parse', 'details': {'cause': str(exc)}}))
        return 0

    try:
        out = run(req)
    except DriverError as exc:
        out = failure(exc)
    except Exception as exc:
        out = crash(exc)

    sys.stdout.write(json.dumps(out))
    sys.stdout.flush()
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
