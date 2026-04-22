export const createTimelineEntry = ({
  kind,
  action,
  actor,
  timestamp,
  metadata = [],
  links = {},
  ...rest
}) => ({
  id: `${kind || 'event'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  kind,
  action,
  actor,
  timestamp: timestamp || new Date().toISOString(),
  metadata,
  links,
  ...rest,
});

export const resolveActorLabel = (actor) => {
  if (!actor) {
    return '';
  }

  if (typeof actor === 'string') {
    return actor;
  }

  if (typeof actor === 'object') {
    return actor.name || actor.email || actor.id || '';
  }

  return '';
};

export const resolveActor = ({ user, fallback }) => {
  if (user) {
    const nameParts = [user.firstName, user.lastName].filter(Boolean);
    const name = nameParts.join(' ').trim();
    return {
      id: user.id,
      name: name || user.name || user.email || 'Unknown',
      email: user.email || '',
    };
  }

  if (fallback) {
    return typeof fallback === 'string' ? { name: fallback } : fallback;
  }

  return { name: 'Unknown' };
};
