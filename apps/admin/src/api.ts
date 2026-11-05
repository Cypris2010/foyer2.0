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
  soundAllowed: boolean;
  orientation: 'landscape' | 'portrait';
  networks: string;
  lastSeenAt: number | null;
  status: { version: string | null; slideId: string | null; errors: string[]; screen?: string; ip?: string } | null;
  state: 'online' | 'offline' | 'never' | 'checking';
  currentSlideTitle: string | null;
  /** The one device currently holding this display. */
  device: { ip: string; since: number } | null;
  /** "wall": a grid of displays showing one picture; it has no device itself. */
  kind: 'screen' | 'wall';
  wall: { rows: number; cols: number; bezel: number; screens: number; online: number } | null;
  /** Set while this display is part of a wall. */
  wallId: string | null;
  wallRow: number | null;
  wallCol: number | null;
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

export type Background =
  | { kind: 'color'; value: string }
  | { kind: 'image'; mediaId: string; fit: 'cover' | 'contain'; dim: number }
  | { kind: 'video'; mediaId: string; dim: number };

export interface Slide {
  id: string;
  title: string;
  type: string;
  config: Record<string, unknown>;
  background: Background | null;
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
  widget?: 'textarea' | 'code' | 'select' | 'media' | 'options' | 'qr-art';
  language?: string;
  /** widget "media": which kind may be chosen. */
  accept?: 'image' | 'video';
  /** widget "options": name of the slide type's server option list. */
  options?: string;
  /** enum: readable labels per value. */
  labels?: Record<string, string>;
  /** type "array": item schema. */
  items?: JsonSchemaProperty;
}

export interface Option {
  value: string;
  label: string;
}

export interface SlideType {
  id: string;
  name: string;
  description: string;
  category: string;
  backgrounds: Array<'color' | 'image' | 'video'> | false;
  /** The slide lasts as long as the media in this config field unless a duration is set. */
  durationFromMedia: string | null;
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

export type MediaKind = 'image' | 'video';

export interface MediaItem {
  id: string;
  name: string;
  kind: MediaKind;
  status: 'queued' | 'processing' | 'ready' | 'failed';
  error: string | null;
  /** 0..1 while processing. */
  progress: number | null;
  size: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  url: string | null;
  poster: string | null;
  thumb: string | null;
  variants: Record<string, { url: string; width: number; height: number }>;
  createdAt: number;
  usageCount: number;
  /** Detail view only. */
  usage?: Array<{ id: string; title: string }>;
}

/**
 * Uploads one file as raw request body (XHR for upload progress; fetch has none).
 * Resolves with the stored item; `existing` when the same file was there already.
 */
export function uploadMedia(file: File, onProgress: (fraction: number) => void): Promise<MediaItem & { existing: boolean }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/media?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data: any = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // keep the status message below
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data.error ?? `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('Upload abgebrochen (Netzwerkfehler)'));
    xhr.send(file);
  });
}

export const formatBytes = (bytes: number) =>
  bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(1)} GB` : bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export const formatDuration = (seconds: number) => {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
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
