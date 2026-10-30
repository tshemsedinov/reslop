'use strict';

const { paintBodyFill, paneResult } = require('./primitives.js');
const tiles = require('./tiles.js');
const { layoutTiles, paintTile, composeBands, tileHits, pageFill, seg } = tiles;
const { spinner, blinkTone, RUN_ICON } = tiles;
const blocks = require('./dashboard-blocks.js');
const { filesBlock, diffsBlock, npmBlock, tasksBlock } = blocks;
const { agentsBlock } = require('./agents.js');
const { DASH_TILES } = require('../input/actions.js');
const { ago, duration } = require('../common/format.js');
const table = require('./table.js');
const { isHot, notice, cell, cellSegs, flexCell, tableLines } = table;
const { titleAside, captionOver } = table;
const { cmpEn } = require('../common/utilities.js');

const NAME_MAX = 18;

const MARGIN_MIN_H = 12;

const blankCell = () => cell('', 'muted', 'r');

const ageCell = (at, now) => cell(at ? ago(at, now) : '', 'muted', 'r');

const rebaseStep = (rebase) => {
  const total = rebase.total ? `/${rebase.total}` : '';
  return `${rebase.step || '?'}${total}`;
};

const commitRow = (entry, context, hot) => [
  cell(entry.short, hot ? 'warn' : 'sha', 'l', true),
  flexCell(entry.subject, hot ? 'warn' : 'text'),
  ageCell(entry.at, context.now),
];

const commitsBlock = (model, width, height, context, tile) => {
  const data = model.commits;
  if (!data.ready) return notice('reading git…');
  const { total, recent } = data.info;
  const badge = [];
  if (data.rebase) {
    const step = rebaseStep(data.rebase);
    badge.push(seg(`⟳ rebase ${step}`, 'warn', true));
  }
  const count = [seg(`${total}`, 'key', true)];
  const titleLine = titleAside(tile, count, width, badge);
  if (!recent.length) return notice('no commits', titleLine);
  const hot = isHot(data.changedAt, context.now);
  const shown = recent.slice(0, Math.max(0, height));
  const rows = shown.map((entry, i) =>
    commitRow(entry, context, hot && i === 0),
  );
  return { titleLine, lines: tableLines(rows, width) };
};

const trackText = (entry) => {
  if (entry.gone) return 'gone';
  if (!entry.upstream) return '';
  const ahead = entry.ahead ? `↑${entry.ahead}` : '';
  const behind = entry.behind ? `↓${entry.behind}` : '';
  return ahead + behind || '=';
};

const branchOrder = (list) =>
  [...list].sort((left, right) => {
    if (left.current !== right.current) return left.current ? -1 : 1;
    return right.at - left.at || cmpEn(left.name, right.name);
  });

const branchRow = (entry, data, context) => {
  const hot = isHot(data.hot.get(entry.name) ?? 0, context.now);
  const tone = hot ? blinkTone(context.frame) : 'text';
  const mark = entry.current ? '▶' : ' ';
  const name = entry.name.slice(0, NAME_MAX);
  const track = trackText(entry);
  const trackTone = entry.behind || entry.gone ? 'error' : 'warn';
  return [
    cellSegs([
      seg(mark, 'sha', true),
      seg(` ${name}`, tone, entry.current || hot),
    ]),
    cell(track, track === '=' ? 'muted' : trackTone),
    flexCell(entry.subject),
    ageCell(entry.at, context.now),
  ];
};

const branchExtras = (data, context) => {
  const rows = [];
  if (data.rebase) {
    const step = cell(rebaseStep(data.rebase), 'warn', 'l', true);
    rows.push([cell('rebase', 'muted'), step]);
  }
  const last = data.switches[0];
  if (last) {
    rows.push([
      cell('switched', 'muted'),
      flexCell(`${last.from} → ${last.to}`),
      ageCell(last.at, context.now),
    ]);
  }
  return rows;
};

const branchesBlock = (model, width, height, context, tile) => {
  const data = model.branches;
  if (!data.ready) return notice('reading git…');
  const badge = data.rebase ? [seg('⟳', 'warn', true)] : [];
  const aside = [seg(`${data.list.length}`, 'key', true)];
  const titleLine = titleAside(tile, aside, width, badge);
  if (!data.list.length) return notice('no branches', titleLine);
  const extras = branchExtras(data, context);
  const room = Math.max(1, height - extras.length);
  const shown = branchOrder(data.list).slice(0, room);
  const rows = shown.map((entry) => branchRow(entry, data, context));
  const lines = tableLines(rows, width);
  const fits = extras.slice(0, Math.max(0, height - lines.length));
  return { titleLine, lines: lines.concat(tableLines(fits, width)) };
};

const runIcon = (run, context) => {
  if (run.status === 'running') return [spinner(context.frame), 'warn'];
  return RUN_ICON[run.status] ?? ['?', 'muted'];
};

const countCell = (value, tone) => {
  if (typeof value !== 'number') return blankCell();
  return cell(`${value}`, tone, 'r');
};

const failTone = (value) => (value ? 'error' : 'muted');

