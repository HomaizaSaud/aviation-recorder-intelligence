const DEFAULT_SLUG = 'item';

const slugify = (value) => {
  if (value === undefined || value === null) {
    return DEFAULT_SLUG;
  }

  const normalized = String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();

  return normalized || DEFAULT_SLUG;
};

module.exports = slugify;