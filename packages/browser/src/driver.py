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
a model's several actions are one round too (code over calls; see
THIRD_PARTY_NOTICES.md). Actions are data: nothing a
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
import re
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
        # What pages do besides answer: dialogs answered during the current
        # action, downloads by guid, and tabs opened since discovery began.
        self.prepared = False
        self.discovering = False
        self.dialog_answer = None
        self.dialogs = []
        self.downloads = {}
        self.popups = []
        # A cross-site frame runs in its own process, reached only through its
        # own session: child session -> {'parent': session, 'frame': frame id}.
        self.frame_sessions = {}
        self.auto_attached = set()
        # The network policy the host sends ({'network', 'loopbackIsOwn'}), and the
        # loads it stopped since the action began. None: nothing is intercepted.
        self.policy = None
        self.blocked = []
        # 'lightpanda' when the host says so; Chromium otherwise. Lightpanda's page
        # lives as long as this connection, and its dialogs answer themselves.
        self.engine = None
        self.downloads_dir = None
        self.downloads_armed = False

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
        method = msg.get('method')
        params = msg.get('params') or {}
        if method == 'Page.javascriptDialogOpening':
            self.answer_dialog(msg.get('sessionId'), params)
            return
        if method == 'Fetch.requestPaused':
            self.decide(msg.get('sessionId'), params)
            return
        if method == 'Browser.downloadWillBegin':
            self.downloads[params.get('guid')] = {'name': params.get('suggestedFilename') or '', 'state': 'inProgress'}
        elif method == 'Browser.downloadProgress':
            known = self.downloads.get(params.get('guid'))
            if known is not None:
                known['state'] = params.get('state') or known['state']
                if params.get('totalBytes'):
                    known['bytes'] = params['totalBytes']
        elif method == 'Target.targetCreated' and self.discovering:
            info = params.get('targetInfo') or {}
            if info.get('type') == 'page':
                self.popups.append({'targetId': info.get('targetId') or '', 'url': info.get('url') or ''})
        elif method == 'Target.attachedToTarget':
            info = params.get('targetInfo') or {}
            child = params.get('sessionId')
            if child and info.get('type') == 'iframe':
                self.frame_sessions[child] = {'parent': msg.get('sessionId'), 'frame': info.get('targetId')}
                self.guard(child, 'iframe', params.get('waitingForDebugger'))
            elif child and info.get('type') == 'page':
                # One session per tab, so a load is decided once and a dialog answered once.
                self.sessions.setdefault(info.get('targetId'), child)
                self.guard(child, 'page', params.get('waitingForDebugger'))
        elif method == 'Target.targetInfoChanged':
            info = params.get('targetInfo') or {}
            for popup in self.popups:
                if popup['targetId'] == info.get('targetId') and info.get('url'):
                    popup['url'] = info['url']
        # A target that detaches takes the page with it; without this, a closed
        # tab means the caller waits out the whole budget for nothing.
        if msg.get('method') == 'Target.detachedFromTarget':
            gone = (msg.get('params') or {}).get('sessionId')
            frame = gone in self.frame_sessions
            self.forget(gone)
            if gone and gone == session_id:
                if frame:
                    raise DriverError(ACTION, 'the frame went away while the command was in flight; take a fresh snapshot')
                raise DriverError(BAD_TARGET, 'the page was closed while the command was in flight')
        self.events.append(msg)

    def answer_dialog(self, session_id, params):
        """
        A dialog blocks its page, and every command on it, until it is answered,
        so it is answered at once: an alert or a leave-this-page accepted, a
        confirm or a prompt dismissed unless the action said to accept it. The
        action's result says which, so nothing about it is silent.
        """
        kind = params.get('type') or 'alert'
        accept = kind in ('alert', 'beforeunload') or self.dialog_answer == 'accept'
        self.send_only('Page.handleJavaScriptDialog', {'accept': accept}, session_id)
        self.dialogs.append({'type': kind, 'message': (params.get('message') or '')[:300], 'answer': 'accepted' if accept else 'dismissed'})

    def guard(self, session_id, kind, waiting):
        """
        A tab or a cross-site frame, before it runs: its document loads go by the
        network policy, its dialogs are answered (a pop-up can alert as it opens),
        and a frame's own cross-site frames are guarded the same way as they
        attach. Sent without waiting for the answers, since this runs while
        events are read; Chromium does a session's commands in order, so all of
        it is in place before the target is let go.
        """
        if self.policy is not None:
            self.send_only('Fetch.enable', DOCUMENTS, session_id)
        if kind == 'iframe':
            for domain in ('Page', 'DOM'):
                self.send_only(domain + '.enable', {}, session_id)
            self.send_only('Target.setAutoAttach', FRAMES, session_id)
            self.auto_attached.add(session_id)
        else:
            self.send_only('Page.enable', {}, session_id)
        if waiting:
            self.send_only('Runtime.runIfWaitingForDebugger', {}, session_id)

    def decide(self, session_id, params):
        """A document load the policy stopped is said in the action's result; the rest go on."""
        request_id = params.get('requestId')
        url = (params.get('request') or {}).get('url') or ''
        reason = policy_refuses(url, self.policy)
        if reason is None:
            self.send_only('Fetch.continueRequest', {'requestId': request_id}, session_id)
            return
        self.send_only('Fetch.failRequest', {'requestId': request_id, 'errorReason': 'BlockedByClient'}, session_id)
        self.blocked.append({'url': url[:300], 'reason': reason})
        # ponytail: the last 50 kept, for a page that keeps trying while nobody is acting on it.
        del self.blocked[:-50]

    def forget(self, session_id):
        self.frame_sessions.pop(session_id, None)
        self.auto_attached.discard(session_id)
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


# -- the network policy, for what a page loads by itself ------------------------
#
# The host checks the URLs it sends the browser to; these check the documents a
# page loads on its own -- a redirect's next hop, a link, a frame, a pop-up -- so
# the policy holds below the tool. net.ts is the one answer, ported here line for
# line, and driver-policy.test.ts holds the two to one table: a security check
# with two answers is not a security check. Subresources (images, scripts,
# fetches) are not documents and are not checked.

