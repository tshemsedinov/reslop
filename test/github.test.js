'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const github = require('../lib/github.js');
const { parseGithubPrUrl, githubToken, loadPullRequest } = github;
const { filterChangeFiles, prApiUrl } = github;

const PR = { owner: 'acme', repo: 'app', number: 123 };

const PR_DIFF = `diff --git a/lib/parser.js b/lib/parser.js
index 1111111..2222222 100644
--- a/lib/parser.js
+++ b/lib/parser.js
@@ -1,3 +1,4 @@
 keep
-old
+new
 keep
diff --git a/README.md b/README.md
index 1111111..2222222 100644
--- a/README.md
+++ b/README.md
@@ -1,1 +1,1 @@
-hello
+Hello
`;

const PR_JSON = JSON.parse(`{
  "number": 123,
  "title": "Fix parser",
  "html_url": "https://github.com/acme/app/pull/123",
  "user": { "login": "alice" },
  "base": {
    "ref": "main",
    "sha": "aaa",
    "repo": { "full_name": "acme/app" }
  },
  "head": { "ref": "fix-parser", "sha": "bbb" }
}`);

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

const mockFetch = (json, diff, status = 200) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({
      url,
      accept: init.headers.Accept,
      auth: init.headers.Authorization || '',
    });
    if (init.headers.Accept === 'application/vnd.github.diff') {
      return jsonResponse(status, diff);
    }
    return jsonResponse(status, json);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
};

test('parseGithubPrUrl reads github pull request URLs', () => {
  const expected = { owner: 'acme', repo: 'app', number: 123 };
  const urls = [
    'https://github.com/acme/app/pull/123',
    'https://github.com/acme/app/pull/123/',
    'https://github.com/acme/app/pull/123/files',
    'https://github.com/acme/app/pull/123/commits',
    'https://www.github.com/acme/app/pull/123',
    'http://github.com/acme/app/pull/123',
    'github.com/acme/app/pull/123',
    'https://github.com/acme/app/pull/123.diff',
    'https://github.com/acme/app/pull/123.patch',
    'https://github.com/acme/app/pull/123/files?w=1',
    'https://github.com/acme/app/pull/123#discussion_r9',
  ];
  for (const url of urls) {
    assert.deepEqual(parseGithubPrUrl(url), expected, url);
  }
});

test('parseGithubPrUrl rejects non pull request URLs', () => {
  const urls = [
    '',
    'lib/parser.js',
    'https://github.com/acme/app',
    'https://github.com/acme/app/issues/123',
    'https://github.com/acme/app/pulls',
    'https://gitlab.com/acme/app/pull/123',
    'https://github.com/acme/app/pull/0',
  ];
  for (const url of urls) {
    assert.equal(parseGithubPrUrl(url), null, url);
  }
});

test('githubToken reads GITHUB_TOKEN then GH_TOKEN', () => {
  assert.equal(githubToken({ GITHUB_TOKEN: 'a', GH_TOKEN: 'b' }), 'a');
  assert.equal(githubToken({ GH_TOKEN: 'b' }), 'b');
  assert.equal(githubToken({}), '');
});

test('loadPullRequest converts a GitHub patch into pr items', async () => {
  const fetchImpl = mockFetch(PR_JSON, PR_DIFF);
  const loaded = await loadPullRequest(PR, {
    fetch: fetchImpl,
    token: '',
    cwd: '/tmp',
  });
  assert.equal(fetchImpl.calls.length, 2);
  const url = prApiUrl(PR);
  assert.equal(fetchImpl.calls[0].url, url);
  assert.equal(loaded.sourceLabel, '#123');
  assert.equal(loaded.change.title, 'Fix parser');
  assert.equal(loaded.change.author, 'alice');
  assert.equal(loaded.change.repository, 'acme/app');
  assert.equal(loaded.change.base, 'main');
  assert.equal(loaded.change.head, 'fix-parser');
  assert.equal(loaded.change.number, 123);
  assert.equal(loaded.change.source, 'github-pr');
  assert.deepEqual(loaded.change.files, ['lib/parser.js', 'README.md']);
  assert.equal(loaded.items.length, 2);
  assert.equal(loaded.items[0].origin, 'pr');
  assert.equal(loaded.items[0].file.newPath, 'lib/parser.js');
  assert.ok(loaded.items[0].hunk);
  assert.equal(loaded.items[1].file.newPath, 'README.md');
});

