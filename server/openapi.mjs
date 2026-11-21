// OpenAPI：schema/security 基座在 openapi.base.json，paths 由下面的路由元数据生成。
// 修改接口时：先改这里的 routeMeta，再 npm run openapi。
import { readFileSync } from 'node:fs';

const base = JSON.parse(readFileSync(new URL('../openapi.base.json', import.meta.url), 'utf8'));

const ref = n => ({ $ref: `#/components/schemas/${n}` });
const err = n => ({ $ref: `#/components/responses/${n}` });
const ok = schema => ({ description: 'OK', content: { 'application/json': { schema } } });
const errors = (...names) => Object.fromEntries(names.map(n => [n, err(n)]));
const scopes = s => [{ oauth2AuthCode: s }, { oauth2ClientCredentials: s }];
const adminSec = [{ adminToken: [] }];
const bearerSec = [{ bearerAuth: [] }];
const q = (name, schema, extra = {}) => ({ name, in: 'query', required: false, schema, ...extra });

const dataOp = ({ summary, schema, scopes: sc = ['jwxt.read'], parameters = [], description }) => ({
  tags: ['JWXT'],
  summary,
  ...(description ? { description } : {}),
  security: scopes(sc),
  ...(parameters.length ? { parameters } : {}),
  responses: {
    200: ok(ref(schema)),
    ...errors('Unauthorized', 'Forbidden', 'UpstreamError', 'Unavailable'),
  },
});

