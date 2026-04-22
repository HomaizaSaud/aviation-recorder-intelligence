jest.mock(
  'react-router-dom',
  () => {
    const matchPath = ({ path, end = true }, pathname) => {
      if (!path) {
        return null;
      }

      const pathParts = path.split('/').filter(Boolean);
      const nameParts = pathname.split('/').filter(Boolean);

      if (end && pathParts.length !== nameParts.length) {
        return null;
      }

      if (!end && nameParts.length < pathParts.length) {
        return null;
      }

      const params = {};
      for (let i = 0; i < pathParts.length; i += 1) {
        const part = pathParts[i];
        const value = nameParts[i];
        if (!value) {
          return null;
        }
        if (part.startsWith(':')) {
          params[part.slice(1)] = value;
        } else if (part !== value) {
          return null;
        }
      }

      return { params };
    };

    return {
      Link: () => null,
      Outlet: () => null,
      matchPath,
      useLocation: () => ({ pathname: '/' }),
      useNavigate: () => () => {},
    };
  },
  { virtual: true },
);

import { isCasesNavActive, isModuleNavActive } from './AuthenticatedLayout';

describe('AuthenticatedLayout navigation matching', () => {
  test('cases nav matches only case routes', () => {
    expect(isCasesNavActive('/cases')).toBe(true);
    expect(isCasesNavActive('/cases/ABC-123')).toBe(true);
    expect(isCasesNavActive('/cases/fdr')).toBe(false);
    expect(isCasesNavActive('/cases/cvr')).toBe(false);
    expect(isCasesNavActive('/cases/correlate')).toBe(false);
    expect(isCasesNavActive('/cases/ABC-123/fdr')).toBe(false);
  });

  test('module nav matches module routes', () => {
    expect(isModuleNavActive('/cases/fdr', 'fdr')).toBe(true);
    expect(isModuleNavActive('/cases/123/fdr', 'fdr')).toBe(true);
    expect(isModuleNavActive('/cases/123/fdr/results', 'fdr')).toBe(true);
    expect(isModuleNavActive('/cases/fdr', 'cvr')).toBe(false);
    expect(isModuleNavActive('/cases/cvr', 'cvr')).toBe(true);
    expect(isModuleNavActive('/cases/456/cvr', 'cvr')).toBe(true);
    expect(isModuleNavActive('/cases/correlate', 'correlate')).toBe(true);
    expect(isModuleNavActive('/cases/789/correlate', 'correlate')).toBe(true);
  });
});
