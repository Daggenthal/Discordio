import { Router } from "@decky/ui";

// Full-screen media viewer (images, GIFs, videos from a conversation).
// Backing out returns to the Quick Access Menu with the same conversation
// open at the same message.
export type ViewMedia = { kind: string; url?: string; poster?: string; name?: string };
type ViewState = { items: ViewMedia[]; index: number; returnTo: { conv: any; messageId: string } | null };

let state: ViewState | null = null;
export const viewerState = () => state;

export function openViewer(items: ViewMedia[], index: number, conv: any, messageId: string) {
  const usable = items.filter((m) => m.url && m.kind !== "file");
  if (!usable.length) return;
  state = { items: usable, index: Math.min(index, usable.length - 1), returnTo: { conv, messageId } };
  Router.Navigate("/discordio-view");
}

// Read once by the Messages section when it mounts again.
let restore: { conv: any; messageId: string } | null = null;
export const takeRestore = () => {
  const r = restore;
  restore = null;
  return r;
};
export const closeViewer = () => {
  restore = state?.returnTo ?? null;
  state = null;
};
