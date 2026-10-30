'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const github = require('../lib/source/github.js');
const { filterChangeFiles } = require('../lib/source/remote.js');
const { parseDiff, itemsFromFiles } = require('../lib/diff/diff.js');
const { jsonResponse, CHANGE_DIFF: PR_DIFF } = require('./helpers.js');
const { parseGithubPrUrl, parseGithubIssueUrl, githubToken } = github;
const { parseGithubIssueListUrl } = github;
const { loadPullRequest, loadGithubIssue } = github;
const { prApiUrl, discussionToNotes } = github;

const PR = { owner: 'acme', repo: 'app', number: 123 };

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

const EMPTY_THREADS = {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [],
        },
      },
    },
  },
};

const mockFetch = (json, diff, status = 200, routes = {}) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const headers = init.headers || {};
    calls.push({
      url,
      accept: headers.Accept,
      auth: headers.Authorization || '',
      method: init.method || 'GET',
    });
    if (headers.Accept === 'application/vnd.github.diff') {
      return jsonResponse(status, diff);
    }
    if (`${url}`.includes('/graphql')) {
      return jsonResponse(200, routes.graphql ?? EMPTY_THREADS);
    }
    if (`${url}`.includes('/pulls/') && `${url}`.includes('/comments')) {
      const page = routes.reviewComments ?? [];
      const extra = routes.reviewCommentHeaders ?? {};
      return jsonResponse(200, page, extra);
    }
    if (`${url}`.includes('/reviews')) {
      return jsonResponse(200, routes.reviews ?? []);
    }
    if (`${url}`.includes('/issues/') && `${url}`.includes('/comments')) {
      return jsonResponse(200, routes.issueComments ?? []);
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

const DEP_PR_DIFF = `diff --git a/package.json b/package.json
index 1111111..2222222 100644
--- a/package.json
+++ b/package.json
@@ -1,6 +1,6 @@
 {
   "name": "demo",
   "dependencies": {
-    "lodash": "^4.17.20"
+    "lodash": "^4.17.21"
   }
 }
diff --git a/package-lock.json b/package-lock.json
index 1111111..2222222 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,8 +1,8 @@
 {
   "lockfileVersion": 3,
   "packages": {
     "node_modules/lodash": {
-      "version": "4.17.20"
+      "version": "4.17.21"
     }
   }
 }
`;

test('loadPullRequest converts a GitHub patch into pr items', async () => {
  const fetchImpl = mockFetch(PR_JSON, PR_DIFF);
  const loaded = await loadPullRequest(PR, {
    fetch: fetchImpl,
    token: '',
    cwd: '/tmp',
  });
  assert.equal(fetchImpl.calls.length, 6);
  const url = prApiUrl(PR);
  assert.equal(fetchImpl.calls[0].url, url);
  assert.equal(loaded.sourceLabel, '#123');
  assert.equal(loaded.change.title, 'Fix parser');
  assert.equal(loaded.change.author, 'alice');
  assert.equal(loaded.change.repository, 'acme/app');
  assert.equal(loaded.change.base, 'main');
  assert.equal(loaded.change.head, 'fix-parser');
  assert.equal(loaded.change.number, 123);
  assert.equal(loaded.change.source, 'pr');
  assert.deepEqual(loaded.change.files, ['lib/parser.js', 'README.md']);
  assert.equal(loaded.items.length, 2);
  assert.equal(loaded.items[0].origin, 'pr');
  assert.equal(loaded.items[0].file.newPath, 'lib/parser.js');
  assert.ok(loaded.items[0].hunk);
  assert.equal(loaded.items[1].file.newPath, 'README.md');
  assert.deepEqual(loaded.imported, { blockTasks: [], tasks: [] });
});

test('loadPullRequest folds package.json and lockfile changes', async () => {
  const fetchImpl = mockFetch(PR_JSON, DEP_PR_DIFF);
  const loaded = await loadPullRequest(PR, {
    fetch: fetchImpl,
    token: '',
    cwd: '/tmp',
  });
  assert.deepEqual(loaded.change.files, ['package.json', 'package-lock.json']);
  assert.equal(loaded.items.length, 1);
  assert.ok(loaded.items[0].dep);
  const hunkLines = loaded.items[0].hunk.lines;
  const lines = hunkLines.map((line) => line.text);
  assert.equal(lines[0], 'Dependencies in package.json & package-lock.json');
  assert.ok(lines.includes('dependency version changed'));
});

test('loadPullRequest sends a bearer token', async () => {
  const fetchImpl = mockFetch(PR_JSON, PR_DIFF);
  await loadPullRequest(PR, { fetch: fetchImpl, token: 'secret' });
  assert.ok(fetchImpl.calls.length >= 2);
  for (const call of fetchImpl.calls) {
    assert.equal(call.auth, 'Bearer secret');
  }
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

for (const [status, message, error] of [
  [404, 'Not Found', /GitHub pull request not found/],
  [403, 'API rate limit exceeded', /rate limit exceeded/],
  [401, 'Bad credentials', /GitHub authentication failed/],
]) {
  test(`loadPullRequest maps ${status} to its error`, async () => {
    const fetchImpl = mockFetch({ message }, '', status);
    const options = { fetch: fetchImpl, token: 'tok', retry: { attempts: 1 } };
    await assert.rejects(() => loadPullRequest(PR, options), error);
  });
}

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
  assert.ok(calls >= 3);
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

test('discussionToNotes maps an inline comment onto hunk feedback', () => {
  const items = itemsFromFiles(parseDiff(PR_DIFF), 'pr');
  const notes = discussionToNotes(
    {
      reviewComments: [
        {
          id: 10,
          user: { login: 'alice' },
          body: 'use const',
          path: 'lib/parser.js',
          line: 2,
          side: 'RIGHT',
        },
      ],
    },
    items,
  );
  assert.equal(notes.blockTasks.length, 1);
  assert.equal(notes.tasks.length, 0);
  const note = notes.blockTasks[0];
  assert.equal(note.file, 'lib/parser.js');
  assert.equal(note.oldStart, 1);
  assert.equal(note.newStart, 1);
  assert.equal(note.blockId, 0);
  assert.equal(note.origin, 'pr');
  assert.equal(note.text, '@alice review at github: use const');
  assert.doesNotMatch(note.text, /source:/);
  assert.equal(note.done, false);
});

test('discussionToNotes maps file-level and general comments to todos', () => {
  const items = itemsFromFiles(parseDiff(PR_DIFF), 'pr');
  const fileComment = {
    id: 11,
    user: { login: 'bob' },
    body: 'add types',
    path: 'lib/parser.js',
  };
  fileComment['subject_type'] = 'file';
  const notes = discussionToNotes(
    {
      reviewComments: [fileComment],
      reviews: [
        { user: { login: 'carol' }, body: 'Looks good overall' },
        { user: { login: 'carol' }, body: '  ' },
      ],
      issueComments: [{ user: { login: 'dave' }, body: 'Please add tests' }],
    },
    items,
  );
  assert.equal(notes.blockTasks.length, 0);
  assert.equal(notes.tasks.length, 3);
  assert.equal(notes.tasks[0].file, 'lib/parser.js');
  assert.match(notes.tasks[0].text, /add types/);
  assert.equal(notes.tasks[1].file, 'pull request');
  assert.match(notes.tasks[1].text, /Looks good overall/);
  assert.match(notes.tasks[2].text, /Please add tests/);
});

test('discussionToNotes marks resolved inline comments done', () => {
  const items = itemsFromFiles(parseDiff(PR_DIFF), 'pr');
  const resolvedById = new Map([[10, true]]);
  const notes = discussionToNotes(
    {
      reviewComments: [
        {
          id: 10,
          user: { login: 'alice' },
          body: 'use const',
          path: 'lib/parser.js',
          line: 2,
          side: 'RIGHT',
        },
      ],
      resolvedById,
    },
    items,
  );
  assert.equal(notes.blockTasks[0].done, true);
  assert.equal(notes.blockTasks[0].text, '@alice review at github: use const');
});

test('discussionToNotes maps a later hunk block by new line', () => {
  const item0 = {
    origin: 'pr',
    file: { newPath: 'a.js', oldPath: 'a.js' },
    hunk: {
      oldStart: 1,
      oldCount: 5,
      newStart: 1,
      newCount: 5,
      header: '@@ -1,5 +1,5 @@',
      lines: [
        { type: 'ctx', text: 'keep', noNl: false, blockId: null },
        { type: 'del', text: 'a', noNl: false, blockId: 0 },
        { type: 'add', text: 'b', noNl: false, blockId: 0 },
        { type: 'ctx', text: 'mid', noNl: false, blockId: null },
        { type: 'del', text: 'c', noNl: false, blockId: 1 },
        { type: 'add', text: 'd', noNl: false, blockId: 1 },
      ],
    },
    blockId: 0,
  };
  const item1 = { ...item0, blockId: 1 };
  const notes = discussionToNotes(
    {
      reviewComments: [
        {
          id: 1,
          user: { login: 'alice' },
          body: 'rename d',
          path: 'a.js',
          line: 4,
          side: 'RIGHT',
        },
      ],
    },
    [item0, item1],
  );
  assert.equal(notes.blockTasks.length, 1);
  assert.equal(notes.blockTasks[0].blockId, 1);
});

test('discussionToNotes skips empty bodies and out of scope paths', () => {
  const items = itemsFromFiles(parseDiff(PR_DIFF), 'pr');
  const notes = discussionToNotes(
    {
      reviewComments: [
        {
          id: 1,
          user: { login: 'a' },
          body: '  ',
          path: 'lib/parser.js',
          line: 2,
          side: 'RIGHT',
        },
        {
          id: 2,
          user: { login: 'a' },
          body: 'readme nit',
          path: 'README.md',
          line: 1,
          side: 'RIGHT',
        },
        {
          id: 3,
          user: { login: 'a' },
          body: 'parser nit',
          path: 'lib/parser.js',
          line: 2,
          side: 'RIGHT',
        },
      ],
      issueComments: [{ user: { login: 'b' }, body: 'please add tests' }],
    },
    items,
    ['lib'],
  );
  assert.equal(notes.blockTasks.length, 1);
  assert.match(notes.blockTasks[0].text, /parser nit/);
  assert.equal(notes.tasks.length, 1);
  assert.match(notes.tasks[0].text, /please add tests/);
});

test('loadPullRequest imports review discussion', async () => {
  const comment = {
    id: 10,
    user: { login: 'alice' },
    body: 'use const',
    path: 'lib/parser.js',
    line: 2,
    side: 'RIGHT',
  };
  const fetchImpl = mockFetch(PR_JSON, PR_DIFF, 200, {
    reviewComments: [comment],
    reviews: [{ user: { login: 'carol' }, body: 'Looks good overall' }],
    issueComments: [{ user: { login: 'dave' }, body: 'Please add tests' }],
    graphql: {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  isResolved: true,
                  comments: { nodes: [{ databaseId: 10 }] },
                },
              ],
            },
          },
        },
      },
    },
  });
  const loaded = await loadPullRequest(PR, { fetch: fetchImpl, token: '' });
  assert.equal(loaded.imported.blockTasks.length, 1);
  assert.equal(loaded.imported.blockTasks[0].done, true);
  assert.match(loaded.imported.blockTasks[0].text, /use const/);
  assert.equal(loaded.imported.tasks.length, 2);
});

