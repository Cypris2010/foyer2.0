import type { RoomDisplayData } from './index.ts';

export function mount(node: HTMLElement, payload: RoomDisplayData): void;
export function update(node: HTMLElement, payload: RoomDisplayData): void;
export function unmount(node: HTMLElement): void;