# Every document request, paused before it is sent.
DOCUMENTS = {'patterns': [{'urlPattern': '*', 'resourceType': 'Document', 'requestStage': 'Request'}]}
# A session's cross-site frames, each attached and held until it is guarded.
FRAMES = {'autoAttach': True, 'waitForDebuggerOnStart': True, 'flatten': True, 'filter': [{'type': 'iframe'}]}


def _one_dot(s):
    s = s.lower()
    return s[:-1] if s.endswith('.') else s


def host_matches(host, pattern):
    h, p = _one_dot(host), _one_dot(pattern)
    if p == '*':
        return True
    if p.startswith('*.'):
        suffix = p[1:]
        return h.endswith(suffix) and len(h) > len(suffix)
    return h == p


def ipv4_octets(host):
    """The four octets of an IPv4 literal in any spelling inet_aton takes (127.1, 0x7f000001), or None."""
    parts = host.split('.')
    if len(parts) > 4 or any(part == '' for part in parts):
        return None
    nums = []
    for part in parts:
        if re.fullmatch(r'0[xX][0-9a-fA-F]+', part):
            nums.append(int(part, 16))
        elif re.fullmatch(r'0[0-7]+', part):
            nums.append(int(part, 8))
        elif re.fullmatch(r'[0-9]+', part):
            nums.append(int(part))
        else:
            return None
    last = nums.pop()
    width = 4 - len(nums)
    if last >= 256 ** width or any(n > 255 for n in nums):
        return None
    octets = nums + [(last >> (8 * i)) & 0xff for i in range(width - 1, -1, -1)]
    return octets if len(octets) == 4 else None


def ipv6_groups(host):
    """An IPv6 literal as its eight 16-bit groups, or None."""
    if ':' not in host:
        return None
    h = host
    tail = re.fullmatch(r'(.*:)([^:]*\.[^:]*)', h)
    if tail:
        v4 = ipv4_octets(tail.group(2))
        if not v4:
            return None
        h = '%s%x:%x' % (tail.group(1), (v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3])
    halves = h.split('::')
    if len(halves) > 2:
        return None

    def groups(part):
        if part == '':
            return []
        out = []
        for g in part.split(':'):
            if not re.fullmatch(r'[0-9a-f]{1,4}', g):
                return None
            out.append(int(g, 16))
        return out

    head = groups(halves[0])
    rest = groups(halves[1]) if len(halves) == 2 else []
    if head is None or rest is None:
        return None
    missing = 8 - len(head) - len(rest)
    if (missing != 0) if len(halves) == 1 else (missing < 1):
        return None
    return head + [0] * (missing if len(halves) == 2 else 0) + rest


def embedded_v4(g):
    """The IPv4 address an IPv6 one carries -- mapped, compatible, or NAT64 -- or None."""
    v4 = [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]
    zeros = lambda a, b: all(x == 0 for x in g[a:b])  # noqa: E731
    if zeros(0, 5) and g[5] == 0xffff:
        return v4
    if zeros(0, 6):
        return v4
    if g[0] == 0x64 and g[1] == 0xff9b and zeros(2, 6):
        return v4
    return None


def internal_v4(o):
    a, b = o[0], o[1]
    return (
        a in (127, 0, 10)
        or (a == 169 and b == 254)
        or (a == 172 and 16 <= b <= 31)
        or (a == 192 and b == 168)
        or (a == 100 and 64 <= b <= 127)
    )


def _bare(host):
    return re.sub(r'^\[|\]\Z', '', _one_dot(host))


def loopback_groups(g):
    v4 = embedded_v4(g)
    return v4 is not None and v4[0] in (127, 0)


def is_internal_host(host):
    h = _bare(host)
    if h == 'localhost' or h.endswith('.localhost') or h.endswith('.local'):
        return True
    if h.endswith('.internal') or h == 'metadata.google.internal':
        return True
    g = ipv6_groups(h)
    if g:
        if loopback_groups(g):
            return True
        if (g[0] & 0xfe00) == 0xfc00 or (g[0] & 0xffc0) in (0xfe80, 0xfec0):
            return True
        v4 = embedded_v4(g)
        return v4 is not None and internal_v4(v4)
    v4 = ipv4_octets(h)
    return v4 is not None and internal_v4(v4)


def is_loopback_host(host):
    h = _bare(host)
    if h == 'localhost' or h.endswith('.localhost'):
        return True
    g = ipv6_groups(h)
    if g:
        return loopback_groups(g)
    v4 = ipv4_octets(h)
    return v4 is not None and v4[0] in (127, 0)


def host_allowed(host, network, loopback_is_own):
    """net.ts's isHostAllowed: the floor first, so `full` cannot reach the metadata address, then the mode."""
    explicitly = any(host_matches(host, pattern) for pattern in ((network or {}).get('allow') or []))
    if not explicitly:
        if is_loopback_host(host):
            if not loopback_is_own:
                return False
        elif is_internal_host(host):
            return False
    if network is None:
        return True
    if any(host_matches(host, pattern) for pattern in (network.get('deny') or [])):
        return False
    mode = network.get('mode')
    if mode == 'full':
        return True
    if mode == 'egress':
        return explicitly
    return False


def policy_refuses(url, policy):
    """
    Why the network policy refuses a document a page asked for, or None when it
    may load. Only http and https leave the browser: about:, data: and blob: are
    the page's own.
    """
    if policy is None:
        return None
    try:
        parsed = urlparse(url)
        host = parsed.hostname
    except ValueError:
        return 'an address it cannot read'
    if parsed.scheme not in ('http', 'https'):
        return None
    if not host:
        return 'an address with no host'
    own = bool(policy.get('loopbackIsOwn'))
    if host_allowed(host, policy.get('network'), own):
        return None
    if is_loopback_host(host) and not own:
        return 'loopback here is the host machine'
    if is_internal_host(host):
        return 'an internal address'
    return 'not allowed by the policy'


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
    """
    The session for a tab: the one auto-attach gave it, or one attached now and
    guarded the same way. A one-shot connection attaches anew; a served one, once.
    """
    session_id = conn.sessions.get(target_id)
    if not session_id:
        try:
            session_id = attach(conn, target_id, deadline)
        except DriverError as exc:
            # A new connection to Lightpanda is a new, empty browser: the page is
            # gone, so the host starts the browser again rather than retry forever.
            if exc.kind == BAD_TARGET and conn.engine == 'lightpanda':
                raise DriverError(BROWSER_GONE, "Lightpanda's page ended with its connection", {'cause': exc.message})
            raise
        conn.sessions[target_id] = session_id
        conn.guard(session_id, 'page', False)
    auto_attach(conn, session_id, deadline)
    if conn.engine == 'lightpanda' and conn.downloads_dir and not conn.downloads_armed:
        # Lightpanda takes a download folder only once its page exists.
        conn.downloads_armed = True
        try:
            conn.call('Browser.setDownloadBehavior', {'behavior': 'allow', 'downloadPath': conn.downloads_dir, 'eventsEnabled': True}, None, deadline)
        except DriverError as exc:
            if exc.kind != PROTOCOL:
                raise
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