test('loadPullRequest paginates review comments', async () => {
  const first = {
    id: 1,
    user: { login: 'a' },
    body: 'first',
    path: 'lib/parser.js',
    line: 2,
    side: 'RIGHT',
  };
  const second = {
    id: 2,
    user: { login: 'b' },
    body: 'second',
    path: 'lib/parser.js',
    line: 2,
    side: 'RIGHT',
  };
  const next = `${prApiUrl(PR)}/comments?page=2&per_page=100`;
  let commentPages = 0;
  const base = mockFetch(PR_JSON, PR_DIFF);
  const fetchImpl = async (url, init) => {
    if (`${url}`.includes('/pulls/') && `${url}`.includes('/comments')) {
      commentPages += 1;
      if (commentPages === 1) {
        return jsonResponse(200, [first], {
          Link: `<${next}>; rel="next"`,
        });
      }
      return jsonResponse(200, [second]);
    }
    return base(url, init);
  };
  const loaded = await loadPullRequest(PR, { fetch: fetchImpl, token: '' });
  assert.equal(commentPages, 2);
  assert.equal(loaded.imported.blockTasks.length, 2);
  assert.match(loaded.imported.blockTasks[0].text, /first/);
  assert.match(loaded.imported.blockTasks[1].text, /second/);
});

