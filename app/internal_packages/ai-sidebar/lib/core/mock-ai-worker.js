'use strict';
/**
 * Deterministic mock AI subprocess. No network, no providers, no shell.
 * Host spawns process.execPath with this file only; query/mail travel on UTF-8 stdin.
 */
process.stdin.setEncoding('utf8');

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) {
      handleLine(line);
    }
  }
});

function write(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`, 'utf8');
}

function handleLine(line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch (e) {
    write({ id: null, error: 'invalid-json' });
    return;
  }
  const id = req && req.id;
  const op = req && req.op;
  const generation = req && req.generation;
  const delayMs = Math.max(0, Number(req && req.delayMs) || 0);

  const send = (payload, extra) => {
    write(Object.assign({ id, generation, payload }, extra || {}));
  };

  const afterDelay = (fn) => {
    if (op === 'hang') {
      return;
    }
    if (delayMs > 0) {
      setTimeout(fn, delayMs);
    } else {
      fn();
    }
  };

  afterDelay(() => {
    if (op === 'invalid-schema') {
      send({ citations: 'nope' });
      return;
    }
    if (op === 'not-mock') {
      send({
        isMock: false,
        response: 'live-looking text',
        citations: [],
        tokensUsed: 1,
      });
      return;
    }
    if (op === 'unknown-citation') {
      send({
        isMock: true,
        mockLabel: 'Mock AI (No External Connection)',
        response: '🔧 MOCK — citation not in host scope',
        citations: [
          {
            messageId: req.unknownId || 'production-msg-1',
            threadId: 't',
            subject: 'injected',
            from: 'x@y.z',
            date: new Date().toISOString(),
            snippet: 'not in scope',
          },
        ],
        tokensUsed: 1,
      });
      return;
    }
    if (op === 'bidi-citation') {
      send({
        isMock: true,
        mockLabel: 'Mock AI (No External Connection)',
        response: '🔧 MOCK — bidi spoof citation',
        citations: [
          {
            messageId: '\u202edemo-msg-1',
            threadId: 't',
            subject: 'spoof',
            from: 'x@y.z',
            date: new Date().toISOString(),
            snippet: 'RLO prefix',
          },
        ],
        tokensUsed: 1,
      });
      return;
    }

    const allowed = Array.isArray(req.allowedSourceIds) ? req.allowedSourceIds : [];
    const first = allowed[0];
    const citations = first
      ? [
          {
            messageId: first,
            threadId: 'demo-thread',
            subject: '🧪 [DEMO] mock subprocess',
            from: 'demo-mock@synthetic.test',
            date: new Date().toISOString(),
            snippet: 'Marked mock. No remote generation.',
          },
        ]
      : [];
    send({
      isMock: true,
      mockLabel: 'Mock AI (No External Connection)',
      response: `🔧 MOCK subprocess (no AI connected)\nquery=${typeof req.query === 'string' ? req.query : ''}\nallowed=${allowed.length}`,
      citations,
      tokensUsed: 0,
    });
  });
}