# Called on the field itself, never on `document.activeElement`: inside a frame, the
# active element of the page is the frame. Selecting first means `fill` replaces
# rather than appends; insertText fires `input`, and frameworks listening for
# `change` need the nudge.
SELECT_NODE = "function () { if (typeof this.select === 'function') this.select(); }"
CHANGE_NODE = "function () { this.dispatchEvent(new Event('change', { bubbles: true })); }"
# An option of a native <select>, by its value or its text, with the events a framework listens for.
CHOOSE_OPTION = r'''function (want) {
  if (this.tagName !== 'SELECT') throw new Error('that ref is not a <select>');
  const match = [...this.options].find((o) => o.value === want) || [...this.options].find((o) => o.text.trim() === want.trim());
  if (!match) throw new Error('no option matching ' + JSON.stringify(want) + '; options are ' + JSON.stringify([...this.options].map((o) => o.text.trim())));
  this.value = match.value;
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return match.text.trim();
}'''
STALE = '%s is from an earlier page: this one has loaded since the snapshot that showed it; take a fresh snapshot and use its refs'

# What an honest click asks of its element before it presses. A disabled form
# control (one in a disabled fieldset too) or aria-disabled means a click would
# do nothing; hidden, or no box at all, means there is nothing there to click.
CLICK_STATE = r'''function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!this.isConnected || !el) return { gone: true };
  const style = getComputedStyle(el);
  const box = el.getBoundingClientRect();
  return {
    disabled: el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true',
    hidden: style.visibility === 'hidden' || style.display === 'none' || box.width === 0 || box.height === 0,
  };
}'''
# Whether the node a click would land on is the element or inside it, through shadow roots.
WITHIN = r'''function (hit) {
  for (let n = hit; n; n = n.parentNode || (n instanceof ShadowRoot ? n.host : null)) if (n === this) return true;
  return false;
}'''
# What covers an element, in a few words, for the refusal.
DESCRIBE = r'''function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el) return 'something else';
  const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((c) => '.' + c).join('') : '';
  const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  return '<' + el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls + '>' + (text ? ' "' + text + '"' : '');
}'''
GONE = '%s is no longer on the page; take a snapshot and use the new ref'
# The address a link opens in a tab of its own, or null.
NEW_TAB = r'''function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  const a = el && el.closest('a[href], area[href]');
  const t = a ? (a.getAttribute('target') || '').toLowerCase() : '';
  return a && t && !['_self', '_top', '_parent'].includes(t) ? a.href : null;
}'''


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


def resolve(conn, session_id, step, deadline, unique=False):
    """
    The DOM node a role and an accessible name mean, in the page's own frame.
    With `unique`, a role and name that match more than one element is refused
    rather than quietly taking the first.
    """
    role, name = step.get('role'), step.get('name')
    if not role and not name:
        raise DriverError(ACTION, 'say which element: a ref, or a role and a name')
    wanted = ' and '.join(x for x in ('role %r' % (role,) if role else '', 'name %r' % (name,) if name else '') if x)
    root = conn.call('DOM.getDocument', {'depth': 0}, session_id, deadline).get('root') or {}
    query = {'nodeId': root.get('nodeId')}
    if role:
        query['role'] = role
    if name:
        query['accessibleName'] = name
    found = conn.call('Accessibility.queryAXTree', query, session_id, deadline).get('nodes') or []
    nodes = [n for n in found if not n.get('ignored') and n.get('backendDOMNodeId')]
    # A name alone also finds the text inside an element, which is that element, not another one.
    elements = [n for n in nodes if (n.get('role') or {}).get('value') not in ('StaticText', 'InlineTextBox')] or nodes
    if not elements:
        raise DriverError(ACTION, 'nothing on the page has %s; take a snapshot' % wanted)
    if unique and len(elements) > 1:
        raise DriverError(
            ACTION,
            '%d elements have %s; take a snapshot and use the ref of the one you mean, or pass force to click the first'
            % (len(elements), wanted),
        )
    return elements[0]['backendDOMNodeId']


def prepare(conn, deadline, downloads, policy=None, engine=None):
    """
    Once per connection: hear about the tabs pages open; attach to every tab,
    a new one held until it is guarded, so its first load goes by the network
    policy and a dialog it opens at once is answered; and, when the host names a
    folder for downloads (in a computer, /work/downloads), keep them there and
    follow their progress. The host names it because only the host knows where
    the computer keeps things: the driver itself runs from a tmpfs.
    """
    if policy is not None:
        conn.policy = policy
    if engine:
        conn.engine = engine
    if downloads:
        conn.downloads_dir = downloads
    if conn.prepared:
        return
    conn.prepared = True
    try:
        conn.call('Target.setDiscoverTargets', {'discover': True}, None, deadline)
        conn.discovering = True
        conn.call('Target.setAutoAttach', {'autoAttach': True, 'waitForDebuggerOnStart': True, 'flatten': True, 'filter': [{'type': 'page'}]}, None, deadline)
        if downloads:
            if not os.path.isdir(downloads):
                os.makedirs(downloads)
            conn.call('Browser.setDownloadBehavior', {'behavior': 'allow', 'downloadPath': downloads, 'eventsEnabled': True}, None, deadline)
    except (DriverError, OSError) as exc:
        if isinstance(exc, DriverError) and exc.kind != PROTOCOL:
            raise


def listen_for(conn, session_id, events, seconds, deadline, on=None):
    """The first of `events` to arrive within `seconds`, on `on`'s session if given, or None; every event on the way is noted."""
    end = min(deadline, _now() + seconds)
    on = on or session_id
    while True:
        for i, buffered in enumerate(conn.events):
            if buffered.get('method') in events and buffered.get('sessionId') in (None, on):
                del conn.events[i]
                return buffered.get('method')
        try:
            msg = conn._pump(end)
        except DriverError as exc:
            if exc.kind == TIMEOUT and exc.details.get('boundary', True):
                return None
            raise
        if 'method' in msg:
            conn._note(msg, session_id)