test('loadPullRequest still opens when discussion import fails', async () => {
  const base = mockFetch(PR_JSON, PR_DIFF);
  const fetchImpl = async (url, init) => {
    if (`${url}`.includes('/pulls/') && `${url}`.includes('/comments')) {
      return jsonResponse(500, { message: 'boom' });
    }
    return base(url, init);
  };
  const loaded = await loadPullRequest(PR, {
    fetch: fetchImpl,
    token: '',
    retry: { attempts: 1 },
  });
  assert.equal(loaded.change.number, 123);
  assert.deepEqual(loaded.imported, { blockTasks: [], tasks: [] });
});

test('discussionToNotes falls back to a todo when unmatched', () => {
  const items = itemsFromFiles(parseDiff(PR_DIFF), 'pr');
  const notes = discussionToNotes(
    {
      reviewComments: [
        {
          id: 1,
          user: { login: 'alice' },
          body: 'orphan',
          path: 'lib/parser.js',
          line: 99,
          side: 'RIGHT',
        },
      ],
    },
    items,
  );
  assert.equal(notes.blockTasks.length, 0);
  assert.equal(notes.tasks.length, 1);
  assert.equal(notes.tasks[0].file, 'lib/parser.js');
  assert.match(notes.tasks[0].text, /orphan/);
});