test('loadPullRequest sends a bearer token', async () => {
  const fetchImpl = mockFetch(PR_JSON, PR_DIFF);
  await loadPullRequest(PR, { fetch: fetchImpl, token: 'secret' });
  assert.equal(fetchImpl.calls[0].auth, 'Bearer secret');
  assert.equal(fetchImpl.calls[1].auth, 'Bearer secret');
});

test('loadPullRequest filters files by path scope', async () => {
  const fetchImpl = mockFetch(PR_JSON, PR_DIFF);
  const loaded = await loadPullRequest(PR, {
    fetch: fetchImpl,
    token: '',
    paths: ['lib'],
  });
  assert.deepEqual(loaded.change.files, ['lib/parser.js']);
  assert.equal(loaded.items.length, 1);
  assert.equal(loaded.items[0].file.newPath, 'lib/parser.js');
});

test('filterChangeFiles keeps matching paths', () => {
  const files = [
    { newPath: 'lib/a.js', oldPath: 'lib/a.js' },
    { newPath: 'README.md', oldPath: 'README.md' },
  ];
  const kept = filterChangeFiles(files, ['lib']);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].newPath, 'lib/a.js');
});

test('loadPullRequest maps 404 to a not found error', async () => {
  const fetchImpl = mockFetch({ message: 'Not Found' }, '', 404);
  await assert.rejects(
    () => loadPullRequest(PR, { fetch: fetchImpl, token: '' }),
    /GitHub pull request not found/,
  );
});

test('loadPullRequest maps rate limit errors', async () => {
  const fetchImpl = mockFetch({ message: 'API rate limit exceeded' }, '', 403);
  await assert.rejects(
    () => loadPullRequest(PR, { fetch: fetchImpl, token: 'tok' }),
    /rate limit exceeded/,
  );
});

test('loadPullRequest maps network failures', async () => {
  const fetchImpl = async () => {
    const error = new Error('fetch failed');
    error.code = 'ECONNRESET';
    throw error;
  };
  await assert.rejects(
    () =>
      loadPullRequest(PR, {
        fetch: fetchImpl,
        token: '',
        retry: { attempts: 1 },
      }),
    /GitHub request failed/,
  );
});

test('loadPullRequest retries a transient network error', async () => {
  const base = mockFetch(PR_JSON, PR_DIFF);
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    if (calls === 1) {
      const error = new Error('fetch failed');
      error.code = 'ECONNRESET';
      throw error;
    }
    return base(url, init);
  };
  const loaded = await loadPullRequest(PR, {
    fetch: fetchImpl,
    token: '',
    retry: { delayMs: 0 },
  });
  assert.equal(loaded.change.number, 123);
  assert.equal(calls, 3);
});

test('loadPullRequest rejects invalid pull request JSON', async () => {
  const fetchImpl = async (url, init) => {
    if (init.headers.Accept === 'application/vnd.github.diff') {
      return jsonResponse(200, PR_DIFF);
    }
    return jsonResponse(200, 'not json {');
  };
  await assert.rejects(
    () => loadPullRequest(PR, { fetch: fetchImpl, token: '' }),
    /invalid pull request payload/,
  );
});

test('loadPullRequest maps 401 to an auth error', async () => {
  const fetchImpl = mockFetch({ message: 'Bad credentials' }, '', 401);
  await assert.rejects(
    () => loadPullRequest(PR, { fetch: fetchImpl, token: 'tok' }),
    /GitHub authentication failed/,
  );
});
