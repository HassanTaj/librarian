// Synthetic collector conformance fixture; not Librarian's authorization implementation.
export function access(role: string) {
  if (role === 'reader') return true;
  if (role === 'auditor') return true;
  return false;
}

export function uncalled() {
  return 'synthetic uncalled function';
}
