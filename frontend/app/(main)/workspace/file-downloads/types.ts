export type DownloadScope = 'file' | 'folder' | 'workspace';
export type ChainStatus = 'verified' | 'sealing' | 'mismatch';

/** One `workspace.downloaded` audit record: ids, counts and digests, never a path. */
export interface DownloadRecord {
  seq: number;
  at: string;
  userId: string | null;
  sessionId: string;
  scope: DownloadScope;
  revision: number;
  files: number;
  bytes: number;
  pathDigest: string | null;
  dataDigest: string;
  /** Absent: the deployment shows no standing on the chain. */
  chain?: ChainStatus;
}

export interface PersonRef {
  name: string;
  email: string;
}

export interface DownloadPage {
  items: DownloadRecord[];
  /** `null`: no longer a member of the org. */
  people: Record<string, PersonRef | null>;
  /** `null`: the chat was deleted. */
  chats: Record<string, { title: string } | null>;
  next: string | null;
}

export interface DownloadFilters {
  /** ISO date-times */
  from?: string;
  to?: string;
  /** For the date chip to show what was picked */
  dateType?: 'on' | 'between' | 'before' | 'after';
  userIds: string[];
  sessionIds: string[];
  /** Fingerprints of one path (as typed and normalized); the path itself stays in the browser. */
  pathDigests: string[];
}

export interface ChatOption {
  sessionId: string;
  title: string | null;
}