const paths = {
  '/': {
    get: {
      tags: ['Meta'],
      summary: '服务信息',
      security: [],
      responses: { 200: ok({ type: 'object', additionalProperties: true }) },
    },
  },

  '/healthz': {
    get: {
      tags: ['Meta'],
      summary: '健康检查',
      security: [],
      responses: { 200: ok(ref('Health')) },
    },
  },

  '/openapi.json': {
    get: {
      tags: ['Meta'],
      summary: '本 OpenAPI 文档',
      security: [],
      responses: { 200: ok({ type: 'object', additionalProperties: true }) },
    },
  },

  '/.well-known/oauth-authorization-server': {
    get: {
      tags: ['Meta'],
      summary: 'OAuth2 Authorization Server Metadata',
      security: [],
      responses: { 200: ok(ref('OAuthMetadata')) },
    },
  },

  '/oauth/authorize': {
    get: {
      tags: ['OAuth'],
      summary: '授权端点（Authorization Code + PKCE）',
      description: '单账号模式：不弹确认页，直接 302 回 redirect_uri 并附带 code。公开客户端必须使用 PKCE S256。',
      security: [],
      parameters: [
        { name: 'response_type', in: 'query', required: true, schema: { type: 'string', enum: ['code'] } },
        { name: 'client_id', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'redirect_uri', in: 'query', required: true, schema: { type: 'string', format: 'uri' } },
        q('scope', { type: 'string' }, { example: 'jwxt.read offline_access' }),
        q('state', { type: 'string' }),
        q('code_challenge', { type: 'string' }),
        q('code_challenge_method', { type: 'string', enum: ['S256'] }),
      ],
      responses: {
        302: {
          description: '重定向回 redirect_uri，query 含 code 和原 state',
          headers: { Location: { schema: { type: 'string', format: 'uri' } } },
        },
        ...errors('BadRequest', 'Unavailable'),
      },
    },
  },

  '/oauth/token': {
    post: {
      tags: ['OAuth'],
      summary: '令牌端点',
      description: '支持 authorization_code、refresh_token、client_credentials。客户端认证可用 HTTP Basic 或表单 client_id/client_secret；公开客户端只能放在表单里。',
      security: [],
      requestBody: {
        required: true,
        content: { 'application/x-www-form-urlencoded': { schema: ref('TokenRequest') } },
      },
      responses: {
        200: ok(ref('TokenResponse')),
        ...errors('BadRequest', 'Unauthorized', 'RateLimited'),
      },
    },
  },

  '/oauth/revoke': {
    post: {
      tags: ['OAuth'],
      summary: '撤销 access/refresh token',
      security: [],
      requestBody: {
        required: true,
        content: {
          'application/x-www-form-urlencoded': {
            schema: {
              type: 'object',
              required: ['token'],
              properties: {
                token: { type: 'string' },
                token_type_hint: { type: 'string', enum: ['access_token', 'refresh_token'] },
                client_id: { type: 'string' },
                client_secret: { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        200: ok(ref('RevokeResult')),
        ...errors('Unauthorized', 'RateLimited'),
      },
    },
  },

  '/oauth/userinfo': {
    get: {
      tags: ['OAuth'],
      summary: '当前令牌对应的用户',
      security: bearerSec,
      responses: { 200: ok(ref('UserInfo')), ...errors('Unauthorized') },
    },
  },

  '/api/me': {
    get: {
      tags: ['JWXT'],
      summary: '当前令牌信息',
      security: bearerSec,
      responses: { 200: ok(ref('MeResponse')), ...errors('Unauthorized') },
    },
  },

  '/api/profile': {
    get: dataOp({ summary: '学籍基本信息（含 PII）', schema: 'ProfileResponse', scopes: ['jwxt.profile'] }),
  },

  '/api/semesters': {
    get: dataOp({ summary: '学期列表', schema: 'SemestersResponse' }),
  },

  '/api/week-range': {
    get: dataOp({
      summary: '该学期的教学周范围',
      schema: 'WeekRangeResponse',
      parameters: [q('semester', { type: 'string' }, { example: '2026-2027-1' })],
    }),
  },

  '/api/timetable': {
    get: dataOp({
      summary: '课表',
      schema: 'TimetableResponse',
      parameters: [
        q('semester', { type: 'string' }, { example: '2026-2027-1' }),
        q('week', { type: 'integer', minimum: 1, maximum: 30 }),
      ],
    }),
  },

  '/api/grades': {
    get: dataOp({
      summary: '成绩',
      schema: 'GradesResponse',
      parameters: [q('semester', { type: 'string' }, { example: '2026-2027-1' })],
    }),
  },

  '/api/exams': {
    get: dataOp({
      summary: '考试安排（期末 + 结课）',
      schema: 'ExamsResponse',
      parameters: [q('semester', { type: 'string' }, { example: '2026-2027-1' })],
    }),
  },

  '/api/textbooks': {
    get: dataOp({ summary: '教材', schema: 'TextbooksResponse' }),
  },

  '/api/courses/plan': {
    get: dataOp({ summary: '培养方案课程清单', schema: 'PlanCoursesResponse' }),
  },

  '/api/messages': {
    get: dataOp({ summary: '消息通知', schema: 'MessagesResponse' }),
  },

  '/api/notices': {
    get: dataOp({ summary: '公告', schema: 'MessagesResponse' }),
  },

  '/admin/account': {
    get: {
      tags: ['Admin'],
      summary: '查看已保存的教务账号（不含密码）',
      security: adminSec,
      responses: { 200: ok(ref('AccountInfo')), ...errors('Unauthorized') },
    },
    put: {
      tags: ['Admin'],
      summary: '设置/更新教务账号（加密存储）',
      security: adminSec,
      requestBody: {
        required: true,
        content: { 'application/json': { schema: ref('AccountUpdate') } },
      },
      responses: {
        200: ok(ref('AccountUpdateResult')),
        ...errors('BadRequest', 'Unauthorized', 'RateLimited'),
      },
    },
  },

  '/admin/clients': {
    get: {
      tags: ['Admin'],
      summary: '客户端列表',
      security: adminSec,
      responses: {
        200: ok({ type: 'array', items: ref('Client') }),
        ...errors('Unauthorized'),
      },
    },
    post: {
      tags: ['Admin'],
      summary: '注册客户端',
      description: '返回的 client_secret 只显示一次。public=true 表示公开客户端，此时不返回 secret，且授权时必须用 PKCE。',
      security: adminSec,
      requestBody: {
        required: true,
        content: { 'application/json': { schema: ref('ClientCreate') } },
      },
      responses: {
        200: ok(ref('ClientCreated')),
        ...errors('BadRequest', 'Unauthorized', 'RateLimited'),
      },
    },
  },

  '/admin/clients/{clientId}': {
    delete: {
      tags: ['Admin'],
      summary: '删除客户端',
      security: adminSec,
      parameters: [{ name: 'clientId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: ok(ref('RevokeResult')),
        ...errors('Unauthorized', 'NotFound'),
      },
    },
  },
};

export function buildOpenApi(issuer = 'http://localhost:8787') {
  const spec = structuredClone(base);
  spec.servers = [{ url: issuer, description: '当前部署地址' }];
  spec.paths = structuredClone(paths);

  const schemes = spec.components.securitySchemes;
  const tokenUrl = `${issuer}/oauth/token`;
  const auth = schemes.oauth2AuthCode.flows.authorizationCode;
  auth.authorizationUrl = `${issuer}/oauth/authorize`;
  auth.tokenUrl = tokenUrl;
  auth.refreshUrl = tokenUrl;
  schemes.oauth2ClientCredentials.flows.clientCredentials.tokenUrl = tokenUrl;

  return spec;
}

export const routeKeys = Object.entries(paths).flatMap(([path, ops]) =>
  Object.keys(ops).map(method => `${method.toUpperCase()} ${path}`));