def finish_downloads(conn, session_id, started, deadline, seconds=30.0):
    """A download an action started, followed to its end (at most 30 s), so its file is there to use."""
    end = min(deadline, _now() + seconds)
    while _now() < end and any(d['state'] == 'inProgress' for g, d in conn.downloads.items() if g not in started):
        listen_for(conn, session_id, ('Browser.downloadProgress',), min(1.0, end - _now()), deadline)


def settle_popups(conn, session_id, popped, deadline, seconds=2.0):
    """A tab an action opened starts out blank and gets its address once its page commits: wait for that, at most 2 s."""
    end = min(deadline, _now() + seconds)
    while _now() < end and any(p['url'] in ('', 'about:blank') for p in conn.popups[popped:]):
        listen_for(conn, session_id, ('Target.targetInfoChanged',), end - _now(), deadline)


def happened(conn, started, popped):
    """
    What a page did during an action besides its own result: dialogs it showed,
    files it downloaded, tabs it opened, and loads the network policy stopped.
    """
    out = {}
    if conn.blocked:
        out['blocked'] = list(conn.blocked)
    if conn.dialogs:
        out['dialogs'] = list(conn.dialogs)
    new = [d for g, d in conn.downloads.items() if g not in started]
    if new:
        out['downloads'] = [dict(d) for d in new]
    if len(conn.popups) > popped:
        out['popups'] = conn.popups[popped:]
    return out


def current_document(conn, session_id, deadline):
    """The page's document now: its main frame's loader id, new with every page it loads."""
    try:
        tree = conn.call('Page.getFrameTree', {}, session_id, deadline).get('frameTree') or {}
    except DriverError as exc:
        if exc.kind != PROTOCOL:
            raise
        return None
    return (tree.get('frame') or {}).get('loaderId')


def ref_documents(conn, session_id):
    """Which frame and document each ref handed out on this connection came from: ref -> (frame id or None, loader id)."""
    known = conn.__dict__.setdefault('ref_documents', {}).setdefault(session_id, {})
    # ponytail: forgotten wholesale past a bound, so a long session's map stays small; a
    # forgotten ref is checked against the host's own record, or refused for a fresh snapshot.
    if len(known) > 200000:
        known.clear()
    return known


# A ref: e<n> in the page's own frame, f<k>e<n> in frame k. A frame in another
# process numbers its nodes afresh, so its refs have to say which frame.
REF = re.compile(r'^(?:f(\d+))?e(\d+)$')


def frame_keys(conn, session_id, seen=None):
    """
    Each frame's number on this page, by frame id. A frame keeps its number for
    as long as the page is open, so f2e7 never comes to mean another frame's
    node. `seen` is the host's record, for a driver that keeps nothing between
    requests; a number this connection already gave a frame stays that frame's.
    """
    keys = conn.__dict__.setdefault('frame_keys', {}).setdefault(session_id, {})
    # ponytail: forgotten wholesale past a bound; frames are numbered afresh from then on.
    if len(keys) > 10000:
        keys.clear()
    for frame_id, k in (seen or {}).items():
        if isinstance(k, int) and frame_id not in keys and k not in keys.values():
            keys[frame_id] = k
    return keys


def frame_tree(conn, session_id, deadline):
    try:
        return conn.call('Page.getFrameTree', {}, session_id, deadline).get('frameTree') or {}
    except DriverError as exc:
        if exc.kind != PROTOCOL:
            raise
        return {}


def frames_of(tree):
    """Every frame in a frame tree, parents first, in document order."""
    out, todo = [], [tree]
    while todo:
        t = todo.pop(0)
        if t.get('frame'):
            out.append(t['frame'])
        todo[0:0] = t.get('childFrames') or []
    return out


def auto_attach(conn, session_id, deadline):
    """
    Once per tab's session: attach to its cross-site frames, each held until it
    is guarded (see Conn.guard, which does the same for a frame's own frames).
    Chromium reports the frames already there before it answers, so every one is
    known when this returns.
    """
    if session_id in conn.auto_attached:
        return
    conn.call('Target.setAutoAttach', FRAMES, session_id, deadline)
    conn.auto_attached.add(session_id)


def sessions_under(conn, session_id):
    """The page's session, then the session of every cross-site frame under it, parents first."""
    out = [session_id]
    for s in out:  # grows as it goes: each session's frames join the end
        out.extend(c for c, info in list(conn.frame_sessions.items()) if info['parent'] == s and c not in out)
    return out


def owner_of(conn, session_id, frame_id, deadline):
    """The backend id of a frame's <iframe>, in the session of the frame's parent; None once it is gone."""
    try:
        return conn.call('DOM.getFrameOwner', {'frameId': frame_id}, session_id, deadline).get('backendNodeId')
    except DriverError as exc:
        if exc.kind != PROTOCOL:
            raise
        return None


def parent_session(conn, page, session_id, frame_id):
    """The session that has a frame's <iframe>: the parent's, for the frame a session was attached to."""
    info = conn.frame_sessions.get(session_id)
    return info['parent'] if session_id != page and info and info['frame'] == frame_id else session_id


def outer_levels(conn, page, session_id, deadline):
    """The <iframe>s a click passes through, from the page down to this session's frame: (session, backend id) each."""
    levels = []
    while session_id != page:
        info = conn.frame_sessions.get(session_id)
        owner = owner_of(conn, info['parent'], info['frame'], deadline) if info else None
        if owner is None:
            return None
        levels.insert(0, (info['parent'], owner))
        session_id = info['parent']
    return levels


def find_frame(conn, page, frame_id, deadline):
    """Where a frame is now: the session that reaches it, the frame (its loaderId names its document), and the <iframe>s on the way down. None once it is gone."""
    for s in sessions_under(conn, page):
        frame = next((f for f in frames_of(frame_tree(conn, s, deadline)) if f.get('id') == frame_id), None)
        if frame:
            outer = outer_levels(conn, page, s, deadline)
            return (s, frame, outer) if outer is not None else None
    return None