test('loadPullRequest abort during discussion does not fallback', async () => {
  const ac = new AbortController();
  const base = mockFetch(PR_JSON, PR_DIFF);
  const fetchImpl = async (url, init) => {
    if (`${url}`.includes('/pulls/') && `${url}`.includes('/comments')) {
      const error = new Error('fetch failed');
      error.code = 'ECONNRESET';
      throw error;
    }
    return base(url, init);
  };
  const pending = loadPullRequest(PR, {
    fetch: fetchImpl,
    token: '',
    retry: { attempts: 3, delayMs: 30_000 },
    signal: ac.signal,
  });
  await new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
  ac.abort();
  await assert.rejects(pending, (error) => {
    assert.equal(ac.signal.aborted, true);
    return error.name === 'AbortError' || error === ac.signal.reason;
  });
});

test('loadPullRequest keeps comments if GraphQL resolved fails', async () => {
  const comment = {
    id: 10,
    user: { login: 'alice' },
    body: 'use const',
    path: 'lib/parser.js',
    line: 2,
    side: 'RIGHT',
  };
  const base = mockFetch(PR_JSON, PR_DIFF, 200, {
    reviewComments: [comment],
  });
  const fetchImpl = async (url, init) => {
    if (`${url}`.includes('/graphql')) {
      return jsonResponse(401, { message: 'Bad credentials' });
    }
    return base(url, init);
  };
  const loaded = await loadPullRequest(PR, { fetch: fetchImpl, token: '' });
  assert.equal(loaded.imported.blockTasks.length, 1);
  assert.equal(loaded.imported.blockTasks[0].done, false);
  assert.match(loaded.imported.blockTasks[0].text, /use const/);
});

const ISSUE = { owner: 'acme', repo: 'app', number: 12 };

