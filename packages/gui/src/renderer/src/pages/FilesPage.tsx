import { FolderPanel } from '@/components/FolderPanel';

/**
 * Mobile 「文件」page (§ revised nav model) — the folder tree as a full-screen
 * page, replacing the old left drawer. Single-tap opens a note → `/note/:id`
 * (via the folder panel's `page` variant + `useOpenNote`). Desktop keeps its
 * folder tree in the sidebar and never routes here.
 */
export function FilesPage() {
  return <FolderPanel variant="page" />;
}