const testMetrics = (ok, fail, total) => [
  countCell(ok, ok ? 'add' : 'muted'),
  countCell(fail, failTone(fail)),
  countCell(total, 'text'),
];

const runMetrics = (run) => {
  const result = run.result;
  if (result && typeof result.tests === 'number') {
    const fail = result.failed ?? 0;
    const ok = result.passed ?? Math.max(0, result.tests - fail);
    return testMetrics(ok, fail, result.tests);
  }
  const counted = run.done > 0 || run.failed > 0 || run.expected > 0;
  const live = run.status === 'running' && (run.source !== 'reslop' || counted);
  if (!live) return [blankCell(), blankCell(), blankCell()];
  const total = run.expected > 0 ? run.expected : null;
  return testMetrics(run.done, run.failed, total);
};

const lintNote = (run) => {
  const result = run.result;
  if (!result || typeof result.tests === 'number') return [];
  const { errors, warnings } = result;
  if (typeof errors !== 'number') return [];
  const note = [seg(`  ${errors} err`, failTone(errors))];
  if (typeof warnings !== 'number') return note;
  note.push(seg(`  ${warnings} warn`, warnings ? 'warn' : 'muted'));
  return note;
};

const spentCell = (run, context) => {
  const running = run.status === 'running';
  const end = running ? context.now : run.endedAt;
  if (!run.startedAt || !end) return blankCell();
  return cell(duration(end - run.startedAt), running ? 'warn' : 'muted', 'r');
};

const named = (icon, tone, name, nameTone) => ({
  segs: [seg(icon, tone, true), seg(' '), seg(name, nameTone)],
  align: 'l',
  flex: true,
  min: 6,
});

const runHeader = () => [
  cell(''),
  cell('ok', 'caption', 'r'),
  cell('fail', 'caption', 'r'),
  cell('total', 'caption', 'r'),
  cell('spent', 'caption', 'r'),
];

const runRow = (run, context) => {
  const icon = runIcon(run, context);
  const tone = run.status === 'running' ? 'text' : 'muted';
  const label = named(icon[0], icon[1], run.name, tone);
  label.segs.push(...lintNote(run));
  return [label, ...runMetrics(run), spentCell(run, context)];
};

const runsBlock = (model, width, height, context, tile) => {
  const rows = [];
  if (model.busy) {
    rows.push([named(spinner(context.frame), 'warn', model.busy, 'warn')]);
  }
  for (const run of model.runs) rows.push(runRow(run, context));
  if (!rows.length) return notice(['idle', 'reslop t -- <command>']);
  const shown = rows.slice(0, Math.max(1, height));
  const lines = tableLines([runHeader(), ...shown], width);
  return {
    titleLine: captionOver(tile, lines[0]),
    lines: lines.slice(1),
  };
};

const TILE_VIEW = {
  files: { rank: 3, size: 'normal', build: filesBlock },
  diffs: { rank: 0, size: 'normal', build: diffsBlock },
  tasks: { rank: 4, size: 'normal', build: tasksBlock },
  branches: { rank: 5, size: 'wide', build: branchesBlock },
  commits: { rank: 2, size: 'wide', build: commitsBlock },
  run: { rank: 1, size: 'normal', build: runsBlock },
  npm: { rank: 6, size: 'normal', build: npmBlock },
  agents: { rank: 7, size: 'normal', build: agentsBlock },
};

const TILES = DASH_TILES.map(({ id, key }) => {
  const title = id;
  const view = TILE_VIEW[id];
  return { id, key, title, ...view };
});

const TILE_BY_ID = Object.fromEntries(TILES.map((tile) => [tile.id, tile]));

const paintTiles = (model, bands, color) => {
  const painted = new Map();
  const context = { now: model.now, frame: model.frame };
  for (const band of bands) {
    for (const place of band.tiles) {
      const tile = TILE_BY_ID[place.id];
      const inner = Math.max(0, place.w - 2);
      const room = Math.max(0, band.h - 1);
      const content = tile.build(model, inner, room, context, tile);
      painted.set(place.id, paintTile(tile, content, place.w, band.h, color));
    }
  }
  return painted;
};

const paintBodyDashboard = (view, width, color, bodyH, headerLines) => {
  const model = view.dashboard;
  if (!model) {
    const blank = paintBodyFill(width, color, 'files');
    return paneResult({ body: new Array(bodyH).fill(blank) });
  }
  const margin = bodyH >= MARGIN_MIN_H ? 1 : 0;
  const height = bodyH - margin * 2;
  const bands = layoutTiles(width, height, TILES);
  const painted = paintTiles(model, bands, color);
  const rows = composeBands(bands, painted, width, height, color);
  const pad = new Array(margin).fill(pageFill(width, color));
  const body = pad.concat(rows, pad);
  const fileHits = tileHits(bands, headerLines + margin);
  return paneResult({ body, fileHits });
};

module.exports = {
  commitsBlock,
  branchesBlock,
  runMetrics,
  runsBlock,
  TILES,
  paintBodyDashboard,
};
