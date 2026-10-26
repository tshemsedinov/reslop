'use strict';

const isMultiselect = (view) =>
  view.multiselect ?? view.listSelection?.length > 1;

const viewedCommit = (entry, rev, revShort) => {
  if (entry.pending) return !rev && !revShort;
  const ids = [rev, revShort].filter(Boolean);
  return ids.some((id) => entry.sha === id || entry.shortSha === id);
};

const selectableRow = (pane, entry, view) => {
  if (!entry) return false;
  if (pane === 'branches') return !entry.current;
  if (pane === 'commits') return !viewedCommit(entry, view.rev, view.revShort);
  return true;
};

module.exports = { isMultiselect, viewedCommit, selectableRow };
