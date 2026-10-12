import type { Category } from './domain.js';
import type { FileUrls } from './file-urls.js';

/** What `profile_json(users)` in the database returns. */
export interface ProfileJson {
  id: string;
  display_name: string;
  badge: string | null;
  role: 'member' | 'admin';
  status: 'active' | 'suspended' | 'deleted';
  favorite_categories: Category[];
  avatar_hash: string | null;
  avatar_url: string | null;
  created_at: string;
}

/** The public profile: own avatar (signed) or the Google picture. Never the e-mail. */
export function toProfile(p: ProfileJson, urls: FileUrls) {
  return {
    id: p.id,
    display_name: p.display_name,
    badge: p.badge,
    role: p.role,
    status: p.status,
    favorite_categories: p.favorite_categories,
    avatar_url: p.avatar_hash ? urls.url(p.avatar_hash, 'thumb') : p.avatar_url,
    created_at: new Date(p.created_at).toISOString(),
  };
}
