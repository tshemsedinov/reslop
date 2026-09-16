'use strict';

const READ_ONLY_ORIGINS = ['commit', 'pr'];

const isReadOnlyOrigin = (origin) => READ_ONLY_ORIGINS.includes(origin);

module.exports = { READ_ONLY_ORIGINS, isReadOnlyOrigin };
