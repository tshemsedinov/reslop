'use strict';

const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { Linter } = require('eslint');

const SESSION_FILE = path.resolve(__dirname, '../lib/session.js');

const resolveRelative = (fromFile, spec) => {
  if (typeof spec !== 'string' || !spec.startsWith('.')) return null;
  let resolved = path.resolve(path.dirname(fromFile), spec);
  if (path.extname(resolved) === '') resolved += '.js';
  return path.normalize(resolved);
};

const requireSpecifier = (node) => {
  if (node.type === 'Literal') return node.value;
  if (node.type !== 'TemplateLiteral') return null;
  if (node.expressions.length) return null;
  return node.quasis[0].value.cooked;
};

const local = {
  rules: {
    'session-class-lines': {
      meta: {
        type: 'problem',
        schema: [{ type: 'integer', minimum: 1 }],
        messages: {
          tooLong: 'Session class is {{span}} lines (max {{max}}).',
        },
      },
      create(context) {
        const max = context.options[0] ?? 500;
        const check = (node) => {
          if (!node.id || node.id.name !== 'Session') return;
          const loc = node.loc;
          if (!loc) return;
          const span = loc.end.line - loc.start.line + 1;
          if (span <= max) return;
          context.report({
            node,
            messageId: 'tooLong',
            data: { span, max },
          });
        };
        return {
          ClassDeclaration: check,
          ClassExpression: check,
        };
      },
    },
    'no-session-require': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          forbidden: 'Session modules must not import Session.',
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            if (node.callee.type !== 'Identifier') return;
            if (node.callee.name !== 'require') return;
            if (node.arguments.length !== 1) return;
            const spec = requireSpecifier(node.arguments[0]);
            const resolved = resolveRelative(context.filename, spec);
            if (resolved !== SESSION_FILE) return;
            context.report({ node, messageId: 'forbidden' });
          },
        };
      },
    },
  },
};

const FUNCTION_RULE = [
  'error',
  {
    max: 100,
    skipBlankLines: false,
    skipComments: false,
    IIFEs: true,
  },
];

const lint = (code, rules, filename = 'file.js') => {
  const linter = new Linter();
  return linter.verify(
    code,
    [
      {
        files: ['**/*.js'],
        languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs' },
        plugins: { local },
        rules,
      },
    ],
    { filename },
  );
};

const ruleIds = (messages) => messages.map((message) => message.ruleId);

const exprArrow = (lineCount) => {
  const parts = ['const f = () =>'];
  for (let i = 2; i < lineCount; i++) parts.push('  1 +');
  parts.push('  1;');
  return `${parts.join('\n')}\n`;
};

const blockArrow = (lineCount, secondLine) => {
  const parts = ['const f = () => {', secondLine];
  while (parts.length < lineCount - 1) parts.push('  void 0;');
  parts.push('};');
  return `${parts.join('\n')}\n`;
};

const sessionClass = (lineCount) => {
  const parts = ['class Session {'];
  while (parts.length < lineCount - 1) parts.push('  noop() {}');
  parts.push('}');
  return `${parts.join('\n')}\n`;
};

test('expression-bodied arrows count toward the function limit', () => {
  const allowed = lint(exprArrow(100), {
    'max-lines-per-function': FUNCTION_RULE,
  });
  const over = lint(exprArrow(104), {
    'max-lines-per-function': FUNCTION_RULE,
  });
  assert.deepEqual(ruleIds(allowed), []);
  assert.ok(ruleIds(over).includes('max-lines-per-function'));
});

test('regex braces do not end the enclosing function', () => {
  const code = blockArrow(105, '  const re = /}/;');
  const messages = lint(code, { 'max-lines-per-function': FUNCTION_RULE });
  assert.ok(ruleIds(messages).includes('max-lines-per-function'));
});

test('template interpolation braces do not end the enclosing function', () => {
  const interpol = ['$', '{x}'].join('');
  const second = ['  const t = `', '}', interpol, '`;'].join('');
  const messages = lint(blockArrow(105, second), {
    'max-lines-per-function': FUNCTION_RULE,
  });
  assert.ok(ruleIds(messages).includes('max-lines-per-function'));
});

test('multiline parameters stay part of the function span', () => {
  const parts = ['const f = (', '  a,', '  b', ') => {'];
  while (parts.length < 104) parts.push('  void 0;');
  parts.push('};');
  const messages = lint(`${parts.join('\n')}\n`, {
    'max-lines-per-function': FUNCTION_RULE,
  });
  assert.ok(ruleIds(messages).includes('max-lines-per-function'));
});

test('Session class length uses parser locations', () => {
  const allowed = lint(sessionClass(500), {
    'local/session-class-lines': ['error', 500],
  });
  const over = lint(sessionClass(501), {
    'local/session-class-lines': ['error', 500],
  });
  assert.deepEqual(ruleIds(allowed), []);
  assert.ok(ruleIds(over).includes('local/session-class-lines'));
});

test('session modules cannot require Session through relative paths', () => {
  const filename = path.resolve(__dirname, '../lib/session/load.js');
  const requireCall = (spec, quote) => `require(${quote}${spec}${quote});\n`;
  const single = String.fromCharCode(39);
  const double = '"';
  const hits = [
    requireCall('../session.js', single),
    requireCall('../session.js', double),
    requireCall('../session', single),
  ];
  for (const code of hits) {
    const messages = lint(
      code,
      { 'local/no-session-require': 'error' },
      filename,
    );
    assert.ok(ruleIds(messages).includes('local/no-session-require'), code);
  }
  const nested = lint(
    requireCall('./session.js', single),
    { 'local/no-session-require': 'error' },
    filename,
  );
  assert.deepEqual(ruleIds(nested), []);
});