def locate(conn, session_id, step, deadline, unique=False):
    """
    The element an action means and where it is: `sid`, the session that
    reaches it (the page's, or a cross-site frame's own), and `outer`, the
    <iframe>s on the way down to it. A ref acts only on the document whose
    snapshot showed it, the page's or its frame's: once that has loaded
    another, the same id can name a different element, so an earlier
    document's ref is refused rather than resolved to whatever has its id now.
    Checked against this connection's own snapshots first, then the host's.
    """
    ref = step.get('ref')
    if not ref:
        backend = resolve(conn, session_id, step, deadline, unique=unique)
        return {'ref': 'e%d' % backend, 'sid': session_id, 'backend': backend, 'frame': None, 'outer': []}
    m = REF.match(ref) if isinstance(ref, str) else None
    if not m:
        raise DriverError(ACTION, '%r is not an element ref; refs look like e42, or f1e42 inside a frame' % (ref,))
    backend = int(m.group(2))
    known = ref_documents(conn, session_id).get(ref) or (None, None)
    expected = known[1] or step.get('document')
    # Where the page's document can be read, a snapshot of it recorded its refs,
    # here or on the host. One nobody recorded is from before a restart, or made
    # up: refused, never resolved blind to whatever has that id now.
    if not expected and current_document(conn, session_id, deadline):
        raise DriverError(ACTION, '%s is from a snapshot this browser has no record of; take a fresh snapshot and use its refs' % ref)
    if not m.group(1):
        if expected:
            now = current_document(conn, session_id, deadline)
            if now and now != expected:
                raise DriverError(ACTION, STALE % ref)
        return {'ref': ref, 'sid': session_id, 'backend': backend, 'frame': None, 'outer': []}
    k = int(m.group(1))
    frame_id = known[0] or step.get('frame') or next((f for f, n in frame_keys(conn, session_id).items() if n == k), None)
    found = find_frame(conn, session_id, frame_id, deadline) if frame_id else None
    if not found:
        raise DriverError(ACTION, '%s is in a frame that is no longer on the page; take a fresh snapshot and use its refs' % ref)
    host, frame, outer = found
    if expected and frame.get('loaderId') and frame['loaderId'] != expected:
        raise DriverError(ACTION, STALE % ref)
    return {'ref': ref, 'sid': host, 'backend': backend, 'frame': frame_id, 'outer': outer}


def scroll_into_view(conn, session_id, backend, deadline):
    try:
        conn.call('DOM.scrollIntoViewIfNeeded', {'backendNodeId': backend}, session_id, deadline)
    except DriverError as exc:
        if exc.kind != PROTOCOL:
            raise


def content_quad(conn, session_id, backend, deadline):
    try:
        quad = conn.call('DOM.getBoxModel', {'backendNodeId': backend}, session_id, deadline)['model']['content']
    except (DriverError, KeyError, TypeError) as exc:
        if isinstance(exc, DriverError) and exc.kind != PROTOCOL:
            raise
        return None
    return quad if quad and len(quad) >= 8 else None


def box_centre(conn, el, deadline):
    """The centre of the element's box where the page sees it now, or None when it has none."""
    quad = content_quad(conn, el['sid'], el['backend'], deadline)
    if quad is None:
        return None
    dx, dy = el.get('offset') or (0.0, 0.0)
    xs, ys = quad[0::2], quad[1::2]
    return (min(xs) + max(xs)) / 2.0 + dx, (min(ys) + max(ys)) / 2.0 + dy


def centre(conn, el, deadline):
    """
    The element's centre where the page sees it, once in view: each <iframe> on
    the way down scrolled into view in its parent, then the element in its frame.
    A cross-site frame's boxes are in its own viewport, so the place of each
    <iframe> on the way down is added on.
    """
    for sid, owner in el['outer']:
        scroll_into_view(conn, sid, owner, deadline)
    scroll_into_view(conn, el['sid'], el['backend'], deadline)
    # ponytail: an <iframe> that is scaled or rotated is taken as plain, by its box's top-left.
    origins = [(0.0, 0.0)]
    for sid, owner in el['outer']:
        quad = content_quad(conn, sid, owner, deadline)
        if quad is None:
            raise DriverError(ACTION, GONE % el['ref'])
        x, y = origins[-1]
        origins.append((x + min(quad[0::2]), y + min(quad[1::2])))
    el['origins'] = origins
    el['offset'] = origins[-1]
    point = box_centre(conn, el, deadline)
    if point is None:
        raise DriverError(ACTION, GONE % el['ref'])
    return point


def steady_centre(conn, el, deadline):
    """
    The element's centre once it has stopped moving: a click aimed at a box
    still sliding into place lands beside it. Two readings 50 ms apart must
    agree to the pixel; a box still moving after half a second is refused.
    """
    x, y = centre(conn, el, deadline)
    for _ in range(10):
        time.sleep(0.05)
        point = box_centre(conn, el, deadline)
        if point is None:
            raise DriverError(ACTION, GONE % el['ref'])
        if abs(point[0] - x) < 1 and abs(point[1] - y) < 1:
            return point
        x, y = point
    raise DriverError(
        ACTION, '%s is still moving, so a click could land beside it; try again once the page settles, or pass force to click anyway' % el['ref']
    )


def page_object(conn, session_id, backend, deadline):
    """The node as a page object, or None once the page no longer has it."""
    try:
        return (conn.call('DOM.resolveNode', {'backendNodeId': backend}, session_id, deadline).get('object') or {}).get('objectId')
    except DriverError as exc:
        if exc.kind != PROTOCOL:
            raise
        return None


def point_object(conn, session_id, x, y, deadline):
    """What the page's own hit test finds at (x, y), as a page object, or None."""
    res = conn.call('Runtime.evaluate', {'expression': 'document.elementFromPoint(%f, %f)' % (x, y)}, session_id, deadline)
    return (res.get('result') or {}).get('objectId')


def call_on(conn, session_id, object_id, fn, deadline, args=None):
    """`fn` run on a page object, and its value. A page that throws is an ACTION error."""
    res = conn.call(
        'Runtime.callFunctionOn',
        {'objectId': object_id, 'functionDeclaration': fn, 'arguments': args or [], 'returnByValue': True},
        session_id,
        deadline,
    )
    exc = res.get('exceptionDetails')
    if exc:
        described = (exc.get('exception') or {}).get('description') or exc.get('text') or 'unknown error'
        raise DriverError(ACTION, 'the page threw: %s' % (described,))
    return (res.get('result') or {}).get('value')


