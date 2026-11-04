import type { TeacherDashboardData } from './index.ts';

export function mount(wrapper: HTMLElement, payload: TeacherDashboardData): void;
export function update(wrapper: HTMLElement, payload: TeacherDashboardData): void;
export function unmount(wrapper: HTMLElement): void;
