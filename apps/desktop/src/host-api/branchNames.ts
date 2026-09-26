/**
 * The branch names and folder names PiUI accepts for worktree chats. These
 * mirror the host's checks (`plain_branch_name`, `folder_slug`) so the new
 * chat dialog can explain a problem before asking the host; the host still
 * decides, and git checks the name again.
 */
export function plainBranchName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 100 &&
    /^[A-Za-z0-9._/-]+$/.test(name) &&
    !/^[-./]/.test(name) &&
    !/[/.]$/.test(name) &&
    !name.includes('..') &&
    !name.includes('//') &&
    name.split('/').every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'))
  );
}

/** Lowercase letters, digits and `-`, at most 48 characters; `chat` when empty. */
export function folderSlug(text: string): string {
  let slug = '';
  for (const character of text.toLowerCase()) {
    if (/[a-z0-9]/.test(character)) slug += character;
    else if (slug.length > 0 && !slug.endsWith('-')) slug += '-';
    if (slug.length >= 48) break;
  }
  slug = slug.replace(/^-+|-+$/g, '');
  return slug || 'chat';
}
