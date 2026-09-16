'use strict';

const headerValue = (headers, name) => {
  if (!headers) return '';
  if (typeof headers.get === 'function') {
    return headers.get(name) || '';
  }
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    const value = headers[key];
    if (key.toLowerCase() === wanted) return `${value}`;
  }
  return '';
};

const parseLinkNext = (headers) => {
  const link = headerValue(headers, 'link');
  if (!link) return '';
  for (const part of link.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(part.trim());
    if (match) return match[1];
  }
  return '';
};

const parseNextPage = (headers, currentUrl) => {
  const fromLink = parseLinkNext(headers);
  if (fromLink) return fromLink;
  const page = headerValue(headers, 'x-next-page');
  if (!page) return '';
  const url = new URL(currentUrl);
  url.searchParams.set('page', page);
  return url.toString();
};

module.exports = { headerValue, parseLinkNext, parseNextPage };