def covering(conn, el, target, x, y, deadline):
    """
    What a click at (x, y) on the page would land on instead of the element, in
    a few words; None when it reaches it, or Chromium cannot say. On the way
    down, each frame's <iframe> must be what the click meets in its parent's
    process, and in the element's own frame, the element or something in it.
    """
    levels = list(el['outer']) + [(el['sid'], el['backend'])]
    if conn.engine == 'lightpanda':
        # No getNodeForLocation there. In the top document the page's own hit
        # test stands in, the one Lightpanda's click uses; in a frame, no check.
        if len(levels) > 1:
            return None
        hit_object = point_object(conn, el['sid'], x, y, deadline)
        if not hit_object or call_on(conn, el['sid'], target, WITHIN, deadline, [{'objectId': hit_object}]) is True:
            return None
        return call_on(conn, el['sid'], hit_object, DESCRIBE, deadline) or 'something else'
    for i, ((sid, want), (ox, oy)) in enumerate(zip(levels, el.get('origins') or [(0.0, 0.0)])):
        try:
            hit = conn.call(
                'DOM.getNodeForLocation', {'x': int(round(x - ox)), 'y': int(round(y - oy)), 'includeUserAgentShadowDOM': True}, sid, deadline
            )
        except DriverError as exc:
            if exc.kind != PROTOCOL:
                raise
            return None
        other = hit.get('backendNodeId')
        if not other or other == want:
            continue
        hit_object = page_object(conn, sid, other, deadline)
        if not hit_object:
            return None
        if i == len(levels) - 1:
            try:
                if call_on(conn, sid, target, WITHIN, deadline, [{'objectId': hit_object}]) is True:
                    continue
            except DriverError as exc:
                # A node in another frame of this process cannot be handed to the
                # element's frame: it is not in the element, so it covers it.
                if exc.kind != PROTOCOL:
                    raise
        return call_on(conn, sid, hit_object, DESCRIBE, deadline) or 'something else'
    return None


def act_goto(conn, sid, step, deadline):
    url = step.get('url')
    started = set(conn.downloads)
    nav = conn.call('Page.navigate', {'url': url}, sid, deadline)
    if nav.get('errorText') and conn.blocked:
        # The host checked this URL; a redirect from it went somewhere the policy refuses.
        b = conn.blocked[-1]
        led = '' if b['url'] == url else ', where %s led' % url
        raise DriverError(ACTION, 'the network policy refused %s (%s)%s' % (b['url'], b['reason'], led))
    if nav.get('errorText'):
        # A URL that is a file to download aborts the navigation and starts the
        # download: that is the goto doing what it was asked, not failing.
        listen_for(conn, sid, ('Browser.downloadWillBegin',), 1.0, deadline)
        if not any(g not in started for g in conn.downloads):
            raise DriverError(ACTION, 'could not load %s: %s' % (url, nav['errorText']))
        finish_downloads(conn, sid, started, deadline)
        return {'url': evaluate(conn, sid, 'location.href', deadline), 'loaded': False}
    fired = listen_for(conn, sid, ('Page.loadEventFired', 'Browser.downloadWillBegin'), float(step.get('loadTimeoutMs', 30000)) / 1000.0, deadline)
    finish_downloads(conn, sid, started, deadline)
    return {'url': evaluate(conn, sid, 'location.href', deadline), 'loaded': fired == 'Page.loadEventFired'}


def act_click(conn, sid, step, deadline):
    """
    An honest click. Refused, saying why, when the element is gone, disabled,
    hidden, still moving, or covered by something the click would land on
    instead, and when a role and name match more than one element. `force`
    skips every check and presses at the element's centre, as clicks always did.
    """
    force = bool(step.get('force'))
    # Even forced, a ref from an earlier page is refused: force is about the element's state, not which element.
    el = locate(conn, sid, step, deadline, unique=not force)
    if force:
        x, y = centre(conn, el, deadline)
    else:
        target = page_object(conn, el['sid'], el['backend'], deadline)
        state = call_on(conn, el['sid'], target, CLICK_STATE, deadline) if target else None
        if not isinstance(state, dict) or state.get('gone'):
            raise DriverError(ACTION, GONE % el['ref'])
        if state.get('disabled'):
            raise DriverError(ACTION, '%s is disabled, so a click would do nothing; wait until it is enabled, or pass force to click anyway' % el['ref'])
        if state.get('hidden'):
            raise DriverError(ACTION, '%s is not visible (hidden, or of no size); open or scroll to what shows it, or pass force to click anyway' % el['ref'])
        x, y = steady_centre(conn, el, deadline)
        over = covering(conn, el, target, x, y, deadline)
        if over:
            raise DriverError(ACTION, '%s is covered: a click on it would land on %s instead; close or move that first, or pass force to click anyway' % (el['ref'], over))
        # Lightpanda opens no second tab, so a link meant for one would seem to do nothing.
        away = call_on(conn, el['sid'], target, NEW_TAB, deadline) if conn.engine == 'lightpanda' else None
        if away:
            raise DriverError(ACTION, '%s opens %s in a new tab, which Lightpanda cannot show: browser_goto it to open it here, or browser_tabs open it, which moves this computer to Chrome' % (el['ref'], away))
    started = set(conn.downloads)
    # The page's session takes the click wherever it lands, a cross-site frame included.
    to_front(conn, sid, deadline)
    arm(conn, sid, step, deadline)
    base = {'x': x, 'y': y, 'button': 'left', 'clickCount': 1, 'buttons': 1}
    conn.call('Input.dispatchMouseEvent', dict(base, type='mousePressed'), sid, deadline)
    conn.call('Input.dispatchMouseEvent', dict(base, type='mouseReleased', buttons=0), sid, deadline)
    navigated = loads(conn, sid, el, float(step.get('loadTimeoutMs', 5000)) / 1000.0, deadline)
    finish_downloads(conn, sid, started, deadline)
    return with_wait(conn, sid, step, deadline, {'ref': el['ref'], 'navigated': navigated, 'checked': not force})


