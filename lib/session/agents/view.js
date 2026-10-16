'use strict';

const NO_PICK = {
  agentPick: '',
  agentMenu: null,
  agentQuery: '',
  agentEditor: null,
  agentMenuOff: [],
  agentPickCursor: 0,
  agentMenuScroll: 0,
};

const NO_LIST = {
  agents: null,
  agentField: 'agent',
  agentPlan: { name: '', status: '', progress: '' },
  agentTask: null,
  agentInstallCommand: '',
  agentInstallPackage: '',
  agentRuns: [],
  agentRunCursor: 0,
  agentRunScroll: 0,
  agentFocus: 'cli',
  agentCanStart: false,
  agentPlanCount: 0,
  agentView: false,
};

const NO_JOB = {
  agentOutput: '',
  agentCommand: '',
  agentElapsed: '',
  agentProgress: '',
  agentRunning: false,
  agentStatus: '',
};

module.exports = { NO_PICK, NO_LIST, NO_JOB };
