export type Role = 'admin' | 'editor' | 'viewer';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface Display {
  id: string;
  name: string;
  defaultChannelId: string | null;
  showProgress: boolean;
  orientation: 'landscape' | 'portrait';
  networks: string;
  lastSeenAt: number | null;
  status: { version: string | null; slideId: string | null; errors: string[]; screen?: string; ip?: string } | null;
  state: 'online' | 'offline' | 'never' | 'checking';
  currentSlideTitle: string | null;
  /** The one device currently holding this display. */
  device: { ip: string; since: number } | null;
}

export interface Channel {
  id: string;
  name: string;
  transition: 'fade' | 'slide' | 'none';
  defaultDuration: number;
  isFavorite: boolean;
  published: boolean;
  slideCount?: number;
  slides?: Array<{ slideId: string }>;
}

export interface Slide {
  id: string;
  title: string;
  type: string;
  config: Record<string, unknown>;
  duration: number | null;
  published: boolean;
  updatedAt: number;
}

export interface JsonSchemaProperty {
  type?: string;
  enum?: string[];
  anyOf?: JsonSchemaProperty[];
  default?: unknown;
  description?: string;
  maxLength?: number;
  format?: string;
  widget?: 'textarea' | 'code' | 'select';
  language?: string;
}

export interface SlideType {
  id: string;
  name: string;
  description: string;
  category: string;
  editRole: Role;
  schema: { properties: Record<string, JsonSchemaProperty> };
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const issues = Array.isArray(data.issues) ? `: ${data.issues.map((i: any) => `${i.path?.join('.')} ${i.message}`).join(', ')}` : '';
    throw new ApiError(res.status, `${data.error ?? `HTTP ${res.status}`}${issues}`);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

export const roleRank: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };
export const can = (user: User, role: Role) => roleRank[user.role] >= roleRank[role];

/** One calendar entry (single, open-ended or series). Times are school wall time "YYYY-MM-DDTHH:mm". */
export interface Schedule {
  id: string;
  scope: 'display' | 'channel';
  channelId: string | null;
  contentKind: 'channel' | 'slide';
  contentId: string;
  title: string;
  displayIds: string[];
  start: string;
  end: string | null;
  rrule: string | null;
  exclusive: boolean;
}

/** A concrete occurrence of a schedule, as listed for the calendar view. */
export interface ScheduleOccurrence extends Schedule {
  occId: string;
  occStart: string;
  occEnd: string | null;
  /** Overlaps another channel on a shared display: both are coupled. */
  overlaps: boolean;
}

export type ScheduleInput = Omit<Schedule, 'id' | 'title'>;