def arm(conn, sid, step, deadline):
    """
    The wait an action asked for, watching from just before it acts (the host's
    armExpression), so a change that comes and goes before anyone looks is seen.
    """
    if not step.get('arm'):
        return
    try:
        evaluate(conn, sid, step['arm'], deadline)
    except DriverError as exc:
        if exc.kind not in (PROTOCOL, ACTION):
            raise


def with_wait(conn, sid, step, deadline, result):
    """The action's result, and what its wait found. Not finding it is an answer, not a failure: the action happened."""
    wait = step.get('wait')
    if not wait:
        return result
    started = _now()
    try:
        found = evaluate(conn, sid, wait['expression'], deadline) is True
    except DriverError as exc:
        if exc.kind not in (PROTOCOL, ACTION):
            raise
        found = False
    result['waited'] = {'what': wait.get('what') or 'it', 'found': found, 'waitedMs': int((_now() - started) * 1000)}
    if wait.get('gone'):
        result['waited']['gone'] = True
    return result


def to_front(conn, sid, deadline):
    """
    The tab to the front before the pointer moves in it. A pop-up the page opens
    takes the front, and a tab behind it does not pass the pointer on to a frame
    in another process: the click is sent, and nothing in the frame hears it.
    """
    try:
        conn.call('Page.bringToFront', {}, sid, deadline)
    except DriverError as exc:
        if exc.kind != PROTOCOL:
            raise


def loads(conn, sid, el, seconds, deadline):
    """
    Whether an action started a load, waiting for it to finish if so. Most
    actions load nothing, so the wait starts only once a load has; a download
    starts as a navigation and never loads, so it ends the wait too. For an
    element in a frame, it is the frame's load.
    """
    if el['frame'] is None:
        navigated = maybe_event(conn, 'Page.frameStartedLoading', sid, 0.25, deadline)
        if navigated:
            listen_for(conn, sid, ('Page.loadEventFired', 'Browser.downloadWillBegin'), seconds, deadline)
        return navigated
    started = listen_for(conn, sid, ('Page.frameStartedLoading',), 0.25, deadline, on=el['sid'])
    if started:
        listen_for(conn, sid, ('Page.frameStoppedLoading', 'Browser.downloadWillBegin'), seconds, deadline, on=el['sid'])
    return started is not None


def act_fill(conn, sid, step, deadline):
    el = locate(conn, sid, step, deadline)
    field = page_object(conn, el['sid'], el['backend'], deadline)
    if not field:
        raise DriverError(ACTION, GONE % el['ref'])
    conn.call('DOM.focus', {'backendNodeId': el['backend']}, el['sid'], deadline)
    if step.get('clear', True):
        call_on(conn, el['sid'], field, SELECT_NODE, deadline)
    arm(conn, sid, step, deadline)
    # The element's own session: a cross-site frame's text and keys go to its own process.
    conn.call('Input.insertText', {'text': str(step.get('text', ''))}, el['sid'], deadline)
    call_on(conn, el['sid'], field, CHANGE_NODE, deadline)
    if step.get('submit'):
        enter = {'key': 'Enter', 'code': 'Enter', 'windowsVirtualKeyCode': 13, 'nativeVirtualKeyCode': 13}
        conn.call('Input.dispatchKeyEvent', dict(enter, type='keyDown', text='\r'), el['sid'], deadline)
        conn.call('Input.dispatchKeyEvent', dict(enter, type='keyUp'), el['sid'], deadline)
        if el['frame'] is None:
            maybe_event(conn, 'Page.loadEventFired', sid, 10.0, deadline)
        else:
            loads(conn, sid, el, 10.0, deadline)
    return with_wait(conn, sid, step, deadline, {'ref': el['ref']})


def act_select(conn, sid, step, deadline):
    el = locate(conn, sid, step, deadline)
    field = page_object(conn, el['sid'], el['backend'], deadline)
    if not field:
        raise DriverError(ACTION, GONE % el['ref'])
    conn.call('DOM.focus', {'backendNodeId': el['backend']}, el['sid'], deadline)
    chosen = call_on(conn, el['sid'], field, CHOOSE_OPTION, deadline, [{'value': str(step.get('value', ''))}])
    return {'ref': el['ref'], 'selected': chosen if isinstance(chosen, str) else ''}


def act_hover(conn, sid, step, deadline):
    """The pointer over the element, for the menus that only exist under it."""
    el = locate(conn, sid, step, deadline)
    x, y = centre(conn, el, deadline)
    to_front(conn, sid, deadline)
    conn.call('Input.dispatchMouseEvent', {'type': 'mouseMoved', 'x': x, 'y': y, 'button': 'none', 'buttons': 0}, sid, deadline)
    return {'ref': el['ref']}


def act_scroll(conn, sid, step, deadline):
    """The element scrolled into view, its frames' <iframe>s first."""
    el = locate(conn, sid, step, deadline)
    centre(conn, el, deadline)
    return {'ref': el['ref']}


def act_upload(conn, sid, step, deadline):
    """Files from the computer on a file input."""
    el = locate(conn, sid, step, deadline)
    conn.call('DOM.setFileInputFiles', {'backendNodeId': el['backend'], 'files': [str(f) for f in step.get('files') or []]}, el['sid'], deadline)
    return {'ref': el['ref']}


def act_wait(conn, sid, step, deadline):
    started = _now()
    if evaluate(conn, sid, step['expression'], deadline) is not True:
        waited = int((_now() - started) * 1000)
        raise DriverError(ACTION, '%s did not %s within %d ms' % (step.get('what', 'it'), 'go away' if step.get('gone') else 'appear', waited))
    return {'found': True, 'waitedMs': int((_now() - started) * 1000)}


def act_snapshot(conn, sid, step, deadline):
    conn.call('Accessibility.enable', {}, sid, deadline)
    nodes = conn.call('Accessibility.getFullAXTree', {}, sid, deadline).get('nodes') or []
    # Every ref this snapshot hands out belongs to its document, and only to it.
    document = current_document(conn, sid, deadline)
    known = ref_documents(conn, sid)
    if document:
        for node in nodes:
            if node.get('backendDOMNodeId'):
                known['e%d' % node['backendDOMNodeId']] = (None, document)
    frames, unreachable = splice_frames(conn, sid, nodes, step.get('frames') or {}, deadline)
    return {
        'nodes': nodes,
        'frames': frames,
        'unreachable': unreachable,
        'url': evaluate(conn, sid, 'location.href', deadline),
        'document': document,
    }


