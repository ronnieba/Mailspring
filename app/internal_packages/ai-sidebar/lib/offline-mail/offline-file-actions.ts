/**
 * Offline experiment: open / save / pick files for attachments.
 * Opening uses the default Windows (or Mac) app for the file type. The
 * dialogs and the opener can be swapped out by tests so nothing pops up.
 * No network.
 */
import fs from 'fs';
import { isProtectedArchivePath, markFromInternet } from '../core/offline-attachments';

type Opener = (file: string) => Promise<string>;
type SaveChooser = (defaultName: string) => Promise<string | null>;
type OpenChooser = () => Promise<string[]>;

let opener: Opener = (file) => require('electron').shell.openPath(file);
let saveChooser: SaveChooser = (defaultName) =>
  new Promise((resolve) => {
    AppEnv.showSaveDialog({ defaultPath: defaultName }, (p: string) => resolve(p || null));
  });
let openChooser: OpenChooser = () =>
  new Promise((resolve) => {
    AppEnv.showOpenDialog({ properties: ['openFile', 'multiSelections'] }, (paths: string[]) =>
      resolve(paths || [])
    );
  });

/** Test hook: replace the opener and dialogs. */
export function setOfflineFileActions(o: {
  opener?: Opener;
  saveChooser?: SaveChooser;
  openChooser?: OpenChooser;
}) {
  if (o.opener) opener = o.opener;
  if (o.saveChooser) saveChooser = o.saveChooser;
  if (o.openChooser) openChooser = o.openChooser;
}

/** Open with the system's default app. Resolves to '' or an error message. */
export async function openWithDefaultApp(file: string): Promise<string> {
  try {
    return (await opener(file)) || '';
  } catch (err) {
    return String((err as Error).message || err);
  }
}

/** Ask where to save, then write. Resolves to the saved path, null (cancelled) or throws. */
export async function saveBytesAs(
  defaultName: string,
  data: Buffer,
  archiveRoot: string | null
): Promise<string | null> {
  const dest = await saveChooser(defaultName);
  if (!dest) {
    return null;
  }
  if (isProtectedArchivePath(dest, archiveRoot)) {
    throw new Error('protected-archive');
  }
  fs.writeFileSync(dest, data);
  markFromInternet(dest);
  return dest;
}

export function chooseFilesToAttach(): Promise<string[]> {
  return openChooser();
}
