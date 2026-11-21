import { jwxt } from './jwxt-service.mjs';

export class ApiError extends Error {
  constructor(status, error, description = '', headers = {}) {
    super(description || error);
    this.status = status;
    this.error = error;
    this.headers = headers;
  }
}

const requireScope = (auth, scope) => {
  if (!auth.scopes.includes(scope)) {
    throw new ApiError(403, 'insufficient_scope', `scope required: ${scope}`, {
      'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${scope}"`,
    });
  }
};

export const handlers = {
  me: async ({ auth }) => ({
    sub: String(auth.user.id),
    account: auth.user.account,
    client_id: auth.client.client_id,
    scopes: auth.scopes,
  }),

  profile: async ({ auth }) => {
    requireScope(auth, 'jwxt.profile');
    return jwxt.profile(auth.user);
  },

  semesters: async ({ auth }) => {
    requireScope(auth, 'jwxt.read');
    return jwxt.semesters(auth.user);
  },

  weekRange: async ({ auth, query }) => {
    requireScope(auth, 'jwxt.read');
    return jwxt.weekRange(auth.user, query.get('semester') || '');
  },

  timetable: async ({ auth, query }) => {
    requireScope(auth, 'jwxt.read');
    return jwxt.timetable(auth.user, {
      semester: query.get('semester') || undefined,
      week: query.get('week') || undefined,
    });
  },

  grades: async ({ auth, query }) => {
    requireScope(auth, 'jwxt.read');
    return jwxt.grades(auth.user, { semester: query.get('semester') || '' });
  },

  exams: async ({ auth, query }) => {
    requireScope(auth, 'jwxt.read');
    return jwxt.exams(auth.user, { semester: query.get('semester') || '' });
  },

  textbooks: async ({ auth }) => {
    requireScope(auth, 'jwxt.read');
    return jwxt.textbooks(auth.user);
  },

  planCourses: async ({ auth }) => {
    requireScope(auth, 'jwxt.read');
    return jwxt.planCourses(auth.user);
  },

  messages: async ({ auth }) => {
    requireScope(auth, 'jwxt.read');
    return jwxt.messages(auth.user);
  },

  notices: async ({ auth }) => {
    requireScope(auth, 'jwxt.read');
    return jwxt.notices(auth.user);
  },
};