def splice_frames(conn, sid, nodes, seen, deadline):
    """
    Each frame's tree, added to `nodes` under its <iframe>: a same-site frame's
    from the page's session, a cross-site one's from its own, since Chromium
    runs it in another process that the page's session cannot see into. Its
    nodes carry their frame's number, so their refs are f<k>e<n>. Returns
    {f<k>: {id, document}} for the frames read, and the address of each frame
    that could not be read.
    """
    keys = frame_keys(conn, sid, seen)
    known = ref_documents(conn, sid)
    # Each frame's own nodes, to find its child frames' <iframe>s in: the page's before any frame's are added.
    by_frame = {}
    frames, unreachable = {}, []
    for host in sessions_under(conn, sid):
        for frame in frames_of(frame_tree(conn, host, deadline)):
            fid = frame.get('id')
            if host == sid and not frame.get('parentId'):
                by_frame[fid] = list(nodes)
                continue
            parent_nodes = by_frame.get(frame.get('parentId'))
            owner = owner_of(conn, parent_session(conn, sid, host, fid), fid, deadline)
            iframe = next((n for n in parent_nodes or [] if owner and n.get('backendDOMNodeId') == owner), None)
            if iframe is None:
                continue  # its <iframe> is hidden, or in a frame that is: nothing there to read or click
            try:
                tree = conn.call('Accessibility.getFullAXTree', {'frameId': fid}, host, deadline).get('nodes') or []
            except DriverError as exc:
                if exc.kind != PROTOCOL:
                    raise
                unreachable.append(frame.get('url') or '(no address)')
                continue
            if fid not in keys:
                keys[fid] = max(list(keys.values()) or [0]) + 1
            tag = 'f%d' % keys[fid]
            for n in tree:
                n['nodeId'] = '%s:%s' % (tag, n.get('nodeId'))
                if n.get('parentId'):
                    n['parentId'] = '%s:%s' % (tag, n['parentId'])
                n['childIds'] = ['%s:%s' % (tag, c) for c in n.get('childIds') or []]
                n['frame'] = tag
                if n.get('backendDOMNodeId') and frame.get('loaderId'):
                    known['%se%d' % (tag, n['backendDOMNodeId'])] = (fid, frame['loaderId'])
            root = next((n for n in tree if not n.get('parentId')), None)
            if root is not None:
                root['parentId'] = iframe.get('nodeId')
                iframe['childIds'] = [root['nodeId']]
            by_frame[fid] = tree
            nodes.extend(tree)
            frames[tag] = {'id': fid, 'document': frame.get('loaderId')}
    return frames, unreachable


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
# checked by the host's network policy first, and every document a click, a
# submit, a redirect or a page script loads is paused and checked here, on the
# connection that holds the page's interception. But the script, like `shell`,
# can open 127.0.0.1's CDP port itself and go round this. The computer is the
# boundary. Names follow the Playwright-style page API credited in
# THIRD_PARTY_NOTICES.md, where they fit.

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

    def click(self, ref=None, role=None, name=None, force=False, dialog=None):
        return _call("click", ref=ref, role=role, name=name, force=force or None, dialog=dialog)

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
    # Nor is a dialog answer: `dialog: "accept"` belongs to the click that
    # passed it, and a confirm that a later call meets is dismissed.
    conn.dialog_answer = args.get('dialog') if op == 'click' else None
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
            el = locate(conn, sid, args, deadline)
            obj = conn.call('DOM.resolveNode', {'backendNodeId': el['backend']}, el['sid'], deadline).get('object') or {}
            res = conn.call(
                'Runtime.callFunctionOn',
                {'objectId': obj.get('objectId'), 'functionDeclaration': 'function () { return this.innerText ?? this.textContent ?? ""; }', 'returnByValue': True},
                el['sid'],
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
    tag = '%s-%s' % (SERVE_PORT, base64.b16encode(os.urandom(8)).decode('ascii'))
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
    'select': act_select,
    'hover': act_hover,
    'scroll': act_scroll,
    'upload': act_upload,
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
            conn.dialogs = []
            conn.blocked = []
            conn.dialog_answer = step.get('dialog')
            started = set(conn.downloads)
            popped = len(conn.popups)
            # Lightpanda answers a dialog the moment it opens, so the answer is given first.
            armed = conn.engine == 'lightpanda' and conn.dialog_answer == 'accept'
            try:
                if armed:
                    conn.call('LP.handleJavaScriptDialog', {'accept': True}, session_id, step_deadline)
                result = fn(conn, session_id, step, step_deadline)
                settle_popups(conn, session_id, popped, step_deadline)
                result.update(happened(conn, started, popped))
                results.append(result)
            except DriverError as exc:
                # The page said no, or the element is not there: the run stops
                # here and says so. A dead browser still fails the whole request.
                if exc.kind not in (PROTOCOL, ACTION):
                    raise
                failed = {'error': exc.message}
                failed.update(happened(conn, started, popped))
                results.append(failed)
                halted = True
            finally:
                conn.dialog_answer = None
                if armed and not conn.dialogs:
                    # Unused, the answer would wait for a later action's dialog: take it back.
                    try:
                        conn.call('LP.handleJavaScriptDialog', {'accept': False}, session_id, step_deadline)
                    except DriverError:
                        pass
        else:
            raise DriverError(INTERNAL, 'unknown step op %r' % (op,))
    return results


def run(req):
    """One request, one connection: the fallback for providers that cannot keep stdin open."""
    deadline = _now() + float(req.get('timeoutMs', 60000)) / 1000.0
    conn, ws_url, browser = connect(req.get('port'), req.get('ws'), deadline)
    try:
        prepare(conn, deadline, req.get('downloads'), req.get('policy'), req.get('engine'))
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
# Set by `serve`: the browser's port, which starts every tag this driver gives
# its scripts, so stopping a wedged driver from outside (cdp.ts, REAP_SOURCE)
# stops only its own scripts, never another computer's on the same host.
SERVE_PORT = None


def serve(port):
    """Answer requests on stdin until it closes, holding one connection to Chromium throughout."""
    global BRIDGE, SERVE_PORT
    SERVE_PORT = port

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
        prepare(conn, deadline, req.get('downloads'), req.get('policy'), req.get('engine'))
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
