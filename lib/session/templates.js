'use strict';

const review = require('../review.js');
const { rankedTemplates, prefixTemplates, TEMPLATE_SHOW } = review;

const shownTemplates = (api) => {
  const notes = api.review.store;
  if (!notes) return [];
  const { state } = api;
  if (state.composeKind && state.composeKind !== 'feedback') return [];
  const ranked = rankedTemplates(notes.templates);
  const editing = state.composeKind && state.editor;
  const typed = editing ? state.editor.text : '';
  const exact = ranked.some((entry) => entry.text === typed);
  if (exact) return [];
  const matched = prefixTemplates(ranked, typed);
  return matched.slice(0, TEMPLATE_SHOW);
};

const clampedTemplateIndex = (api, shown) => {
  if (!shown.length) return -1;
  if (api.state.templateIndex >= shown.length) return shown.length - 1;
  return api.state.templateIndex;
};

const clearTemplatePick = (api) => {
  api.state.templateIndex = -1;
  api.state.templateFocus = false;
};

const focusTemplate = (api, index, apply) => {
  const shown = shownTemplates(api);
  if (!shown.length) return;
  let i = index;
  if (i < 0) i = shown.length - 1;
  if (i >= shown.length) i = 0;
  api.state.templateIndex = i;
  api.state.templateFocus = true;
  if (apply) api.state.editor.replace(shown[i].text);
};

const selectTemplate = (api, index) => {
  const shown = shownTemplates(api);
  if (!shown.length) return null;
  focusTemplate(api, index, true);
  return api.save();
};

const applyTemplate = (api) => {
  if (api.state.composeKind !== 'feedback') return null;
  const index = api.state.templateFocus ? api.state.templateIndex : 0;
  return selectTemplate(api, index);
};

const createTemplatePick = (api) => ({
  shownTemplates: () => shownTemplates(api),
  clampedTemplateIndex: (shown) => clampedTemplateIndex(api, shown),
  clearTemplatePick: () => clearTemplatePick(api),
  focusTemplate: (index, apply) => focusTemplate(api, index, apply),
  applyTemplate: () => applyTemplate(api),
  selectTemplate: (index) => selectTemplate(api, index),
});

module.exports = { createTemplatePick };
