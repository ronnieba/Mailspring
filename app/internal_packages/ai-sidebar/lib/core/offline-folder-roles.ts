/**
 * Offline experiment: which top-level folders are mail "system boxes"
 * (Inbox, Sent, Drafts, Archive, Bulk/Spam, Trash), so the folder tree can
 * give them their own icon. Names only; nothing is read from the mail.
 */
export type OfflineFolderRole = 'inbox' | 'sent' | 'drafts' | 'archive' | 'spam' | 'trash';

const ROLE_NAMES: { [role in OfflineFolderRole]: string[] } = {
  inbox: ['inbox', 'דואר נכנס'],
  sent: ['sent', 'sent items', 'sent mail', 'sent messages', 'נשלחו', 'פריטים שנשלחו', 'דואר יוצא'],
  drafts: ['draft', 'drafts', 'טיוטות'],
  archive: ['archive', 'archives', 'ארכיון'],
  spam: [
    'bulk',
    'bulk mail',
    'spam',
    'junk',
    'junk mail',
    'junk e-mail',
    'junk email',
    'דואר זבל',
    'ספאם',
  ],
  trash: [
    'trash',
    'deleted',
    'deleted items',
    'deleted messages',
    'bin',
    'אשפה',
    'פח אשפה',
    'פריטים שנמחקו',
  ],
};

const BY_NAME = new Map<string, OfflineFolderRole>();
for (const role of Object.keys(ROLE_NAMES) as OfflineFolderRole[]) {
  for (const n of ROLE_NAMES[role]) {
    BY_NAME.set(n, role);
  }
}

/** System role of a folder, or null. Only top-level folders count. */
export function offlineFolderRole(name: string, depth: number): OfflineFolderRole | null {
  if (depth !== 0 || typeof name !== 'string') {
    return null;
  }
  return BY_NAME.get(name.trim().toLowerCase()) || null;
}

export type OfflineFolderIconKind =
  | OfflineFolderRole
  | 'folder'
  | 'folder-open'
  | 'folder-leaf'
  | 'local-drafts';

/** Icon for a tree row: system box, open/closed parent folder, or plain leaf. */
export function offlineFolderIconKind(opts: {
  name: string;
  depth: number;
  hasChildren: boolean;
  open: boolean;
}): OfflineFolderIconKind {
  const role = offlineFolderRole(opts.name, opts.depth);
  if (role) {
    return role;
  }
  if (!opts.hasChildren) {
    return 'folder-leaf';
  }
  return opts.open ? 'folder-open' : 'folder';
}
