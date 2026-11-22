export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** Unix ms */
  expiresAt: number;
  scope: string;
}

export interface TokenStorage {
  get?(key: string): TokenSet | null | Promise<TokenSet | null>;
  set?(key: string, value: TokenSet | null): void | Promise<void>;
  delete?(key: string): void | Promise<void>;
}

export interface JwxtOAuthClientOptions {
  baseUrl: string;
  clientId: string;
  clientSecret?: string | null;
  redirectUri?: string | null;
  fetch?: typeof fetch;
  storage?: TokenStorage | null;
  tokens?: TokenSet | null;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export interface UserInfo {
  sub: string;
  account: string;
  client_id: string;
  scopes: string[];
}

export interface StudentProfile {
  studentId: string | null;
  name: string | null;
  gender: string | null;
  college: string | null;
  major: string | null;
  className: string | null;
  grade: string | null;
}

export interface Semester {
  value: string;
  label: string;
  selected: boolean;
}

export interface WeekRange {
  qszc: number;
  jszc: number;
}

export interface TimetableItem {
  day: number;
  period: string;
  name: string;
  teacher: string;
  timeText: string;
  weeks: string;
  periods: string;
  location: string;
  courseCode: string;
  className: string;
  students: string;
  examType: string;
  hours: string;
  rawHtml: string;
  rawText: string;
}

export interface GradeItem {
  xnxqid?: string;
  kch?: string;
  kc_mc?: string;
  ksdw?: string;
  zcjstr?: string;
  zcj?: string;
  kz?: string;
  jx0404id?: string;
  xs0101id?: string;
  cj0708id?: string;
  [key: string]: unknown;
}

export interface GradesResult {
  code: number | string;
  count: number | string;
  data: GradeItem[];
  meta: { tjsj?: string; pjxfjdts?: string };
}

export interface ExamItem {
  xnxq01id?: string;
  kch?: string;
  kc_mc?: string;
  kszc?: string;
  ksxq?: string;
  ksjc?: string;
  js_mc?: string;
  ks_mc?: string;
  kssj?: string;
  ksxxsj?: string;
  jkls?: string;
  rownum_?: number;
  [key: string]: unknown;
}

export interface ExamsResult {
  final: ExamItem[];
  courseEnd: ExamItem[];
}

export interface Textbook {
  xnxq01id?: string;
  kch?: string;
  kcmc?: string;
  jcmc?: string;
  jczz?: string;
  cbsmc?: string;
  isbn?: string;
  dmmc?: string;
  dgcs?: number;
  [key: string]: unknown;
}

export interface PlanCourse {
  zdjxjhxqid?: string;
  kch?: string;
  kcmc?: string;
  xf?: number;
  kkxq?: string;
  rownum_?: number;
}

export interface MessageItem {
  [key: string]: unknown;
}

export interface MessageResult {
  count: number;
  data: MessageItem[];
}

export declare class JwxtError extends Error {
  status: number;
  error: string;
  description: string;
  constructor(status: number, error: string, description?: string);
}

export declare class JwxtOAuthClient {
  baseUrl: string;
  clientId: string;
  clientSecret: string | null;
  redirectUri: string | null;
  tokens: TokenSet | null;

  constructor(options: JwxtOAuthClientOptions);

  static createPkce(): Promise<PkcePair>;

  authorizationUrl(options?: {
    scopes?: string[] | string;
    state?: string;
    codeChallenge?: string;
    codeChallengeMethod?: 'S256';
    redirectUri?: string;
    extraParams?: Record<string, string | number | undefined | null>;
  }): string;

  clientCredentials(options?: { scopes?: string[] | string }): Promise<TokenSet>;
  exchangeCode(options: {
    code: string;
    codeVerifier?: string;
    redirectUri?: string;
  }): Promise<TokenSet>;
  refresh(): Promise<TokenSet>;
  revoke(options?: { token?: string; tokenType?: 'access_token' | 'refresh_token' }): Promise<void>;
  ensureAccessToken(): Promise<string>;

  load(): Promise<TokenSet | null>;
  save(): Promise<void>;

  api<T = unknown>(path: string, options?: {
    query?: Record<string, string | number | undefined | null>;
    method?: string;
    body?: unknown;
    retry?: boolean;
  }): Promise<T>;

  me(): Promise<UserInfo>;
  profile(): Promise<StudentProfile>;
  semesters(): Promise<Semester[]>;
  weekRange(options?: { semester?: string }): Promise<WeekRange>;
  timetable(options?: { semester?: string; week?: number | string }): Promise<TimetableItem[]>;
  grades(options?: { semester?: string }): Promise<GradesResult>;
  exams(options?: { semester?: string }): Promise<ExamsResult>;
  textbooks(): Promise<Textbook[]>;
  planCourses(): Promise<PlanCourse[]>;
  messages(): Promise<MessageResult>;
  notices(): Promise<MessageResult>;
}

export default JwxtOAuthClient;