const ISSUE_JSON = JSON.parse(`{
  "number": 12,
  "title": "Add import",
  "body": "from the cli",
  "state": "open",
  "html_url": "https://github.com/acme/app/issues/12",
  "user": { "login": "alice" }
}`);

const issueFetch = (json, comments, status = 200) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const headers = init.headers || {};
    calls.push({ url: `${url}`, auth: headers.Authorization || '' });
    if (`${url}`.includes('/comments')) return jsonResponse(200, comments);
    return jsonResponse(status, json);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
};

test('parseGithubIssueUrl reads github issue URLs', () => {
  const expected = { owner: 'acme', repo: 'app', number: 12 };
  const urls = [
    'https://github.com/acme/app/issues/12',
    'https://github.com/acme/app/issues/12/',
    'https://www.github.com/acme/app/issues/12',
    'http://github.com/acme/app/issues/12',
    'github.com/acme/app/issues/12',
    'https://github.com/acme/app/issues/12#issuecomment-9',
    'https://github.com/acme/app/issues/12?plain=1',
  ];
  for (const url of urls) {
    assert.deepEqual(parseGithubIssueUrl(url), expected, url);
  }
});

test('parseGithubIssueUrl rejects non issue URLs', () => {
  const urls = [
    '',
    'lib/parser.js',
    'https://github.com/acme/app',
    'https://github.com/acme/app/pull/12',
    'https://github.com/acme/app/issues',
    'https://gitlab.com/acme/app/issues/12',
    'https://github.com/acme/app/issues/0',
  ];
  for (const url of urls) {
    assert.equal(parseGithubIssueUrl(url), null, url);
  }
});

test('loadGithubIssue imports the title, body, and comments', async () => {
  const comments = [
    { user: { login: 'bob' }, body: '  seen  ' },
    { user: { login: 'cara' }, body: '   ' },
  ];
  const fetchImpl = issueFetch(ISSUE_JSON, comments);
  const loaded = await loadGithubIssue(ISSUE, {
    cwd: '/repo',
    fetch: fetchImpl,
    token: 'secret',
  });
  assert.deepEqual(loaded.items, []);
  assert.equal(loaded.sourceLabel, '#12');
  assert.equal(loaded.change.source, 'issue');
  assert.equal(loaded.change.repository, 'acme/app');
  assert.equal(loaded.change.number, 12);
  assert.equal(loaded.change.url, ISSUE_JSON['html_url']);
  assert.equal(loaded.imported.tasks.length, 1);
  assert.equal(loaded.imported.tasks[0].file, 'issue');
  assert.match(loaded.imported.tasks[0].text, /^@alice at github: Add import/);
  assert.match(loaded.imported.tasks[0].text, /from the cli/);
  assert.equal(
    loaded.imported.tasks[0].text.endsWith(
      '\nIssue: https://github.com/acme/app/issues/12',
    ),
    true,
  );
  assert.equal(loaded.imported.tasks[0].done, false);
  const { issue } = loaded.imported.tasks[0];
  assert.equal(issue.title, 'Add import');
  assert.equal(issue.body, 'from the cli');
  assert.equal(issue.author, 'alice');
  assert.equal(issue.host, 'github');
  assert.deepEqual(issue.comments, [{ author: 'bob', body: 'seen' }]);
  const commentCall = fetchImpl.calls.find((call) =>
    call.url.includes('/comments'),
  );
  assert.match(commentCall.url, /\/repos\/acme\/app\/issues\/12\/comments/);
  assert.equal(fetchImpl.calls[0].auth, 'Bearer secret');
});

test('loadGithubIssue marks a closed issue done', async () => {
  const closed = { ...ISSUE_JSON, state: 'closed', body: '' };
  const fetchImpl = issueFetch(closed, []);
  const loaded = await loadGithubIssue(ISSUE, {
    fetch: fetchImpl,
    token: '',
  });
  assert.equal(loaded.imported.tasks.length, 1);
  assert.equal(loaded.imported.tasks[0].done, true);
  assert.match(loaded.imported.tasks[0].text, /^@alice at github: Add import/);
});

test('parseGithubIssueListUrl reads a repo and an issue list', () => {
  const expected = { owner: 'acme', repo: 'app', list: true };
  const urls = [
    'https://github.com/acme/app',
    'https://github.com/acme/app/',
    'https://github.com/acme/app.git',
    'https://www.github.com/acme/app/issues',
    'https://github.com/acme/app/issues/',
    'github.com/acme/app/issues?q=is%3Aopen',
  ];
  for (const url of urls) {
    assert.deepEqual(parseGithubIssueListUrl(url), expected, url);
  }
});

test('parseGithubIssueListUrl rejects other github URLs', () => {
  const urls = [
    '',
    'lib/parser.js',
    'https://github.com/acme/app/issues/12',
    'https://github.com/acme/app/pull/12',
    'https://github.com/acme/app/pulls',
    'https://gitlab.com/acme/app/issues',
  ];
  for (const url of urls) {
    assert.equal(parseGithubIssueListUrl(url), null, url);
  }
});

test('loadGithubIssue imports every open issue from a list', async () => {
  const open = {
    number: 31,
    title: 'Support conflict resolution',
    body: 'when a rebase stops',
    state: 'open',
    user: { login: 'ScriptHound' },
  };
  const closed = {
    number: 2,
    title: 'Old',
    body: 'done',
    state: 'closed',
    user: { login: 'alice' },
  };
  const pull = JSON.parse(`{
    "number": 9,
    "title": "A pull request",
    "body": "not an issue",
    "state": "open",
    "user": { "login": "bob" },
    "pull_request": { "url": "https://api.github.com/pulls/9" }
  }`);
  const later = {
    number: 129,
    title: 'Line numbers',
    body: '',
    state: 'open',
    user: { login: 'ScriptHound' },
  };
  const comments = {
    31: [{ user: { login: 'cara' }, body: 'agree' }],
    129: [],
  };
  const calls = [];
  const fetchImpl = async (url) => {
    const href = `${url}`;
    calls.push(href);
    const comment = /issues\/(\d+)\/comments/.exec(href);
    if (comment) return jsonResponse(200, comments[comment[1]] ?? []);
    return jsonResponse(200, [later, closed, pull, open]);
  };
  const loaded = await loadGithubIssue(
    { owner: 'acme', repo: 'app', list: true },
    { fetch: fetchImpl, token: '' },
  );
  assert.match(calls[0], /\/repos\/acme\/app\/issues\?/);
  assert.match(calls[0], /state=open/);
  assert.equal(loaded.sourceLabel, 'acme/app');
  assert.equal(loaded.change.source, 'issue');
  assert.equal(loaded.imported.tasks.length, 2);
  const texts = loaded.imported.tasks.map((task) => task.text);
  assert.match(texts[0], /^@ScriptHound at github: Line numbers/);
  assert.equal(
    texts[0].endsWith('\nIssue: https://github.com/acme/app/issues/129'),
    true,
  );
  assert.match(texts[1], /^@ScriptHound at github: Support conflict/);
  assert.equal(
    texts[1].endsWith('\nIssue: https://github.com/acme/app/issues/31'),
    true,
  );
  assert.deepEqual(loaded.imported.tasks[1].issue.comments, [
    { author: 'cara', body: 'agree' },
  ]);
  assert.equal(
    texts.some((text) => text.includes('Old')),
    false,
  );
  assert.equal(
    texts.some((text) => text.includes('pull request')),
    false,
  );
  assert.equal(
    calls.some((href) => href.includes('/issues/2/')),
    false,
  );
  assert.equal(
    calls.some((href) => href.includes('/issues/9/')),
    false,
  );
});

test('loadGithubIssue maps 404 to a not found error', async () => {
  const fetchImpl = issueFetch({ message: 'Not Found' }, [], 404);
  await assert.rejects(
    () => loadGithubIssue(ISSUE, { fetch: fetchImpl, token: '' }),
    /GitHub issue not found/,
  );
});
